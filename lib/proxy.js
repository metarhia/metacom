'use strict';

const { Emitter, jsonParse } = require('metautil');

const { Metacom } = require('./metacom.js');

const ROUTE_TIMEOUT_MS = 7 * 1000;
const SWEEP_INTERVAL_MS = 10 * 1000;
const PROXY_QUEUE_SIZE = 1000;
const CONTROL_PREFIX = 'metacom:';
const BAD_REQUEST = { message: 'Bad Request', code: 400 };
const UNAVAILABLE = { message: 'Service Unavailable', code: 503 };

const getWorkerUrl = () => {
  const { protocol, host } = self.location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}`;
};

const sendError = (port, id, error) => {
  const packet = { type: 'callback', id, error };
  port.postMessage(JSON.stringify(packet));
};

const sendTerminate = (port, id) => {
  const packet = { type: 'stream', id, status: 'terminate' };
  port.postMessage(JSON.stringify(packet));
};

class MetacomProxy extends Emitter {
  #ports = new Map();
  #calls = new Map();
  #streams = new Map();
  #server = null;
  #callTimeout = ROUTE_TIMEOUT_MS;
  #sweepInterval = SWEEP_INTERVAL_MS;
  #sweepTimer = null;

  get server() {
    return this.#server;
  }

  get active() {
    return this.#server.active;
  }

  constructor(options = {}) {
    super();
    if (typeof self === 'undefined') {
      throw new Error('MetacomProxy must run in ServiceWorker context');
    }
    const { callTimeout, sweepInterval } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (sweepInterval) this.#sweepInterval = sweepInterval;
    this.#server = this.#createServer(options);
    self.addEventListener('message', (event) => {
      const type = event.data?.type;
      const isControl = typeof type === 'string';
      if (isControl && type.startsWith(CONTROL_PREFIX)) this.#control(event);
    });
  }

  #createServer(options) {
    const url = options.url ?? getWorkerUrl();
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
    await this.#server.open();
  }

  close() {
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#calls.clear();
    this.#streams.clear();
    this.#server.close();
  }

  #escalate(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  #control(event) {
    const { type } = event.data;
    if (type === 'metacom:connect') this.#connect(event);
    else if (type === 'metacom:online') Metacom.online();
    else if (type === 'metacom:offline') Metacom.offline();
  }

  #connect(event) {
    const port = event.ports[0];
    if (!port) return;
    const callTimeout = event.data.callTimeout ?? this.#callTimeout;
    this.#ports.set(port, { callTimeout });
    port.addEventListener('message', ({ data }) => {
      this.#receive(port, data);
    });
    port.start();
    const connected = this.#server.active;
    port.postMessage({ type: 'metacom:status', connected });
    this.#startSweep();
    if (!connected) this.open().catch((error) => this.#escalate(error));
  }

  #startSweep() {
    if (this.#sweepTimer) return;
    const timer = setInterval(() => this.#sweep(), this.#sweepInterval);
    if (typeof timer.unref === 'function') timer.unref();
    this.#sweepTimer = timer;
  }

  #sweep() {
    const now = Date.now();
    for (const id of this.#calls.keys()) {
      const call = this.#calls.get(id);
      if (call.expires <= now) this.#calls.delete(id);
    }
    for (const id of this.#streams.keys()) {
      const { expires } = this.#streams.get(id);
      const isExpired = expires !== 0 && expires <= now;
      if (isExpired) this.#streams.delete(id);
    }
  }

  #notify(connected) {
    const message = { type: 'metacom:status', connected };
    for (const port of this.#ports.keys()) port.postMessage(message);
  }

  #post(data) {
    for (const port of this.#ports.keys()) port.postMessage(data);
  }

  #receive(port, data) {
    const peer = this.#ports.get(port);
    if (!peer) return;
    if (typeof data === 'string') return void this.#receivePacket(port, data);
    if (ArrayBuffer.isView(data)) return void this.#forwardChunk(data);
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
    if (type === 'call') return void this.#forwardCall(port, id, data);
    if (type === 'stream') return void this.#forwardStream(port, packet, data);
    sendError(port, id, BAD_REQUEST);
  }

  #forwardCall(port, id, data) {
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + callTimeout;
    this.#calls.set(id, { port, expires });
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
    if (!this.#server.active) {
      this.#streams.delete(id);
      return void sendError(port, id, UNAVAILABLE);
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = status === undefined ? 0 : Date.now() + callTimeout;
    this.#streams.set(id, { port, expires, upload: true });
    this.#server.write(data);
  }

  #forwardChunk(data) {
    if (this.#server.active) this.#server.write(data);
  }

  // Tab creates download stream id before the call that fills the stream
  #expectStream(port, id) {
    if (typeof id !== 'string' || id === '') return;
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + 2 * callTimeout;
    this.#streams.set(id, { port, expires, upload: false });
  }

  #route(packet, data) {
    const { type, id } = packet;
    if (type === 'event') return void this.#post(data);
    if (type === 'callback') return void this.#routeCallback(id, data);
    const stream = this.#streams.get(id);
    if (!stream) return;
    if (packet.status === undefined) stream.expires = 0;
    else this.#streams.delete(id);
    stream.port.postMessage(data);
  }

  // Server reports stream errors as callbacks with stream id
  #routeCallback(id, data) {
    const call = this.#calls.get(id);
    if (call) {
      this.#calls.delete(id);
      return void call.port.postMessage(data);
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
    for (const id of this.#streams.keys()) {
      const { port, expires, upload } = this.#streams.get(id);
      if (expires !== 0) continue;
      if (upload) sendError(port, id, UNAVAILABLE);
      else sendTerminate(port, id);
      this.#streams.delete(id);
    }
  }
}

module.exports = { MetacomProxy };
