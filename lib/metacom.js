'use strict';

const { Emitter, generateUUID, jsonParse, split } = require('metautil');

const { chunkDecode } = require('./chunks-node.js');
const { MetaReadable, MetaWritable } = require('./streams.js');
const { TRANSPORTS } = require('./client.js');

const CALL_TIMEOUT_MS = 7 * 1000;
const RECONNECT_TIMEOUT_MS = 2 * 1000;
const QUEUE_OVERFLOW = { message: 'Service Unavailable', code: 503 };

// Blob is the only input that can not be viewed synchronously
const toByteView = (input) => {
  if (input instanceof Uint8Array) return input;
  if (typeof input.arrayBuffer === 'function') return null;
  return new Uint8Array(input);
};

const readBlob = async (blob) => {
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
};

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class Metacom extends Emitter {
  static connections = new Set();
  static isOnline = true;
  static transport = TRANSPORTS;

  static online() {
    Metacom.isOnline = true;
    for (const connection of Metacom.connections) {
      connection.#transport.online();
      if (!connection.active) {
        connection.open().catch((error) => connection.#report(error));
      }
    }
  }

  static offline() {
    Metacom.isOnline = false;
    for (const connection of Metacom.connections) {
      connection.#transport.offline();
    }
  }

  // Page and worker both expose their global scope as self
  static initialize() {
    const scope = globalThis.self;
    if (!scope) return;
    scope.addEventListener('online', Metacom.online);
    scope.addEventListener('offline', Metacom.offline);
  }

  api = {};
  #transport = null;
  #calls = new Map();
  #streams = new Map();
  #expected = new Set();
  #units = new Set();
  #outbox = [];
  #queueSize = 0;
  #restore = null;
  #restoring = false;
  #generateId = generateUUID;
  #callTimeout = CALL_TIMEOUT_MS;
  #reconnectTimeout = RECONNECT_TIMEOUT_MS;
  #reconnectTimer = null;
  #proxy = null;
  #options = {};

  get active() {
    return this.#transport.active;
  }

  constructor(url, transport, options = {}) {
    super();
    const callTimeout = options.callTimeout;
    const reconnectTimeout = options.reconnectTimeout;
    const proxy = options.proxy;
    const queueSize = options.queueSize;
    const restore = options.restore;
    const generateId = options.generateId;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (reconnectTimeout) this.#reconnectTimeout = reconnectTimeout;
    if (proxy) this.#proxy = proxy;
    if (queueSize) this.#queueSize = queueSize;
    if (restore) this.#restore = restore;
    if (generateId) this.#generateId = generateId;
    this.url = url;
    this.#transport = transport;
    this.#options = options;
    this.#bindTransport();
  }

  static create(url, options = {}) {
    if (options.worker) {
      const transport = Metacom.transport.event.getInstance(url);
      return new Metacom(url, transport, options);
    }
    const isHttp = url.startsWith('http');
    const Transport = isHttp ? Metacom.transport.http : Metacom.transport.ws;
    const transport = new Transport(url);
    return new Metacom(url, transport, options);
  }

  static async connect(url, options = {}) {
    const metacom = Metacom.create(url, options);
    try {
      await metacom.open();
    } catch (error) {
      metacom.close();
      throw error;
    }
    return metacom;
  }

  #bindTransport() {
    const report = (error) => this.#report(error);

    this.#transport.on('open', () => {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.emit('open');
      this.#resume().catch(report);
    });

    this.#transport.on('close', () => {
      this.emit('close');
      this.#scheduleReconnect();
    });

    this.#transport.on('error', report);

    this.#transport.on('status', (status) => {
      this.emit('status', status);
      if (status.connected) this.#refresh().catch(report);
    });

    this.#transport.on('message', (data) => {
      if (typeof data === 'string') this.#handlePacket(data).catch(report);
      else this.#handleBinary(data).catch(report);
    });
  }

  // Emitter throws on error event without listeners
  #report(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  #scheduleReconnect() {
    if (this.active) return;
    if (!Metacom.connections.has(this)) return;
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.open().catch((error) => this.#report(error));
    }, this.#reconnectTimeout);
  }

  async open() {
    Metacom.connections.add(this);
    try {
      await this.#transport.open(this.#options);
    } catch (error) {
      this.#scheduleReconnect();
      throw error;
    }
  }

  close() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#outbox = [];
    Metacom.connections.delete(this);
    this.#transport.close();
  }

  write(data) {
    this.#transport.write(data);
  }

  send(data) {
    this.#transport.send(data);
  }

  deliver(data, timeout = this.#callTimeout) {
    const isReady = this.active && !this.#restoring;
    const isDirect = isReady || this.#queueSize === 0;
    if (isDirect) {
      this.#transport.write(data);
      return true;
    }
    if (this.#outbox.length >= this.#queueSize) this.#compact();
    if (this.#outbox.length >= this.#queueSize) return false;
    const expires = Date.now() + timeout;
    this.#outbox.push({ data, expires });
    return true;
  }

  #compact() {
    const now = Date.now();
    this.#outbox = this.#outbox.filter((entry) => entry.expires > now);
  }

  // Session is restored before queued packets reach the server
  async #resume() {
    this.#restoring = true;
    try {
      if (this.#restore) await this.#restore(this);
    } finally {
      this.#restoring = false;
      this.#flush();
    }
  }

  #flush() {
    const outbox = this.#outbox;
    if (outbox.length === 0) return;
    this.#outbox = [];
    const now = Date.now();
    for (let i = 0; i < outbox.length; i++) {
      const entry = outbox[i];
      if (entry.expires <= now) continue;
      if (this.active) this.#transport.write(entry.data);
      else this.#outbox.push(entry);
    }
  }

  getStream(id) {
    const stream = this.#streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = this.#generateId();
    return new MetaWritable(id, name, size, this);
  }

  // Stream id is created by the receiver and passed to the server in args
  createReadable() {
    const id = this.#generateId();
    const readable = new MetaReadable(id, '', 0);
    this.#streams.set(id, readable);
    this.#expected.add(id);
    this.#transport.announce(id);
    return readable;
  }

  createBlobUploader(blob) {
    const { name = 'blob', size } = blob;
    const consumer = this.createStream(name, size);
    const { id } = consumer;
    const upload = async () => {
      for await (const chunk of blob.stream()) {
        consumer.write(chunk);
      }
      consumer.end();
    };
    return { id, upload };
  }

  async #handlePacket(data) {
    const packet = jsonParse(data);
    if (!packet) throw new Error('Invalid JSON packet');
    const { type, id } = packet;
    const proxy = this.#proxy;
    if (type === 'event') {
      this.#handleEvent(packet);
      if (proxy) proxy.packet(packet, data);
      return;
    }
    if (!id) throw new Error('Packet structure error');
    if (type === 'callback') {
      const isForeign = proxy !== null && !this.#calls.has(id);
      if (isForeign) return void proxy.packet(packet, data);
      return void this.#handleCallback(packet);
    }
    if (type !== 'stream') return;
    const isForeign = proxy !== null && !this.#streams.has(id);
    if (isForeign) return void proxy.packet(packet, data);
    await this.#handleStream(packet);
  }

  #handleEvent(packet) {
    const route = split(packet.name, '/');
    const unit = route[0];
    const eventName = route[1];
    const metacomUnit = this.api[unit];
    if (metacomUnit) metacomUnit.emit(eventName, packet.data);
  }

  #handleCallback(packet) {
    const { id } = packet;
    const pending = this.#calls.get(id);
    if (!pending) throw new Error(`Callback ${id} not found`);
    const { resolve, reject, timeout } = pending;
    this.#calls.delete(id);
    clearTimeout(timeout);
    if (packet.error) return void reject(new MetacomError(packet.error));
    resolve(packet.result);
  }

  async #handleStream(packet) {
    const { id, name, size, status } = packet;
    const stream = this.#streams.get(id);
    if (status === undefined) {
      if (this.#expected.delete(id)) {
        stream.name = name;
        stream.size = size;
        return;
      }
      if (stream) {
        throw new Error(`Stream ${name} is already initialized`);
      }
      const readable = new MetaReadable(id, name, size);
      this.#streams.set(id, readable);
      return;
    }
    if (!stream) throw new Error(`Stream ${id} is not initialized`);
    const isEnd = status === 'end';
    if (!isEnd && status !== 'terminate') return;
    try {
      if (isEnd) await stream.close();
      else await stream.terminate();
    } finally {
      this.#streams.delete(id);
    }
  }

  async #handleBinary(input) {
    let byteView = toByteView(input);
    if (!byteView) byteView = await readBlob(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.#streams.get(id);
    if (!stream) {
      if (!this.#proxy) throw new Error(`Stream ${id} is not initialized`);
      return void this.#proxy.binary(id, byteView);
    }
    await stream.push(payload);
  }

  async load(...units) {
    if (!this.active) throw new Error('Not connected');
    const introspection = await this.#introspect(units);
    for (let i = 0; i < units.length; i++) this.#units.add(units[i]);
    this.#extend(introspection, units);
  }

  #introspect(units) {
    return this.#request('system/introspect', units);
  }

  // Server methods appear in loaded units after proxy reaches the server
  async #refresh() {
    if (this.#units.size === 0) return;
    const units = Array.from(this.#units);
    const introspection = await this.#introspect(units);
    this.#extend(introspection, units);
  }

  // Unit emitter is reused to keep event listeners
  #extend(introspection, units) {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!Object.hasOwn(introspection, unit)) continue;
      const methods = this.api[unit] ?? new Emitter();
      const methodNames = Object.keys(introspection[unit]);
      for (let j = 0; j < methodNames.length; j++) {
        const methodName = methodNames[j];
        if (Object.hasOwn(methods, methodName)) continue;
        const method = `${unit}/${methodName}`;
        methods[methodName] = async (args = {}) => this.#request(method, args);
      }
      this.api[unit] = methods;
    }
  }

  #request(method, args) {
    const id = this.#generateId();
    const packet = { type: 'call', id, method, args };
    const data = JSON.stringify(packet);
    const promise = this.#expect(id);
    try {
      const isAccepted = this.#post(data);
      if (!isAccepted) this.#fail(id, new MetacomError(QUEUE_OVERFLOW));
    } catch (error) {
      this.#fail(id, error);
    }
    return promise;
  }

  // Kept apart from #request so the pending timer does not retain data
  #expect(id) {
    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        this.#calls.delete(id);
        reject(new Error('Request timeout'));
      };
      const timeout = setTimeout(onTimeout, this.#callTimeout);
      this.#calls.set(id, { resolve, reject, timeout });
    });
  }

  #fail(id, error) {
    const { reject, timeout } = this.#calls.get(id);
    this.#calls.delete(id);
    clearTimeout(timeout);
    reject(error);
  }

  // Own calls skip the queue while the session is being restored
  #post(data) {
    if (!this.active) return this.deliver(data);
    this.#transport.write(data);
    return true;
  }
}

Metacom.initialize();

module.exports = { Metacom, MetacomError };
