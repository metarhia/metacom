'use strict';

const { Emitter, generateUUID, jsonParse, split } = require('metautil');

const { Metacom } = require('./metacom.js');
const { chunkDecode } = require('./chunks-node.js');

const ROUTE_TIMEOUT_MS = 7 * 1000;
const SWEEP_INTERVAL_MS = 10 * 1000;
const PROXY_QUEUE_SIZE = 1000;
const BAD_REQUEST = { message: 'Bad Request', code: 400 };
const UNAVAILABLE = { message: 'Service Unavailable', code: 503 };

const sendError = (port, id, error) => {
  const packet = { type: 'callback', id, error };
  port.postMessage(JSON.stringify(packet));
};

const sendTerminate = (port, id) => {
  const packet = { type: 'stream', id, status: 'terminate' };
  port.postMessage(JSON.stringify(packet));
};

const encodeEvent = (name, data) => {
  const packet = { type: 'event', name, data };
  return JSON.stringify(packet);
};

const encodeCallback = (id, result) => {
  const packet = { type: 'callback', id, result };
  return JSON.stringify(packet);
};

// Method format: unit/name or unit.version/name
const parseMethod = (method) => {
  const route = split(method, '/');
  const target = split(route[0], '.');
  return { unit: target[0], name: route[1] };
};

class ProxyContext {
  #port = null;
  #ports = null;

  constructor(server, port, ports) {
    this.server = server;
    this.#port = port;
    this.#ports = ports;
  }

  emit(name, data) {
    this.#port.postMessage(encodeEvent(name, data));
  }

  broadcast(name, data) {
    const packet = encodeEvent(name, data);
    for (const port of this.#ports.keys()) {
      if (port !== this.#port) port.postMessage(packet);
    }
  }
}

class MetacomRouter extends Emitter {
  #instance = generateUUID();
  #getClients = null;
  #ports = new Map();
  #peers = new Map();
  #calls = new Map();
  #streams = new Map();
  #units = new Map();
  #interfaces = new Map();
  #server = null;
  #connecting = false;
  #attempted = false;
  #connected = false;
  #callTimeout = ROUTE_TIMEOUT_MS;
  #sweepInterval = SWEEP_INTERVAL_MS;
  #sweepTimer = null;

  get instance() {
    return this.#instance;
  }

  get server() {
    return this.#server;
  }

  get active() {
    return this.#server.active;
  }

  constructor(options = {}) {
    super();
    const { callTimeout, sweepInterval } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (sweepInterval) this.#sweepInterval = sweepInterval;
    this.#getClients = options.getClients ?? null;
    this.#server = this.#createServer(options);
  }

