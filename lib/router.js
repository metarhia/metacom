'use strict';

const { Emitter, generateUUID, jsonParse } = require('metautil');

const { Metacom } = require('./metacom.js');
const { chunkDecode } = require('./chunks-node.js');
const { MetaReadable, MetaWritable, isStreamMeta } = require('./streams.js');
const { startInterval, parseMethod } = require('./utils.js');
const { encodeEvent, emitError, isId, registerUnit } = require('./utils.js');
const { CALL_TIMEOUT_MS, SERVICE_UNAVAILABLE } = require('./utils.js');

const SWEEP_INTERVAL_MS = 10 * 1000;
const PROXY_QUEUE_SIZE = 1000;
const BAD_REQUEST = { message: 'Bad Request', code: 400 };
const DUPLICATE_CALL = { message: 'Duplicate call id', code: 409 };
const FINAL_STATUSES = ['end', 'terminate'];

// Router without upstream delivers nothing and keeps uploads local
const NO_UPSTREAM = {
  active: false,
  open: async () => {},
  close: () => {},
  send: () => {},
  write: () => {},
  deliver: () => false,
};

const sendError = (port, id, error) => {
  const packet = { type: 'callback', id, error };
  port.postMessage(JSON.stringify(packet));
};

const sendTerminate = (port, id) => {
  const packet = { type: 'stream', id, status: 'terminate' };
  port.postMessage(JSON.stringify(packet));
};

const encodeCallback = (id, result) => {
  const packet = { type: 'callback', id, result };
  return JSON.stringify(packet);
};

const createRoute = (port, upload, expires) => ({
  port,
  upload,
  expires,
  packet: null,
  init: null,
  readable: null,
  local: false,
  forwarded: false,
});

// Attached port seen by handlers, like server Client: events to this port,
// its streams, and `close` when the port is detached
class RouterClient extends Emitter {
  #port = null;
  #router = null;

  constructor(id, port, router) {
    super();
    this.id = id;
    this.#port = port;
    this.#router = router;
  }

  emit(name, data) {
    if (name === 'close') return super.emit(name, data);
    const isAttached = this.#router.port(this.id) === this.#port;
    if (isAttached) this.#port.postMessage(encodeEvent(name, data));
    return Promise.resolve();
  }

  getStream(id) {
    return this.#router.getStream(this.#port, id);
  }

  createStream(name, size, id) {
    return this.#router.createStream(this.#port, name, size, id);
  }
}

class ProxyContext {
  #port = null;
  #ports = null;

  constructor(server, port, ports) {
    const { client } = ports.get(port);
    this.server = server;
    this.client = client;
    this.peerId = client.id;
    this.#port = port;
    this.#ports = ports;
  }

  getStream(id) {
    return this.client.getStream(id);
  }

  createStream(name, size, id) {
    return this.client.createStream(name, size, id);
  }

