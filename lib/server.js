'use strict';

const http = require('node:http');
const https = require('node:https');
const metautil = require('metautil');
const { Emitter, jsonParse, parseParams, split } = metautil;
const { isError, receiveBody, delay, generateUUID } = metautil;
const ws = require('ws');
const { ServerTransport, buildHeaders } = require('./transport.js');
const ServerHttpTransport = ServerTransport.transport.http;
const ServerWsTransport = ServerTransport.transport.ws;
const ServerEventTransport = ServerTransport.transport.event;
const { MetaReadable, MetaWritable } = require('./streams.js');
const { chunkDecode } = require('./chunks.js');

const SHORT_TIMEOUT = 500;
const DEFAULT_LISTEN_RETRY = 3;

const createProxy = (data, save) =>
  new Proxy(data, {
    get: (target, key) => {
      const value = Reflect.get(target, key);
      return value;
    },
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
    this.session = client?.session || null;
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

  error(code, options) {
    this.#transport.error(code, options);
  }

  send(obj, code) {
    this.#transport.send(obj, code);
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
    if (!this.#transport.connection) {
      throw new Error(`Can't send metacom event to http transport`);
    }
    this.send(packet);
  }

  getStream(id) {
    if (!this.#transport.connection) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    if (!this.#transport.connection) {
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
    if (!this.#transport.connection) {
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
      if (typeof stream.terminate === 'function') {
        stream.terminate().catch((error) => {
          console.error(error);
        });
      }
    }
    this.streams.clear();
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

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
    const { source, req } = transport;
    let log = source;
    if (req) {
      const {
        req: { method, url },
      } = transport;
      log += `${method}\t${url}`;
    }
    const client = new Client(transport, this.#context);
    this.#clients.add(client);

    transport.on('debug', (httpCode) => {
      this.#context.console.debug(`${log}\t${httpCode}`);
    });

    transport.on('error', (error, httpCode, code) => {
      const info = error ? error.stack : http.STATUS_CODES[httpCode];
      const reason = `${httpCode}\t${code}\t${info}`;
      this.#context.console.error(`${log}\t${reason}`);
    });

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

    this.httpServer.on('request', (req, res) => {
      this.#handleHttpRequest(req, res);
    });

    this.wsServer = new ws.Server({ server: this.httpServer });

    this.wsServer.on('connection', (connection, req) => {
      this.#handleWsConnection(req, connection);
    });

    this.on('port', (port) => {
      this.#handleEventConnection(port);
    });
  }

  async #handleHttpRequest(req, res) {
    if (!req.url.startsWith('/api')) return;
    const options = { headers: this.#headers };
    const transport = new ServerHttpTransport(req, res, options);
    if (res.writableEnded) return;

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

  #handleWsConnection(req, connection) {
    const options = { headers: this.#headers };
    const transport = new ServerWsTransport(req, connection, options);
    const client = this.#addClient(transport);

    connection.on('message', (data, isBinary) => {
      if (isBinary) this.#binary(client, new Uint8Array(data));
      else this.#message(client, data);
    });
  }

  #handleEventConnection(port) {
    const transport = new ServerEventTransport(port);
    const client = this.#addClient(transport);

    port.on('message', (data) => {
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        this.#message(client, data);
      } else if (data instanceof Uint8Array) {
        this.#binary(client, data);
      }
    });
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
        if (error.code !== 'EADDRINUSE') return;
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
    if (type === 'call' && id && method) return void this.#rpc(client, packet);
    else if (type === 'stream' && id) return void this.#stream(client, packet);
    const error = new Error('Packet structure error');
    client.error(500, { error, pass: true });
  }

  async #protectedCall(client, proc, id, args) {
    const context = client.createContext();
    try {
      await proc.enter();
    } catch (error) {
      this.#context.console.error(error);
      client.error(503, { id });
      return { entered: false, result: null };
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } finally {
      proc.leave();
    }
    return { entered: true, result };
  }

  async #rpc(client, packet) {
    const { id, method, args } = packet;
    const [unitName, methodName] = method.split('/');
    const [unit, ver = '*'] = unitName.split('.');
    const proc = this.#context.getMethod(unit, ver, methodName);
    if (!proc) return void client.error(404, { id });
    if (!client.session && proc.access !== 'public') {
      return void client.error(403, { id });
    }
    try {
      const procResult = await this.#protectedCall(client, proc, id, args);
      if (!procResult.entered) return;
      const { result } = procResult;
      if (isError(result)) {
        const { code, httpCode = 200 } = result;
        return void client.error(code, { id, error: result, httpCode });
      }
      client.send({ type: 'callback', id, result });
      this.#context.console.log(`${client.source}\tCALL\t${method}\tOK`);
    } catch (error) {
      let code = error.code === 'ETIMEOUT' ? 408 : 500;
      if (typeof error.code === 'number') code = error.code;
      error.httpCode = code <= 599 ? code : 500;
      return void client.error(code, { id, error });
    }
  }

  async #stream(client, packet) {
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
      {
        const stream = new MetaReadable(id, name, size);
        client.streams.set(id, stream);
        this.#context.console.log(`${client.source}\tstream ${tag} init`);
      }
    } catch (error) {
      this.#context.console.error(`${client.source}\tstream ${tag} error`);
      client.error(400, { id, error, pass: true });
    }
  }

  #binary(client, data) {
    const { id, payload } = chunkDecode(data);
    try {
      const upstream = client.streams.get(id);
      if (upstream) {
        upstream.push(payload);
      } else {
        const error = new Error(`Stream ${id} is not initialized`);
        client.error(400, { id, error, pass: true });
      }
    } catch (error) {
      this.#context.console.error(`${client.source}\tstream ${id} error`);
      client.error(400, { id, error });
    }
  }

  #request(client, transport, data) {
    const context = this.#context;
    const { headers, url, method: verb } = transport.req;
    const pathname = url.slice('/api/'.length);
    const [path, params] = split(pathname, '?');
    const parameters = parseParams(params);
    const [unit, name] = split(path, '/');
    const body = jsonParse(data) || {};
    const args = { ...parameters, ...body };
    const id = generateUUID();
    const method = `${unit}/${name}`;
    const packet = { id, method, args };
    const hook = context.getHook(unit);
    if (hook) this.#hook(client, hook, packet, verb, headers);
    else this.#rpc(client, packet);
  }

  async #hook(client, proc, packet, verb, headers) {
    const { id, method, args } = packet;
    if (!proc) return void client.error(404, { id });
    try {
      const par = { verb, method, args, headers };
      const res = await this.#protectedCall(client, proc, id, par);
      if (!res.entered) return;
      if (isError(res.result)) {
        const { code, httpCode = 200 } = res.result;
        return void client.error(code, { id, error: res.result, httpCode });
      }
      client.send(res.result);
      this.#context.console.log(`${client.source}\t${method}`);
    } catch (error) {
      return void client.error(500, { id, error });
    }
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
