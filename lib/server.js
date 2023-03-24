'use strict';

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const metautil = require('metautil');
const { Semaphore } = metautil;
const ws = require('ws');
const { HEADERS } = require('./transport.js');
const { MetaReadable, MetaWritable, Chunk } = require('./streams.js');

const SHORT_TIMEOUT = 500;

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
  constructor(token, transport, data) {
    this.token = token;
    this.state = createProxy(data, (data) => {
      transport.auth.saveSession(token, data).catch((err) => {
        transport.console.error(err);
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

const EMPTY_PACKET = Buffer.from('{}');

class Client extends EventEmitter {
  #console;
  #transport;
  #routing;
  #auth;
  #eventId;

  constructor(console, transport, routing, auth) {
    super();
    this.#console = console;
    this.#transport = transport;
    this.#routing = routing;
    this.#auth = auth;
    this.#eventId = 0;
    this.ip = transport.ip;
    this.session = null;
  }

  get token() {
    if (this.session === null) return '';
    return this.session.token;
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
    const packet = { event: --this.eventId, [name]: data };
    if (!this.connection) {
      throw new Error(`Can't send metacom events to http transport`);
    }
    this.send(packet);
  }

  getStream(streamId) {
    if (!this.connection) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size) {
    if (!this.connection) {
      throw new Error(`Can't send metacom streams to http transport`);
    }
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const streamId = --this.streamId;
    const initData = { streamId, name, size };
    const transport = this.connection;
    return new MetaWritable(transport, initData);
  }

  async resumeCookieSession() {
    const { cookie } = this.req.headers;
    if (!cookie) return;
    const cookies = metautil.parseCookies(cookie);
    const { token } = cookies;
    if (!token) return;
    const restored = this.client.restoreSession(token);
    if (restored) return;
    const data = await this.auth.readSession(token);
    if (data) this.client.initializeSession(token, data);
  }

  redirect(location) {
    if (this.#transport) this.#transport.redirect(location);
  }

  initializeSession(token, data = {}) {
    if (this.#transport.session) sessions.delete(this.#transport.session.token);
    const session = new Session(token, this.#transport, data);
    this.#transport.session = session;
    sessions.set(token, session);
    return true;
  }

  finalizeSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    if (!this.#transport.session) return false;
    sessions.delete(this.#transport.session.token);
    this.#transport.session = null;
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
    if (!this.#transport) return false;
    this.#transport.session = session;
    return true;
  }

  message(data) {
    if (Buffer.compare(EMPTY_PACKET, data) === 0) {
      this.send('{}');
      return;
    }
    const packet = metautil.jsonParse(data);
    if (!packet) {
      const error = new Error('JSON parsing error');
      this.error(500, { error, pass: true });
      return;
    }
    const [callType] = Object.keys(packet);
    if (callType === 'call') {
      this.handleRpcPacket(packet);
      return;
    } else if (callType === 'stream') {
      this.handleStreamPacket(packet);
      return;
    }
    const error = new Error('Packet structure error');
    this.error(500, { error, pass: true });
  }

  binary(data) {
    try {
      const { streamId, payload } = Chunk.decode(data);
      const upstream = this.streams.get(streamId);
      if (upstream) {
        upstream.push(payload);
      } else {
        const error = new Error(`Stream ${streamId} is not initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      }
    } catch (error) {
      this.error(400, { callId: 0, error });
    }
  }

  handleRpcPacket(packet) {
    this.resumeCookieSession();
    const [callType, target] = Object.keys(packet);
    const callId = parseInt(packet[callType], 10);
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      void this.rpc(callId, interfaceName, methodName, args);
      return;
    }
    const error = new Error('Packet structure error');
    this.error(400, { callId, error, pass: true });
  }

  async handleStreamPacket(packet) {
    const { stream: streamId, name, size, status } = packet;
    const stream = this.streams.get(streamId);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        const error = new Error(`Stream ${name} is already initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      } else {
        const streamData = { streamId, name, size };
        const stream = new MetaReadable(streamData);
        this.streams.set(streamId, stream);
      }
    } else if (!stream) {
      const error = new Error(`Stream ${streamId} is not initialized`);
      this.error(400, { callId: streamId, error, pass: true });
    } else if (status === 'end') {
      await stream.close();
      this.streams.delete(streamId);
    } else if (status === 'terminate') {
      await stream.terminate();
      this.streams.delete(streamId);
    } else {
      const error = new Error('Stream packet structure error');
      this.error(400, { callId: streamId, error, pass: true });
    }
  }

  async rpc(callId, interfaceName, methodName, args) {
    const { server } = this;
    const [iname, ver = '*'] = interfaceName.split('.');
    const proc = server.application.getMethod(iname, ver, methodName);
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    const context = this.createContext();
    if (!this.session && proc.access !== 'public') {
      this.error(403, { callId });
      return;
    }
    try {
      await proc.enter();
    } catch {
      this.error(503, { callId });
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      if (error.message === 'Timeout reached') {
        error.code = error.httpCode = 408;
      }
      this.error(error.code, { callId, error });
      return;
    } finally {
      proc.leave();
    }
    if (result?.constructor?.name === 'Error') {
      const { code, httpCode } = result;
      this.error(code, { callId, error: result, httpCode: httpCode || 200 });
      return;
    }
    this.send({ callback: callId, result });
    this.#console.log(`${this.ip}\t${interfaceName}/${methodName}`);
  }

  destroy() {
    this.emit('close');
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

const addHeaders = (headers) => {
  const { origin } = headers;
  if (origin) HEADERS['Access-Control-Allow-Origin'] = origin;
};

class Server {
  constructor(options, application) {
    const { cors, queue } = options;
    this.options = options;
    this.application = application;
    this.console = application.console;
    if (cors) addHeaders(cors);
    const concurrency = queue.concurrency || options.concurrency;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    this.server = null;
    this.ws = null;
    this.clients = new Set();
    this.bind();
  }

  bind() {
    const { options, application, console } = this;
    const { host, port, kind, protocol, timeouts, nagle = true } = options;
    const proto = protocol === 'http' || kind === 'balancer' ? http : https;
    const listener = this.listener.bind(this);
    this.server = proto.createServer({ ...application.cert }, listener);
    if (!nagle) {
      this.server.on('connection', (socket) => {
        socket.setNoDelay(true);
      });
    }
    this.server.on('listening', () => {
      console.info(`Listen port ${port}`);
    });
    this.ws = new ws.Server({ server: this.server });
    this.ws.on('connection', (connection, req) => {
      const transport = new WsTransport(console, req, connection);
      const client = new Client(console, transport, routing);
      this.clients.add(client);

      connection.on('message', (data) => {
        client.message(data);
      });

      connection.on('close', () => {
        client.destroy();
      });
    });
    this.ws.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') return;
      console.warn(`Address in use: ${host}:${port}, retry...`);
      setTimeout(() => {
        this.bind();
      }, timeouts.bind);
    });
    this.server.listen(port, host);
  }

  listener(req, res) {
    const { url } = req;
    const transport = new HttpTransport(console, req, res);
    const client = new Client(console, transport, routing);
    this.clients.add(client);

    const data = receiveBody(req);
    client.message(data);

    req.on('close', () => {
      client.destroy();
    });

    if (this.options.kind === 'balancer') {
      const host = metautil.parseHost(req.headers.host);
      const port = metautil.sample(this.options.ports);
      const { protocol } = this.options;
      client.redirect(`${protocol}://${host}:${port}/`);
      return;
    }
    if (url.startsWith('/api')) this.request(client);
    else this.application.serveStatic(client);
  }

  request(client) {
    const { req } = client;
    if (req.method === 'OPTIONS') {
      transport.options();
      return;
    }
    if (req.url === '/api' && req.method !== 'POST') {
      transport.error(403);
      return;
    }
    const body = metautil.receiveBody(req);
    if (req.url === '/api') {
      body.then((data) => {
        client.message(data);
      });
    } else {
      body.then((data) => {
        let args = null;
        if (data.length > 0) {
          args = metautil.jsonParse(data);
          if (!args) {
            const error = new Error('JSON parsing error');
            transport.error(500, { error, pass: true });
            return;
          }
        }
        const pathname = req.url.slice('/api/'.length);
        const [path, params] = metautil.split(pathname, '?');
        if (!args) args = metautil.parseParams(params);
        const [interfaceName, methodName] = metautil.split(path, '/');
        const { headers } = req;
        const hook = this.application.getHook(interfaceName);
        if (hook) client.hook(hook, interfaceName, methodName, args, headers);
        else client.rpc(-1, interfaceName, methodName, args, headers);
      });
    }
    body.catch((error) => {
      transport.error(500, { error });
    });
  }

  closeClients() {
    for (const client of this.clients.values()) {
      if (client.connection) {
        client.connection.terminate();
      } else {
        client.error(503);
        client.req.connection.destroy();
      }
    }
  }

  async close() {
    this.server.close((err) => {
      if (err) this.console.error(err);
    });
    if (this.clients.size === 0) {
      await metautil.delay(SHORT_TIMEOUT);
      return;
    }
    await metautil.delay(this.options.timeouts.stop);
    this.closeClients();
  }
}

module.exports = { Server };