  emit(name, data) {
    this.client.emit(name, data);
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
  #localStreams = false;
  #ports = new Map();
  #peers = new Map();
  #calls = new Map();
  #streams = new Map();
  #units = new Map();
  #interfaces = new Map();
  #upstream = NO_UPSTREAM;
  #connecting = false;
  #attempted = false;
  #connected = false;
  #callTimeout = CALL_TIMEOUT_MS;
  #sweepInterval = SWEEP_INTERVAL_MS;
  #sweepTimer = null;

  get instance() {
    return this.#instance;
  }

  get server() {
    return this.#hasUpstream() ? this.#upstream : null;
  }

  get active() {
    return this.#upstream.active;
  }

  constructor(options = {}) {
    super();
    const { callTimeout, sweepInterval } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (sweepInterval) this.#sweepInterval = sweepInterval;
    this.#localStreams = options.localStreams ?? false;
    this.#getClients = options.getClients ?? null;
    this.#upstream = this.#createUpstream(options);
  }

  #createUpstream(options) {
    const url = options.url;
    if (!url && !options.upstream) return NO_UPSTREAM;
    const queueSize = options.queueSize ?? PROXY_QUEUE_SIZE;
    const upstreamOptions = { ...options, queueSize };
    const proxy = {
      packet: (packet, data) => this.#route(packet, data),
      binary: (id, data) => this.#routeBinary(id, data),
    };
    const server = options.upstream ?? Metacom.create(url, upstreamOptions);
    server.setProxy(proxy);
    server.on('open', () => this.#notify(true));
    server.on('close', () => {
      this.#abortStreams();
      this.#notify(false);
    });
    server.on('error', (error) => this.#escalate(error));
    return server;
  }

  #hasUpstream() {
    return this.#upstream !== NO_UPSTREAM;
  }

  async open() {
    if (!this.#hasUpstream() || this.#upstream.active) return;
    this.#connecting = !this.#attempted;
    try {
      await this.#upstream.open();
    } finally {
      this.#connecting = false;
      this.#attempted = true;
      if (!this.#upstream.active) this.#describePending();
    }
  }

  close() {
    const ids = Array.from(this.#peers.keys());
    for (let i = 0; i < ids.length; i++) this.detach(ids[i]);
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#calls.clear();
    this.#streams.clear();
    this.#upstream.close();
  }

  // Local method shadows server method with the same name
  register(unit, methods) {
    registerUnit(this.#units, unit, methods);
  }

  broadcast(name, data) {
    this.#post(encodeEvent(name, data));
  }

  #escalate(error) {
    emitError(this, error);
  }

  port(id) {
    return this.#peers.get(id);
  }

  attach(port, options = {}) {
    if (!port) return;
    const id = options.id ?? generateUUID();
    const clientId = options.clientId ?? '';
    const callTimeout = options.callTimeout ?? this.#callTimeout;
    this.detach(id);
    const client = new RouterClient(id, port, this);
    const units = new Set();
    this.#ports.set(port, { id, clientId, callTimeout, client, units });
    if (id) this.#peers.set(id, port);
    port.addEventListener('message', ({ data }) => {
      this.receive(port, data);
    });
    port.start();
    const instance = this.#instance;
    const connected = this.#upstream.active;
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
    const { id, client } = this.#ports.get(port);
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
      if (stream.readable) {
        stream.readable.terminate().catch((error) => this.#escalate(error));
      }
      const isUploading = stream.upload && stream.expires === 0;
      if (isUploading) this.#terminateUpload(streamId);
    }
    port.close();
    client.emit('close').catch((error) => this.#escalate(error));
    this.emit('disconnect', id);
  }

  #terminateUpload(id) {
    if (!this.#upstream.active) return;
    this.#upstream.send({ type: 'stream', id, status: 'terminate' });
  }

  #startSweep() {
    if (this.#sweepTimer) return;
    const sweep = () => this.#sweep();
    this.#sweepTimer = startInterval(sweep, this.#sweepInterval);
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
      const { clientId } = entry[1];
      const isClosed = clientId !== '' && !alive.has(clientId);
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

  #publish(name, data) {
    if (typeof name !== 'string') return;
    const { unit } = parseMethod(name);
    for (const entry of this.#ports) {
      if (entry[1].units.has(unit)) entry[0].postMessage(data);
    }
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
    if (!isId(id)) return void sendError(port, '', BAD_REQUEST);
    if (type === 'call') return void this.#dispatchCall(port, packet, data);
    if (type === 'stream') return void this.#forwardStream(port, packet, data);
    if (type === 'metacom:stream') return void this.#expectStream(port, id);
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
    const handler = this.#units.get(unit)?.get(name);
    if (handler) return void this.#invoke(port, packet, handler);
    this.#forwardCall(port, id, data, null);
  }

  async #invoke(port, packet, handler) {
    const { id, args } = packet;
    const context = new ProxyContext(this.server, port, this.#ports);
    try {
      const result = await handler(args, context);
      if (this.#ports.has(port)) port.postMessage(encodeCallback(id, result));
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : 500;
      this.#replyError(port, id, error.message, code);
    }
  }

  #replyError(port, id, message, code) {
    if (this.#ports.has(port)) sendError(port, id, { message, code });
  }

  // Offline tab gets local and cached methods, the rest after reconnect
  #introspect(port, packet, data) {
    const { id, args } = packet;
    const units = Array.isArray(args) ? args : [];
    const loaded = this.#ports.get(port).units;
    for (let i = 0; i < units.length; i++) loaded.add(units[i]);
    const isReachable = this.#upstream.active || this.#connecting;
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
    if (this.#calls.has(id)) return void sendError(port, id, DUPLICATE_CALL);
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + callTimeout;
    this.#calls.set(id, { port, expires, units });
    if (this.#deliver(data, callTimeout)) return;
    this.#calls.delete(id);
    sendError(port, id, SERVICE_UNAVAILABLE);
  }

  // Upstream without a queue throws while disconnected
  #deliver(data, timeout) {
    try {
      return this.#upstream.deliver(data, timeout);
    } catch {
      return false;
    }
  }

  // Finished upload keeps its route for a while to pass server errors
  #forwardStream(port, packet, data) {
    const { id, status } = packet;
    if (this.#localStreams) return void this.#localStream(port, packet, data);
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (!this.#upstream.active) {
      this.#streams.delete(id);
      return void sendError(port, id, SERVICE_UNAVAILABLE);
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = status === undefined ? 0 : Date.now() + callTimeout;
    this.#streams.set(id, createRoute(port, true, expires));
    this.#upstream.write(data);
  }

  getStream(port, id) {
    const stream = this.#streams.get(id);
    const isOwned = stream?.port === port && stream.upload;
    if (!isOwned || stream.forwarded) {
      throw new Error('Local stream is not available');
    }
    stream.local = true;
    const { name, size } = stream.packet;
    stream.readable ??= new MetaReadable(id, name, size);
    return stream.readable;
  }

  createStream(port, name, size, id = generateUUID()) {
    if (!this.#ports.has(port)) throw new Error('Peer disconnected');
    const existing = this.#streams.get(id);
    if (existing && (existing.port !== port || existing.upload)) {
      throw new Error('Stream id already in use');
    }
    if (!isStreamMeta(name, size)) {
      throw new TypeError('Invalid stream metadata');
    }
    this.#streams.set(id, createRoute(port, false, 0));
    const transport = {
      send: (packet) => {
        if (!this.#ports.has(port)) return;
        port.postMessage(JSON.stringify(packet));
        if (packet.status) this.#streams.delete(id);
      },
      write: (data) => {
        if (!this.#ports.has(port)) throw new Error('Peer disconnected');
        return port.postMessage(data);
      },
      drain: () => port.drain?.() ?? Promise.resolve(),
    };
    return new MetaWritable(id, name, size, transport);
  }

  #localStream(port, packet, data) {
    const { id, name, size, status } = packet;
    let stream = this.#streams.get(id);
    if (stream && stream.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (status === undefined) {
      if (stream || !isStreamMeta(name, size)) {
        return void sendError(port, id, BAD_REQUEST);
      }
      stream = createRoute(port, true, Date.now() + this.#callTimeout);
      stream.packet = packet;
      stream.init = data;
      this.#streams.set(id, stream);
      return;
    }
    if (!stream?.upload || !FINAL_STATUSES.includes(status)) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (stream.local || !this.#hasUpstream()) {
      const readable = this.getStream(port, id);
      const isEnd = status === 'end';
      const finishing = isEnd ? readable.close() : readable.terminate();
      finishing.catch((error) => {
        this.#replyError(port, id, error.message, 400);
      });
      this.#streams.delete(id);
      return;
    }
    if (!this.#forwardUpload(port, id, stream, data)) return;
    stream.expires = Date.now() + this.#callTimeout;
  }

  // Upload not claimed by a local handler goes upstream, its init first
  #forwardUpload(port, id, stream, data) {
    if (!this.#upstream.active) {
      sendError(port, id, SERVICE_UNAVAILABLE);
      return false;
    }
    if (!stream.forwarded) this.#upstream.write(stream.init);
    stream.forwarded = true;
    this.#upstream.write(data);
    return true;
  }

  #localChunk(port, data) {
    const { id, payload } = chunkDecode(data);
    const stream = this.#streams.get(id);
    if (!stream?.upload || stream.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    stream.expires = 0;
    if (stream.local || !this.#hasUpstream()) {
      const readable = this.getStream(port, id);
      readable.push(payload).catch((error) => {
        this.#replyError(port, id, error.message, 400);
      });
      return;
    }
    this.#forwardUpload(port, id, stream, data);
  }

  #forwardChunk(port, data) {
    if (this.#localStreams) return void this.#localChunk(port, data);
    if (!this.#upstream.active) return;
    const { id } = chunkDecode(data);
    const stream = this.#streams.get(id);
    if (stream?.port !== port || !stream.upload) {
      return void sendError(port, id, BAD_REQUEST);
    }
    this.#upstream.write(data);
  }

  // Tab creates download stream id before the call that fills the stream
  #expectStream(port, id) {
    if (!isId(id)) return;
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) return;
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + 2 * callTimeout;
    this.#streams.set(id, createRoute(port, false, expires));
  }

  #route(packet, data) {
    const { type, id } = packet;
    if (type === 'event') return void this.#publish(packet.name, data);
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
      if (upload) sendError(port, id, SERVICE_UNAVAILABLE);
      else sendTerminate(port, id);
      this.#streams.delete(id);
    }
  }
}

module.exports = { MetacomRouter };