  #createServer(options) {
    const url = options.url;
    const queueSize = options.queueSize ?? PROXY_QUEUE_SIZE;
    const proxy = {
      packet: (packet, data) => this.#route(packet, data),
      binary: (id, data) => this.#routeBinary(id, data),
    };
    const server = Metacom.create(url, { ...options, proxy, queueSize });
    server.on('open', () => this.#notify(true));
    server.on('close', () => {
      this.#abortStreams();
      this.#notify(false);
    });
    server.on('error', (error) => this.#escalate(error));
    return server;
  }

  async open() {
    if (this.#server.active) return;
    this.#connecting = !this.#attempted;
    try {
      await this.#server.open();
    } finally {
      this.#connecting = false;
      this.#attempted = true;
      if (!this.#server.active) this.#describePending();
    }
  }

  close() {
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#calls.clear();
    this.#streams.clear();
    this.#server.close();
  }

  // Local method shadows server method with the same name
  register(unit, methods) {
    const handlers = this.#units.get(unit) ?? new Map();
    const names = Object.keys(methods);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      handlers.set(name, methods[name]);
    }
    this.#units.set(unit, handlers);
  }

  broadcast(name, data) {
    this.#post(encodeEvent(name, data));
  }

  #escalate(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  port(id) {
    return this.#peers.get(id);
  }

  attach(port, options = {}) {
    if (!port) return;
    const {
      id = generateUUID(),
      client = '',
      callTimeout = this.#callTimeout,
    } = options;
    this.detach(id);
    this.#ports.set(port, { id, client, callTimeout });
    if (id) this.#peers.set(id, port);
    port.addEventListener('message', ({ data }) => {
      this.receive(port, data);
    });
    port.start();
    const instance = this.#instance;
    const connected = this.#server.active;
    port.postMessage({ type: 'metacom:ready', instance, connected });
    this.#startSweep();
    this.emit('connect', id);
    if (!connected) this.open().catch((error) => this.#escalate(error));
  }

  detach(id) {
    const port = this.#peers.get(id);
    if (port) this.#removePort(port);
  }

  #removePort(port) {
    if (!this.#ports.has(port)) return;
    const { id } = this.#ports.get(port);
    this.#ports.delete(port);
    this.#peers.delete(id);
    for (const entry of this.#calls) {
      if (entry[1].port === port) this.#calls.delete(entry[0]);
    }
    for (const entry of this.#streams) {
      const streamId = entry[0];
      const stream = entry[1];
      if (stream.port !== port) continue;
      this.#streams.delete(streamId);
      const isUploading = stream.upload && stream.expires === 0;
      if (isUploading) this.#terminateUpload(streamId);
    }
    port.close();
    this.emit('disconnect', id);
  }

  #terminateUpload(id) {
    if (!this.#server.active) return;
    this.#server.send({ type: 'stream', id, status: 'terminate' });
  }

  #startSweep() {
    if (this.#sweepTimer) return;
    const timer = setInterval(() => this.#sweep(), this.#sweepInterval);
    if (typeof timer.unref === 'function') timer.unref();
    this.#sweepTimer = timer;
  }

  #sweep() {
    const now = Date.now();
    for (const entry of this.#calls) {
      if (entry[1].expires <= now) this.#calls.delete(entry[0]);
    }
    for (const entry of this.#streams) {
      const { expires } = entry[1];
      const isExpired = expires !== 0 && expires <= now;
      if (isExpired) this.#streams.delete(entry[0]);
    }
    this.#sweepClients().catch((error) => this.#escalate(error));
  }

  // Closed tab is not listed by the browser, its port gives no signal
  async #sweepClients() {
    if (!this.#getClients) return;
    const list = await this.#getClients();
    if (!list) return;
    const alive = new Set();
    for (let i = 0; i < list.length; i++) alive.add(list[i].id);
    for (const entry of this.#ports) {
      const { client } = entry[1];
      const isClosed = client !== '' && !alive.has(client);
      if (isClosed) this.#removePort(entry[0]);
    }
  }

  // Failed reconnect attempts close the transport again and again
  #notify(connected) {
    if (this.#connected === connected) return;
    this.#connected = connected;
    const message = { type: 'metacom:status', connected };
    for (const port of this.#ports.keys()) port.postMessage(message);
  }

  #post(data) {
    for (const port of this.#ports.keys()) port.postMessage(data);
  }

  receive(port, data) {
    const peer = this.#ports.get(port);
    if (!peer) return;
    if (typeof data === 'string') return void this.#receivePacket(port, data);
    if (ArrayBuffer.isView(data)) return void this.#forwardChunk(port, data);
    const isAnnounce = data?.type === 'metacom:stream';
    if (isAnnounce) this.#expectStream(port, data.id);
  }

  #receivePacket(port, data) {
    const packet = jsonParse(data);
    if (!packet) return void sendError(port, '', BAD_REQUEST);
    const { type, id } = packet;
    if (typeof id !== 'string' || id === '') {
      return void sendError(port, '', BAD_REQUEST);
    }
    if (type === 'call') return void this.#dispatchCall(port, packet, data);
    if (type === 'stream') return void this.#forwardStream(port, packet, data);
    sendError(port, id, BAD_REQUEST);
  }

  #dispatchCall(port, packet, data) {
    const { id, method } = packet;
    if (typeof method !== 'string') {
      return void sendError(port, id, BAD_REQUEST);
    }
    const { unit, name } = parseMethod(method);
    const isIntrospect = unit === 'system' && name === 'introspect';
    if (isIntrospect) return void this.#introspect(port, packet, data);
    const handlers = this.#units.get(unit);
    const handler = handlers ? handlers.get(name) : undefined;
    if (handler) return void this.#invoke(port, packet, handler);
    this.#forwardCall(port, id, data, null);
  }

  async #invoke(port, packet, handler) {
    const { id, args } = packet;
    const context = new ProxyContext(this.#server, port, this.#ports);
    try {
      const result = await handler(args, context);
      if (this.#ports.has(port)) port.postMessage(encodeCallback(id, result));
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : 500;
      if (this.#ports.has(port)) {
        sendError(port, id, { message: error.message, code });
      }
    }
  }

  // Offline tab gets local and cached methods, the rest after reconnect
  #introspect(port, packet, data) {
    const { id, args } = packet;
    const units = Array.isArray(args) ? args : [];
    const isReachable = this.#server.active || this.#connecting;
    if (isReachable) return void this.#forwardCall(port, id, data, units);
    this.#sendInterface(port, id, units);
  }

  #sendInterface(port, id, units) {
    const result = this.#describe(units);
    port.postMessage(encodeCallback(id, result));
  }

