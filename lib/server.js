'use strict';

const http = require('node:http');
const https = require('node:https');

const metautil = require('metautil');
const { Emitter, jsonParse, parseParams, split } = metautil;
const { isError, generateUUID } = metautil;

const transport = require('./transport.js');
const { buildHeaders, allTransports } = transport;
const { MetaReadable, MetaWritable } = require('./streams.js');
const { chunkDecode } = require('./chunks-node.js');
const { getPathname } = require('./websocket/server.js');

const BIND_RETRY_TIMEOUT_MS = 500;
const DEFAULT_LISTEN_RETRY = 3;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const sessions = new Map();

// Body over the limit is not buffered, null is returned instead
const readBody = async (req, limitBytes) => {
  const length = Number(req.headers['content-length']);
  if (length > limitBytes) return null;
  const chunks = [];
  let sizeBytes = 0;
  for await (const chunk of req) {
    sizeBytes += chunk.length;
    if (sizeBytes > limitBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const isMetacomWebSocketPath = (url) => {
  const pathname = getPathname(url);
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  return pathname === '/' || isApi;
};

// No 'get' trap: reads go straight to the target at native speed,
// only writes are intercepted to persist the session state
const createProxy = (data, save) => {
  const set = (target, key, value) => {
    const success = Reflect.set(target, key, value);
    if (save) save(target);
    return success;
  };
  return new Proxy(data, { set });
};

const invokeMethod = async (client, proc, args) => {
  const context = client.createContext();
  try {
    return await proc.invoke(context, args);
  } finally {
    proc.leave();
  }
};

const handleStream = async (client, packet) => {
  const { id, name, size, status } = packet;
  const tag = `${id}/${name}`;
  try {
    const stream = client.streams.get(id);
    if (status) {
      if (!stream) throw new Error(`Stream ${tag} is not initialized`);
      try {
        if (status === 'end') await stream.close();
        if (status === 'terminate') await stream.terminate();
      } finally {
        client.streams.delete(id);
      }
      return;
    }
    const valid = typeof name === 'string' && Number.isSafeInteger(size);
    if (!valid) throw new Error('Stream packet structure error');
    if (stream) throw new Error(`Stream ${tag} is already initialized`);
    client.streams.set(id, new MetaReadable(id, name, size));
  } catch (error) {
    client.error(400, { id, error });
  }
};

const handleBinary = async (client, data) => {
  const { id, payload } = chunkDecode(data);
  const upstream = client.streams.get(id);
  if (!upstream) {
    const error = new Error(`Stream ${id} is not initialized`);
    return void client.error(400, { id, error });
  }
  try {
    await upstream.push(payload);
  } catch (error) {
    client.error(400, { id, error });
  }
};

const handleRpc = async (client, packet, context) => {
  const { id, method, args } = packet;
  const route = method.split('/');
  const unitName = route[0];
  const methodName = route[1];
  const unitParts = unitName.split('.');
  const unit = unitParts[0];
  const version = unitParts[1] ?? '*';
  const proc = context.getMethod(unit, version, methodName);
  if (!proc) return void client.error(404, { id });
  if (!client.session && proc.access !== 'public') {
    return void client.error(403, { id });
  }
  try {
    await proc.enter();
  } catch (error) {
    return void client.error(503, { id, error });
  }
  try {
    const result = await invokeMethod(client, proc, args);
    if (isError(result)) {
      const { code } = result;
      return void client.error(code, { id, error: result });
    }
    client.send({ type: 'callback', id, result }, { method });
  } catch (error) {
    let code = error.code === 'ETIMEOUT' ? 408 : 500;
    if (typeof error.code === 'number') code = error.code;
    return void client.error(code, { id, error });
  }
};

class Session {
  constructor(token, data, context) {
    this.token = token;
    const { console, auth } = context;
    const save = (state) => {
      auth.saveSession(token, state).catch((error) => {
        console.error(error);
      });
    };
    this.state = createProxy(data, save);
  }
}

class Context {
  constructor(client) {
    this.client = client;
    this.uuid = generateUUID();
    this.state = {};
    this.session = client?.session ?? null;
  }
}

class Client extends Emitter {
  #transport = null;
  #capabilities = null;
  #context = null;
  #generateId = generateUUID;

  constructor(transport, context, options = {}) {
    super();
    const { generateId } = options;
    if (generateId) this.#generateId = generateId;
    this.#transport = transport;
    this.#capabilities = transport.constructor.capabilities;
    this.#context = context;
    this.source = transport.source;
    this.session = null;
    this.streams = new Map();
  }

  error(code, { id = '', error = null } = {}) {
    const status = http.STATUS_CODES[code];
    const info = error ? error.stack : status || 'Unknown error';
    this.#transport.error(code, { id, error });
    this.#context.console.error(`${this.source}\t${code}\t${info}`);
  }

  send(obj, options = {}) {
    const { code, method } = options;
    this.#transport.send(obj, code);
    const isSuccessCallback = obj.type === 'callback' && !obj.error;
    if (!isSuccessCallback) return;
    this.#context.console.log(`${this.source}\tCALL\t${method}\tOK`);
  }

  createContext() {
    return new Context(this);
  }

  emit(name, data) {
    if (name === 'close') return void super.emit(name, data);
    this.sendEvent(name, data);
  }

  sendEvent(name, data) {
    const packet = { type: 'event', name, data };
    if (!this.#capabilities?.events) {
      throw new Error(`Can't send metacom event to http transport`);
    }
    this.send(packet);
  }

  getStream(id) {
    if (!this.#capabilities?.streams) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  // Receiver may create stream id and pass it in call args
  createStream(name, size, id = this.#generateId()) {
    if (!this.#capabilities?.streams) {
      throw new Error(`Can't send metacom streams to http transport`);
    }
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} is already initialized`);
    }
    const stream = new MetaWritable(id, name, size, this.#transport);
    this.streams.set(id, stream);
    return stream;
  }

  initializeSession(token, data = {}) {
    this.finalizeSession();
    this.session = new Session(token, data, this.#context);
    sessions.set(token, this.session);
    return true;
  }

  finalizeSession() {
    if (!this.session) return false;
    sessions.delete(this.session.token);
    this.session = null;
    return true;
  }

  startSession(token, data = {}) {
    this.initializeSession(token, data);
    this.#transport.sendSessionCookie(token);
    return true;
  }

  restoreSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    this.session = session;
    return true;
  }

  close() {
    this.#transport.close();
  }

  destroy() {
    const { console } = this.#context;
    this.emit('close');
    for (const stream of this.streams.values()) {
      Promise.resolve(stream.terminate()).catch((error) => {
        console.error(error);
      });
    }
    this.streams.clear();
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

class Server extends Emitter {
  #clients = new Set();
  #context = null;
  #options = null;
  httpServer = null;
  wsServer = null;

  constructor(context, options) {
    super();
    this.#context = context;
    this.#options = options;
    this.#init();
  }

  #addClient(transport) {
    const client = new Client(transport, this.#context, this.#options);
    this.#clients.add(client);
    transport.once('close', () => {
      client.destroy();
      this.#clients.delete(client);
    });
    return client;
  }

  #init() {
    const { protocol, nagle = true, key, cert, SNICallback } = this.#options;
    const httpModule = protocol === 'http' ? http : https;
    const serverOptions = { key, cert, noDelay: !nagle, SNICallback };
    this.httpServer = httpModule.createServer(serverOptions);

    const options = this.#buildAttachOptions();
    const onConnection = (transport) => void this.#handleConnection(transport);
    for (const entry of allTransports()) {
      const adapter = entry[1];
      if (typeof adapter.attach !== 'function') continue;
      const attached = adapter.attach(this, options, onConnection);
      // Expose the first attached server as wsServer for backwards compat
      if (attached && !this.wsServer) this.wsServer = attached;
    }
  }

  #buildAttachOptions() {
    const { websocketPath, cors, maxMessageSize } = this.#options;
    const headers = buildHeaders(cors);
    const options = { headers, maxMessageSize };
    if (websocketPath !== undefined) options.path = websocketPath;
    else options.verifyClient = ({ req }) => isMetacomWebSocketPath(req.url);
    return options;
  }

  // All server transports emit normalized 'message' with a string
  // for text packets and Uint8Array for binary chunks,
  // request-response transports (not duplex) carry a single request
  #handleConnection(transport) {
    const { duplex } = transport.constructor.capabilities;
    if (!duplex) return void this.#handleRequest(transport);
    const client = this.#addClient(transport);
    transport.on('message', (data) => {
      if (typeof data === 'string') this.#message(client, data);
      else if (data instanceof Uint8Array) handleBinary(client, data);
    });
  }

  // Responds with error itself and returns null when body is not received
  async #receive(transport) {
    const { maxBodySize = DEFAULT_MAX_BODY_BYTES } = this.#options;
    try {
      const data = await readBody(transport.req, maxBodySize);
      if (data === null) transport.error(413);
      return data;
    } catch (error) {
      transport.error(400, { error });
      return null;
    }
  }

  async #handleRequest(transport) {
    const { req } = transport;
    const client = this.#addClient(transport);
    const data = await this.#receive(transport);
    if (data === null) return;
    if (req.url === '/api') {
      if (req.method !== 'POST') transport.error(403);
      else this.#message(client, data);
      return;
    }
    this.#request(client, transport, data);
  }

  listen() {
    const { host, port, timeouts, retry } = this.#options;

    let count = retry || DEFAULT_LISTEN_RETRY;
    let listen = null;

    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.#context.console.info(`Listen port ${port}`);
        resolve(this);
      };

      const onError = (error) => {
        if (error.code !== 'EADDRINUSE') return void reject(error);
        count--;
        if (count === 0) return void reject(error);
        this.#context.console.warn(`Address in use: ${host}:${port}, retry...`);
        setTimeout(listen, timeouts?.bind ?? BIND_RETRY_TIMEOUT_MS);
      };

      listen = () => {
        this.httpServer.once('listening', onListening);
        this.httpServer.once('error', onError);
        this.httpServer.listen(port, host);
      };

      listen();
    });
  }

  #message(client, data) {
    const packet = jsonParse(data) || {};
    const { id, type, method } = packet;
    const isCall = type === 'call' && id && typeof method === 'string';
    if (isCall) return void handleRpc(client, packet, this.#context);
    if (type === 'stream' && id) return void handleStream(client, packet);
    const error = new Error('Packet structure error');
    client.error(500, { error });
  }

  #request(client, transport, data) {
    const { url } = transport.req;
    const pathname = url.slice('/api/'.length);
    const urlParts = split(pathname, '?');
    const parameters = parseParams(urlParts[1]);
    const pathParts = split(urlParts[0], '/');
    const unit = pathParts[0];
    const name = pathParts[1];
    const body = jsonParse(data);
    const args = body ? { ...parameters, ...body } : parameters;
    const { generateId = generateUUID } = this.#options;
    const id = generateId();
    const method = `${unit}/${name}`;
    const packet = { id, method, args };
    handleRpc(client, packet, this.#context);
  }

  async close() {
    if (!this.httpServer.listening) return;
    this.httpServer.close((error) => {
      if (error) this.#context.console.error(error);
    });
    const closing = [];
    for (const client of this.#clients) {
      closing.push(client.toPromise('close'));
      client.close();
    }
    await Promise.all(closing);
  }
}

module.exports = { Server, Client, Context, Session, createProxy };
