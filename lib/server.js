'use strict';

const http = require('node:http');
const https = require('node:https');

const metautil = require('metautil');
const { Emitter, jsonParse, parseParams, split } = metautil;
const { isError, receiveBody, delay, generateUUID } = metautil;

const { buildHeaders } = require('./transport.js');
const { MetaReadable, MetaWritable } = require('./streams.js');
const { chunkDecode } = require('./chunks.js');
const { allTransports } = require('./transport-registry.js');

require('./transport-ws.js');
require('./transport-http.js');
require('./transport-event.js');

const SHORT_TIMEOUT = 500;
const DEFAULT_LISTEN_RETRY = 3;

const getPathname = (url) => {
  if (!url) return '/';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
};

const isMetacomWebSocketPath = (url) => {
  const pathname = getPathname(url);
  return (
    pathname === '/' || pathname === '/api' || pathname.startsWith('/api/')
  );
};

// No 'get' trap: reads go straight to the target at native speed,
// only writes are intercepted to persist the session state
const createProxy = (data, save) =>
  new Proxy(data, {
    set: (target, key, value) => {
      const success = Reflect.set(target, key, value);
      if (save) save(target);
      return success;
    },
  });

class Session {
  constructor(token, data, context) {
    this.token = token;
    const { console, auth } = context;
    this.state = createProxy(data, (data) => {
      auth.saveSession(token, data).catch((error) => {
        console.error(error);
      });
    });
  }
}

const sessions = new Map(); // token: Session

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
  #context = null;

  constructor(transport, context) {
    super();
    this.#transport = transport;
    this.#context = context;
    this.source = transport.source;
    this.session = null;
    this.streams = new Map();
  }

  error(code, { id = '', error = null } = {}) {
    const httpCode = code <= 599 ? code : 500;
    const status = http.STATUS_CODES[httpCode];
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
    if (!this.#transport.constructor.capabilities?.events) {
      throw new Error(`Can't send metacom event to http transport`);
    }
    this.send(packet);
  }

  getStream(id) {
    if (!this.#transport.constructor.capabilities?.streams) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    if (!this.#transport.constructor.capabilities?.streams) {
      throw new Error(`Can't send metacom streams to http transport`);
    }
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const id = generateUUID();
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
    if (!this.#transport.constructor.capabilities?.duplex) {
      this.#transport.sendSessionCookie(token);
    }
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
      if (typeof stream.terminate !== 'function') continue;
      Promise.resolve(stream.terminate()).catch((error) => {
        console.error(error);
      });
    }
    this.streams.clear();
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

const protectedCall = async (client, proc, id, args) => {
  const context = client.createContext();
  try {
    await proc.enter();
  } catch (error) {
    client.error(503, { id, error });
    return { entered: false, result: null };
  }
  let result = null;
  try {
    result = await proc.invoke(context, args);
  } finally {
    proc.leave();
  }
  return { entered: true, result };
};

const handleStream = async (client, packet) => {
  const { id, name, size, status } = packet;
  const tag = `${id}/${name}`;
  try {
    const stream = client.streams.get(id);
    if (status) {
      if (!stream) throw new Error(`Stream ${tag} is not initialized`);
      if (status === 'end') await stream.close();
      if (status === 'terminate') await stream.terminate();
      return void client.streams.delete(id);
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
  const [unitName, methodName] = method.split('/');
  const [unit, ver = '*'] = unitName.split('.');
  const proc = context.getMethod(unit, ver, methodName);
  if (!proc) return void client.error(404, { id });
  if (!client.session && proc.access !== 'public') {
    return void client.error(403, { id });
  }
  try {
    const procResult = await protectedCall(client, proc, id, args);
    if (!procResult.entered) return;
    const { result } = procResult;
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

class Server extends Emitter {
  #headers = null;
  #clients = new Set();
  #context = null;
  #options = null;
  httpServer = null;
  wsServer = null;

  constructor(context, options) {
    super();
    this.#context = context;
    this.#options = options;
    this.#headers = buildHeaders(options.cors);
    this.#init();
  }

  #addClient(transport) {
    const client = new Client(transport, this.#context);
    this.#clients.add(client);
    transport.once('close', () => {
      client.destroy();
      this.#clients.delete(client);
    });
    return client;
  }

  #init() {
    const { protocol, nagle = true, key, cert, SNICallback } = this.#options;
    const proto = protocol === 'http' ? http : https;
    const opt = { key, cert, noDelay: !nagle, SNICallback };
    this.httpServer = proto.createServer(opt);

    // Each registered transport wires itself into this server (HTTP
    // requests, WebSocket upgrade, external ports) and calls
    // onConnection(transport) for every incoming connection or request
    const options = this.#buildAttachOptions();
    const onConnection = (transport) => void this.#handleConnection(transport);
    for (const [, adapter] of allTransports()) {
      if (typeof adapter.attach !== 'function') continue;
      const server = adapter.attach(this, options, onConnection);
      // Expose the first attached server as wsServer for backwards compat
      if (server && !this.wsServer) this.wsServer = server;
    }
  }

  #buildAttachOptions() {
    const { websocketPath } = this.#options;
    const options = { headers: this.#headers };
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

  async #handleRequest(transport) {
    const { req } = transport;
    const client = this.#addClient(transport);
    let data = null;
    try {
      data = await receiveBody(req);
    } catch (error) {
      transport.error(400, { error });
      return;
    }

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
        setTimeout(listen, timeouts.bind);
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
    if (type === 'call' && id && method) {
      return void handleRpc(client, packet, this.#context);
    } else if (type === 'stream' && id) {
      return void handleStream(client, packet);
    }
    const error = new Error('Packet structure error');
    client.error(500, { error });
  }

  #request(client, transport, data) {
    const { url } = transport.req;
    const pathname = url.slice('/api/'.length);
    const [path, params] = split(pathname, '?');
    const parameters = parseParams(params);
    const [unit, name] = split(path, '/');
    const body = jsonParse(data);
    const args = body ? Object.assign({}, parameters, body) : parameters;
    const id = generateUUID();
    const method = `${unit}/${name}`;
    const packet = { id, method, args };
    handleRpc(client, packet, this.#context);
  }

  async close() {
    if (!this.httpServer.listening) return;
    this.httpServer.close((error) => {
      if (error) this.#context.console.error(error);
    });
    if (this.#clients.size === 0) return;
    for (const client of this.#clients) client.close();
    while (this.#clients.size > 0) await delay(SHORT_TIMEOUT);
  }
}

module.exports = {
  Server,
  Client,
  Context,
  Session,
  createProxy,
};
