'use strict';

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const metautil = require('metautil');
const ws = require('ws');
const { HttpTransport, WsTransport, HEADERS } = require('./transport.js');
const { MetaReadable, MetaWritable, chunkDecode } = require('./streams.js');

const SHORT_TIMEOUT = 500;
const EMPTY_PACKET = Buffer.from('{}');
const DEFAULT_LISTEN_RETRY = 3;

const createProxy = (data, save) =>
  new Proxy(data, {
    get: (data, key) => {
      const value = Reflect.get(data, key);
      return value;
    },
    set: (data, key, value) => {
      const success = Reflect.set(data, key, value);
      if (save) save(data);
      return success;
    },
  });

class Session {
  constructor(token, data, server) {
    this.token = token;
    const { application, console } = server;
    this.state = createProxy(data, (data) => {
      application.auth.saveSession(token, data).catch((err) => {
        console.error(err);
      });
    });
  }
}

const sessions = new Map(); // token: Session

class Context {
  constructor(client) {
    this.client = client;
    this.uuid = metautil.generateUUID();
    this.state = {};
    this.session = client?.session || null;
  }
}

class Client extends EventEmitter {
  #transport;
  #streamId;

  constructor(transport) {
    super();
    this.#transport = transport;
    this.#streamId = 0;
    this.ip = transport.ip;
    this.session = null;
    this.streams = new Map();
    transport.server.clients.add(this);
    transport.once('close', () => {
      this.destroy();
      transport.server.clients.delete(this);
    });
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
    const id = --this.#streamId;
    const stream = new MetaWritable(id, name, size, this.#transport);
    this.streams.set(id, stream);
    return stream;
  }

  initializeSession(token, data = {}) {
    this.finalizeSession();
    this.session = new Session(token, data, this.#transport.server);
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
    if (!this.#transport.connection) this.#transport.sendSessionCookie(token);
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
    this.emit('close');
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

const addHeaders = ({ origin }) => {
  if (origin) HEADERS['Access-Control-Allow-Origin'] = origin;
};

class Server {
  constructor(application, options) {
    this.retry = options.retry ?? DEFAULT_LISTEN_RETRY;
    this.application = application;
    this.options = options;
    this.balancer = options.kind === 'balancer';
    this.console = application.console;
    if (options.cors) addHeaders(options.cors);
    this.httpServer = null;
    this.wsServer = null;
    this.clients = new Set();
    this.init();
  }

  init() {
    const { application, balancer, options } = this;
    const { protocol, nagle = true, key, cert, SNICallback } = options;
    const proto = protocol === 'http' || balancer ? http : https;
    const opt = { key, cert, noDelay: !nagle, SNICallback };
    this.httpServer = proto.createServer(opt);

    this.httpServer.on('request', async (req, res) => {
      const transport = new HttpTransport(this, req, res);
      const api = req.url.startsWith('/api');
      if (!api && !(balancer && req.url === '/')) {
        if (application.static.constructor.name !== 'Static') return;
        return void application.static.serve(req.url, transport);
      }
      if (balancer) this.balancing(transport);
      if (res.writableEnded) return;

      const client = new Client(transport);
      const data = await metautil.receiveBody(req).catch(() => null);

      if (req.url === '/api') {
        if (req.method !== 'POST') transport.error(403);
        else this.message(client, data);
        return;
      }
      this.request(client, transport, data);
    });

    if (balancer) return;
    this.wsServer = new ws.Server({ server: this.httpServer });

    this.wsServer.on('connection', (connection, req) => {
      const transport = new WsTransport(this, req, connection);
      const client = new Client(transport);

      connection.on('message', (data, isBinary) => {
        if (isBinary) this.binary(client, new Uint8Array(data));
        else this.message(client, data);
      });
    });
  }

  listen() {
    const { console, options } = this;
    const { host, port, timeouts } = options;

    return new Promise((resolve, reject) => {
      this.httpServer.on('listening', () => {
        console.info(`Listen port ${port}`);
        resolve(this);
      });

      const server = this.wsServer || this.httpServer;
      server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE') return;
        this.retry--;
        if (this.retry === 0) return void reject(err);
        console.warn(`Address in use: ${host}:${port}, retry...`);
        setTimeout(() => {
          this.httpServer.listen(port, host);
        }, timeouts.bind);
      });

      this.httpServer.listen(port, host);
    });
  }

  message(client, data) {
    if (Buffer.compare(EMPTY_PACKET, data) === 0) {
      return void client.send({});
    }
    const packet = metautil.jsonParse(data) || {};
    const { id, type, method } = packet;
    if (type === 'call' && id && method) return void this.rpc(client, packet);
    else if (type === 'stream' && id) return void this.stream(client, packet);
    const error = new Error('Packet structure error');
    client.error(500, { error, pass: true });
  }

  async rpc(client, packet) {
    const { id, method } = packet;
    const [unitName, methodName] = method.split('/');
    const [unit, ver = '*'] = unitName.split('.');
    const proc = this.application.getMethod(unit, ver, methodName);
    if (!proc) return void client.error(404, { id });
    if (!client.session && proc.access !== 'public') {
      return void client.error(403, { id });
    }
    this.handleRequest(client, packet, proc);
  }

  async stream(client, packet) {
    const { id, name, size, status } = packet;
    const tag = id + '/' + name;
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
        this.console.log(`${client.ip}\tstream ${tag} init`);
      }
    } catch (error) {
      this.console.error(`${client.ip}\tstream ${tag} error`);
      client.error(400, { id, error, pass: true });
    }
  }

  binary(client, data) {
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
      this.console.error(`${client.ip}\tstream ${id} error`);
      client.error(400, { id: 0, error });
    }
  }

