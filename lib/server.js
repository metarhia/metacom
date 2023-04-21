'use strict';

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const metautil = require('metautil');
const { Semaphore } = metautil;
const ws = require('ws');
const { HttpTransport, WsTransport, HEADERS } = require('./transport.js');
const { MetaReadable, MetaWritable, Chunk } = require('./streams.js');

const SHORT_TIMEOUT = 500;
const EMPTY_PACKET = Buffer.from('{}');

const createProxy = (data, save) =>
  new Proxy(data, {
    get: (data, key) => {
      return Reflect.get(data, key);
    },
    set: (data, key, value) => {
      const res = Reflect.set(data, key, value);
      if (save) save(data);
      return res;
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
    if (name === 'close') {
      super.emit(name, data);
      return;
    }
    this.#transport.sendEvent(name, data);
  }

  sendEvent(name, data) {
    const packet = { type: 'event', name, data };
    if (!this.connection) {
      throw new Error(`Can't send metacom event to http transport`);
    }
    this.send(packet);
  }

  getStream(id) {
    if (!this.#transport.connection) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.#transport.streams.get(id);
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
    const packet = { id, name, size };
    return new MetaWritable(this.#transport.connection, packet);
  }

  initializeSession(token, data = {}) {
    this.finalizeSession();
    const session = new Session(token, data, this.#transport.server);
    sessions.set(token, session);
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
    this.application = application;
    this.options = options;
    this.balancer = options.kind === 'balancer';
    this.console = application.console;
    if (options.cors) addHeaders(options.cors);
    const { queue } = options;
    const concurrency = queue.concurrency || options.concurrency;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    this.httpServer = null;
    this.wsServer = null;
    this.clients = new Set();
    this.bind();
  }

  bind() {
    const { options, application, console, balancer } = this;
    const { host, port, protocol, timeouts, nagle = true } = options;
    const proto = protocol === 'http' || balancer ? http : https;
    this.httpServer = proto.createServer({ ...application.cert });

    if (!nagle) {
      this.httpServer.on('connection', (socket) => {
        socket.setNoDelay(true);
      });
    }

    this.httpServer.on('listening', () => {
      console.info(`Listen port ${port}`);
    });

    this.httpServer.on('request', async (req, res) => {
      const transport = new HttpTransport(this, req, res);
      if (!req.url.startsWith('/api')) {
        application.serveStatic(req.url, transport);
        return;
      }
      if (balancer) this.balancing(transport);
      if (req.method !== 'POST') this.error(403);
      if (res.writableEnded) return;

      const client = new Client(transport);
      this.clients.add(client);

      const data = await metautil.receiveBody(req).catch(() => null);

      if (req.url === '/api') this.message(client, data);
      else this.request(client, transport, data);

      req.on('close', () => {
        client.destroy();
        this.clients.delete(client);
      });
    });

    this.wsServer = new ws.Server({ server: this.httpServer });

    this.wsServer.on('connection', (connection, req) => {
      const transport = new WsTransport(this, req, connection);
      const client = new Client(transport);
      this.clients.add(client);

      connection.on('message', (data, isBinary) => {
        if (isBinary) this.binary(client, data);
        else this.message(client, data);
      });

      connection.on('close', () => {
        client.destroy();
        this.clients.delete(client);
      });
    });

    this.wsServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') return;
      console.warn(`Address in use: ${host}:${port}, retry...`);
      setTimeout(() => {
        this.bind();
      }, timeouts.bind);
    });

    this.httpServer.listen(port, host);
  }

  message(client, data) {
    if (Buffer.compare(EMPTY_PACKET, data) === 0) {
      client.send('{}');
      return;
    }
    const packet = metautil.jsonParse(data) || {};
    const { id, method, type } = packet;
    if (id && type === 'call' && method) {
      this.rpc(client, packet);
    } else if (id && type === 'stream') {
      this.stream(client, packet);
    } else {
      const error = new Error('Packet structure error');
      client.error(500, { error, pass: true });
    }
  }

  async rpc(client, packet) {
    const { id, method, args } = packet;
    const [unitName, methodName] = method.split('/');
    const [unit, ver = '*'] = unitName.split('.');
    const proc = this.application.getMethod(unit, ver, methodName);
    if (!proc) {
      client.error(404, { id });
      return;
    }
    const context = client.createContext();
    if (!client.session && proc.access !== 'public') {
      client.error(403, { id });
      return;
    }
    try {
      await proc.enter();
    } catch {
      client.error(503, { id });
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      if (error.message === 'Timeout reached') {
        error.code = error.httpCode = 408;
      }
      client.error(error.code, { id, error });
      return;
    } finally {
      proc.leave();
    }
    if (result?.constructor?.name === 'Error') {
      const { code, httpCode = 200 } = result;
      client.error(code, { id, error: result, httpCode });
      return;
    }
    client.send({ type: 'callback', id, result });
    this.console.log(`${client.ip}\t${method}`);
  }

  async stream(client, packet) {
    const { id, name, size, status } = packet;
    const stream = client.streams.get(id);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        const error = new Error(`Stream ${name} is already initialized`);
        client.error(400, { id, error, pass: true });
      } else {
        const stream = new MetaReadable({ id, name, size });
        client.streams.set(id, stream);
      }
    } else if (!stream) {
      const error = new Error(`Stream ${id} is not initialized`);
      client.error(400, { id, error, pass: true });
    } else if (status === 'end') {
      await stream.close();
      client.streams.delete(id);
    } else if (status === 'terminate') {
      await stream.terminate();
      client.streams.delete(id);
    } else {
      const error = new Error('Stream packet structure error');
      client.error(400, { id, error, pass: true });
    }
  }

  binary(client, data) {
    try {
      const { id, payload } = Chunk.decode(data);
      const upstream = client.streams.get(id);
      if (upstream) {
        upstream.push(payload);
      } else {
        const error = new Error(`Stream ${id} is not initialized`);
        client.error(400, { id, error, pass: true });
      }
    } catch (error) {
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
    const { id, method, args } = packet;
    if (!proc) {
      client.error(404, { id });
      return;
    }
    const context = client.createContext();
    try {
      const par = { verb, method, args, headers };
      const result = await proc.invoke(context, par);
      client.send(result);
    } catch (error) {
      client.error(500, { id, error });
    }
    this.console.log(`${client.ip}\t${method}`);
  }

  balancing(transport) {
    const host = metautil.parseHost(transport.req.headers.host);
    const { protocol, port } = this.options;
    const targetPort = metautil.sample(port);
    transport.redirect(`${protocol}://${host}:${targetPort}/`);
  }

  closeClients() {
    for (const client of this.clients) {
      client.close();
    }
  }

  async close() {
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