  // Introspection waits for the first connection attempt only
  #describePending() {
    for (const entry of this.#calls) {
      const id = entry[0];
      const { port, units } = entry[1];
      if (!units) continue;
      this.#calls.delete(id);
      this.#sendInterface(port, id, units);
    }
  }

  #describe(units) {
    const result = {};
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const remote = this.#interfaces.get(unit);
      const local = this.#units.get(unit);
      if (!remote && !local) continue;
      const methods = { ...remote };
      if (local) for (const name of local.keys()) methods[name] = {};
      result[unit] = methods;
    }
    return result;
  }

  #mergeInterfaces(units, packet, data) {
    const { id, result } = packet;
    if (!result) return data;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (Object.hasOwn(result, unit)) this.#interfaces.set(unit, result[unit]);
      else this.#interfaces.delete(unit);
    }
    return encodeCallback(id, this.#describe(units));
  }

  #forwardCall(port, id, data, units) {
    if (this.#calls.has(id)) {
      return void sendError(port, id, {
        message: 'Duplicate call id',
        code: 409,
      });
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + callTimeout;
    this.#calls.set(id, { port, expires, units });
    if (this.#deliver(data, callTimeout)) return;
    this.#calls.delete(id);
    sendError(port, id, UNAVAILABLE);
  }

  #deliver(data, timeout) {
    try {
      return this.#server.deliver(data, timeout);
    } catch {
      return false;
    }
  }

  // Finished upload keeps its route for a while to pass server errors
  #forwardStream(port, packet, data) {
    const { id, status } = packet;
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (!this.#server.active) {
      this.#streams.delete(id);
      return void sendError(port, id, UNAVAILABLE);
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = status === undefined ? 0 : Date.now() + callTimeout;
    this.#streams.set(id, { port, expires, upload: true });
    this.#server.write(data);
  }

  #forwardChunk(port, data) {
    if (!this.#server.active) return;
    const { id } = chunkDecode(data);
    const stream = this.#streams.get(id);
    if (stream?.port !== port || !stream.upload) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (this.#server.active) this.#server.write(data);
  }

  // Tab creates download stream id before the call that fills the stream
  #expectStream(port, id) {
    if (typeof id !== 'string' || id === '') return;
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) return;
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + 2 * callTimeout;
    this.#streams.set(id, { port, expires, upload: false });
  }

  #route(packet, data) {
    const { type, id } = packet;
    if (type === 'event') return void this.#post(data);
    if (type === 'callback') return void this.#routeCallback(packet, data);
    const stream = this.#streams.get(id);
    if (!stream) return;
    if (packet.status === undefined) stream.expires = 0;
    else this.#streams.delete(id);
    stream.port.postMessage(data);
  }

  // Server reports stream errors as callbacks with stream id
  #routeCallback(packet, data) {
    const { id } = packet;
    const call = this.#calls.get(id);
    if (call) {
      this.#calls.delete(id);
      const { port, units } = call;
      const reply = units ? this.#mergeInterfaces(units, packet, data) : data;
      return void port.postMessage(reply);
    }
    const stream = this.#streams.get(id);
    if (stream) stream.port.postMessage(data);
  }

  #routeBinary(id, data) {
    const stream = this.#streams.get(id);
    if (stream) stream.port.postMessage(data);
  }

  // Server forgets streams on reconnect, expected downloads stay routed
  #abortStreams() {
    for (const entry of this.#streams) {
      const id = entry[0];
      const { port, expires, upload } = entry[1];
      if (expires !== 0) continue;
      if (upload) sendError(port, id, UNAVAILABLE);
      else sendTerminate(port, id);
      this.#streams.delete(id);
    }
  }
}

module.exports = { MetacomRouter };