  request(client, transport, data) {
    const { application } = this;
    const { headers, url, method: verb } = transport.req;
    const pathname = url.slice('/api/'.length);
    const [path, params] = metautil.split(pathname, '?');
    const parameters = metautil.parseParams(params);
    const [unit, method] = metautil.split(path, '/');
    const body = metautil.jsonParse(data) || {};
    const args = { ...parameters, ...body };
    const packet = { id: 0, method: unit + '/' + method, args };
    const hook = application.getHook(unit);
    if (hook) this.hook(client, hook, packet, verb, headers);
    else this.rpc(client, packet);
  }

  async hook(client, proc, packet, verb, headers) {
    const { method, args, id } = packet;
    const par = Object.assign(args, { method, headers, verb });
    this.handleRequest(client, { method, id, args: par }, proc);
  }

  async handleRequest(client, packet, proc) {
    const { id, method, args, type } = packet;
    if (!proc) return void client.error(404, { id });
    const context = client.createContext();
    try {
      await proc.enter();
    } catch {
      return void client.error(503, { id });
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      let code = error.code === 'ETIMEOUT' ? 408 : 500;
      if (typeof error.code === 'number') code = error.code;
      error.httpCode = code <= 599 ? code : 500;
      return void client.error(code, { id, error });
    } finally {
      proc.leave();
    }
    if (metautil.isError(result)) {
      const { code, httpCode = 200 } = result;
      return void client.error(code, { id, error: result, httpCode });
    }
    if (type === 'call') client.send({ type: 'callback', id, result });
    else client.send(result);
    this.console.log(`${client.ip}\t${method}`);
  }

  balancing(transport) {
    const host = metautil.parseHost(transport.req.headers.host);
    const { protocol, ports } = this.options;
    const targetPort = metautil.sample(ports);
    const targetPath = transport.req.url || '/';
    transport.redirect(`${protocol}://${host}:${targetPort}${targetPath}`);
  }

  closeClients() {
    for (const client of this.clients) {
      client.close();
    }
  }

  async close() {
    if (!this.httpServer.listening) return;
    this.httpServer.close((err) => {
      if (err) this.console.error(err);
    });
    if (this.clients.size === 0) return;
    this.closeClients();
    while (this.clients.size > 0) {
      await metautil.delay(SHORT_TIMEOUT);
    }
  }
}

module.exports = { Server };
