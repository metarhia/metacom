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

class Client extends EventEmitter {
  #transport;
  #eventId;

  constructor(server, transport) {
    super();
    this.#transport = transport;
    this.#eventId = 0;
    this.ip = transport.ip;
    this.session = null;
    if (transport.res) {
      transport.res.on('close', () => {
        this.destroy();
      });
    }
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
    const packet = { event: --this.#eventId, [name]: data };
    if (!this.connection) {
      throw new Error(`Can't send metacom events to http transport`);
    }
    this.send(packet);
  }

  getStream(streamId) {
    if (!this.#transport.connection) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.#transport.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size) {
    if (!this.#transport.connection) {
      throw new Error(`Can't send metacom streams to http transport`);
    }
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const streamId = --this.streamId;
    const initData = { streamId, name, size };
    return new MetaWritable(this.#transport.connection, initData);
  }

  initializeSession(token, data = {}) {
    this.finalizeSession();
    const session = new Session(token, this.#transport, data);
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
  constructor(options, application) {
    // TODO: swap parameters
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
      const transport = new HttpTransport(console, req, res);
      if (!req.url.startsWith('/api')) {
        application.serveStatic(req.url, transport);
        return;
      }
      if (balancer) this.balancing(transport);
      if (res.writableEnded) return;

      const client = new Client(console, transport);
      this.clients.add(client);

      const data = await metautil.receiveBody(req).catch(() => null);

      if (req.url === '/api') this.message(client, data);
      else this.handleRequest(client, transport, data, application);

      req.on('close', () => {
        client.destroy();
      });
    });

    this.wsServer = new ws.Server({ server: this.httpServer });

    this.wsServer.on('connection', (connection, req) => {
      const transport = new WsTransport(console, req, connection);
      const client = new Client(console, transport);
      this.clients.add(client);

      connection.on('message', (data, isBinary) => {
        if (isBinary) this.binary(client, data);
        else this.message(client, data);
      });

      connection.on('close', () => {
        this.destroy();
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
    const packet = metautil.jsonParse(data);
    if (!packet) {
      const error = new Error('JSON parsing error');
      client.error(500, { error, pass: true });
      return;
    }
    const [callType] = Object.keys(packet);
    if (callType === 'call') {
      this.handleRpcPacket(client, packet);
    } else if (callType === 'stream') {
      this.handleStreamPacket(client, packet);
    } else {
      const error = new Error('Packet structure error');
      client.error(500, { error, pass: true });
    }
  }

  async rpc(client, packet) {
    const { callId, interfaceName, methodName, args } = packet;
    const [iname, ver = '*'] = interfaceName.split('.');
    const proc = this.application.getMethod(iname, ver, methodName);
    if (!proc) {
      client.error(404, { callId });
      return;
    }
    const context = client.createContext();
    if (!client.session && proc.access !== 'public') {
      client.error(403, { callId });
      return;
    }
    try {
      await proc.enter();
    } catch {
      client.error(503, { callId });
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      if (error.message === 'Timeout reached') {
        error.code = error.httpCode = 408;
      }
      client.error(error.code, { callId, error });
      return;
    } finally {
      proc.leave();
    }
    if (result?.constructor?.name === 'Error') {
      const { code, httpCode = 200 } = result;
      client.error(code, { callId, error: result, httpCode });
      return;
    }
    client.send({ callback: callId, result });
    this.console.log(`${client.ip}\t${interfaceName}/${methodName}`);
  }

  binary(client, data) {
    try {
      const { streamId, payload } = Chunk.decode(data);
      const upstream = client.streams.get(streamId);
      if (upstream) {
        upstream.push(payload);
      } else {
        const error = new Error(`Stream ${streamId} is not initialized`);
        client.error(400, { callId: streamId, error, pass: true });
      }
    } catch (error) {
      client.error(400, { callId: 0, error });
    }
  }

  handleRpcPacket(client, packet) {
    const [callType, target] = Object.keys(packet);
    const callId = parseInt(packet[callType], 10);
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      const packet = { callId, interfaceName, methodName, args };
      this.rpc(client, packet);
      return;
    }
    const error = new Error('Packet structure error');
    client.error(400, { callId, error, pass: true });
  }

  async handleStreamPacket(client, packet) {
    const { stream: streamId, name, size, status } = packet;
    const stream = client.streams.get(streamId);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        const error = new Error(`Stream ${name} is already initialized`);
        client.error(400, { callId: streamId, error, pass: true });
      } else {
        const streamData = { streamId, name, size };
        const stream = new MetaReadable(streamData);
        client.streams.set(streamId, stream);
      }
    } else if (!stream) {
      const error = new Error(`Stream ${streamId} is not initialized`);
      client.error(400, { callId: streamId, error, pass: true });
    } else if (status === 'end') {
      await stream.close();
      client.streams.delete(streamId);
    } else if (status === 'terminate') {
      await stream.terminate();
      client.streams.delete(streamId);
    } else {
      const error = new Error('Stream packet structure error');
      client.error(400, { callId: streamId, error, pass: true });
    }
  }

  handleRequest(client, transport, data, application) {
    const { headers, url, method } = transport.req;
    const pathname = url.slice('/api/'.length);
    const [path, params] = metautil.split(pathname, '?');
    const args = metautil.parseParams(params);
    const [interfaceName, methodName] = metautil.split(path, '/');
    const packet = { callId: 0, interfaceName, methodName, args };
    const hook = application.getHook(interfaceName);
    if (hook) {
      client.hook(client, hook, packet, method, headers);
      return;
    }
    this.rpc(client, packet);
  }

  async hook(client, proc, packet, method, headers) {
    const { callId, interfaceName, methodName, args } = packet;
    if (!proc) {
      client.error(404, { callId });
      return;
    }
    const context = client.createContext();
    try {
      const par = { verb: method, method: methodName, args, headers };
      const result = await proc.invoke(context, par);
      client.send(result);
    } catch (error) {
      client.error(500, { callId, error });
    }
    this.console.log(`${client.ip}\t${interfaceName}/${methodName}`);
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
    if (this.clients.size === 0) {
      await metautil.delay(SHORT_TIMEOUT);
      return;
    }
    await metautil.delay(this.options.timeouts.stop);
    this.closeClients();
  }
}

module.exports = { Server };
