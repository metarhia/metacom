import { Emitter, generateUUID, jsonParse } from './metautil.js';

// client-transport.js

class ClientTransport extends Emitter {
  active = false;

  constructor(url) {
    super();
    this.url = url;
  }

  send(obj) {
    this.write(JSON.stringify(obj));
  }

  // eslint-disable-next-line class-methods-use-this
  announce() {}
  // eslint-disable-next-line class-methods-use-this
  online() {}
  // eslint-disable-next-line class-methods-use-this
  offline() {}
}

// client-ws.js

const { WebSocket } = globalThis;

class ClientWsTransport extends ClientTransport {
  #socket = null;
  #opening = null;

  async open() {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.#socket = socket;
      const onClose = (error) => {
        this.#socket = null;
        if (this.#opening) {
          this.#opening = null;
          return void reject(new Error('Connection closed'));
        }
        this.active = false;
        this.emit('close', error);
      };
      const onOpen = () => {
        this.active = true;
        this.emit('open');
        this.#opening = null;
        resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('error', onClose, { once: true });
      socket.addEventListener('message', ({ data }) => {
        this.emit('message', data);
      });
    });
    this.#opening = opening;
    return opening;
  }

  close() {
    if (!this.active) return;
    this.#socket.close();
  }

  write(data) {
    if (!this.active) throw new Error('Not connected');
    this.#socket.send(data);
  }
}

// client-http.js

class ClientHttpTransport extends ClientTransport {
  async open() {
    if (this.active) return;
    this.active = true;
    this.emit('open');
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.emit('close');
  }

  write(data) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: data };
    const send = async () => {
      try {
        const response = await fetch(this.url, options);
        const packet = await response.text();
        this.emit('message', packet);
      } catch (error) {
        this.emit('error', error);
      }
    };
    send();
  }
}

// client-event.js

class ClientEventTransport extends ClientTransport {
  static instance = null;

  #port = null;
  #worker = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  async open(options = {}) {
    if (this.active) return;
    const worker = options.worker ?? this.#worker;
    if (!worker) throw new Error('Service Worker not provided');
    this.#worker = worker;
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    port1.addEventListener('message', ({ data }) => {
      if (data === undefined) return;
      const isPacket = typeof data === 'string' || ArrayBuffer.isView(data);
      if (isPacket) this.emit('message', data);
      else this.#handleControl(data);
    });
    port1.start();
    const { callTimeout } = options;
    const message = { type: 'metacom:connect', callTimeout };
    this.#worker.postMessage(message, [port2]);
    this.active = true;
    this.emit('open');
  }

  #handleControl({ type, connected }) {
    if (type === 'metacom:status') this.emit('status', { connected });
  }

  close() {
    if (!this.#port) return;
    this.active = false;
    this.#port.close();
    this.#port = null;
    this.emit('close');
  }

  announce(id) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage({ type: 'metacom:stream', id });
  }

  online() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:online' });
  }

  offline() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:offline' });
  }

  write(data) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage(data);
  }
}

// chunks-browser.js

const ID_LENGTH_BYTES = 1;
const MAX_ID_LENGTH = 255;

const chunkEncode = (id, payload) => {
  const encoder = new TextEncoder();
  const idBuffer = encoder.encode(id);
  const idLength = idBuffer.length;
  if (idLength > MAX_ID_LENGTH) {
    const limit = `maximum of ${MAX_ID_LENGTH} characters`;
    throw new Error(`ID length ${idLength} exceeds ${limit}`);
  }
  const chunk = new Uint8Array(ID_LENGTH_BYTES + idLength + payload.length);
  chunk[0] = idLength;
  chunk.set(idBuffer, ID_LENGTH_BYTES);
  chunk.set(payload, ID_LENGTH_BYTES + idLength);
  return chunk;
};

const chunkDecode = (chunk) => {
  const idLength = chunk[0];
  const idBuffer = chunk.subarray(ID_LENGTH_BYTES, ID_LENGTH_BYTES + idLength);
  const decoder = new TextDecoder();
  const id = decoder.decode(idBuffer);
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};

// streams.js

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_LISTENERS = 10;
const MAX_HIGH_WATER_MARK = 1000;

class MetaReadable extends Emitter {
  queue = [];
  streaming = true;
  status = 'active';
  bytesRead = 0;
  highWaterMark = DEFAULT_HIGH_WATER_MARK;

  constructor(id, name, size, options = {}) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    const { highWaterMark } = options;
    if (highWaterMark) this.highWaterMark = highWaterMark;
  }

  async push(data) {
    while (this.queue.length > this.highWaterMark) {
      this.checkStreamLimits();
      await this.waitEvent(PULL_EVENT);
    }
    this.queue.push(data);
    if (this.queue.length === 1) this.emit(PUSH_EVENT);
    return data;
  }

  async finalize(writable) {
    const onError = () => this.terminate();
    writable.once('error', onError);
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await writable.waitEvent('drain');
    }
    this.emit('end');
    writable.end();
    await writable.waitEvent('close');
    await this.close();
    writable.removeListener('error', onError);
  }

  pipe(writable) {
    this.finalize(writable).catch((error) => this.emit('error', error));
    return writable;
  }

  async toBlob(type = '') {
    const chunks = [];
    for await (const chunk of this) {
      chunks.push(chunk);
    }
    return new Blob(chunks, { type });
  }

  async close() {
    await this.stop(false);
    this.status = 'closed';
  }

  async terminate() {
    await this.stop(true);
    this.status = 'terminated';
  }

  async stop(force = false) {
    if (!force) {
      while (this.streaming && this.bytesRead !== this.size) {
        await this.waitEvent(PULL_EVENT);
      }
    }
    this.streaming = false;
    this.queue.length = 0;
    this.emit(PUSH_EVENT, null);
    this.emit(PULL_EVENT);
  }

  async read() {
    if (this.queue.length > 0) return this.pull();
    const finisher = await this.waitEvent(PUSH_EVENT);
    if (finisher === null) return null;
    return this.pull();
  }

  pull() {
    const data = this.queue.shift();
    if (!data) return data;
    this.bytesRead += data.length;
    this.emit(PULL_EVENT);
    return data;
  }

  checkStreamLimits() {
    if (this.listenerCount(PULL_EVENT) >= MAX_LISTENERS) {
      ++this.highWaterMark;
    }
    if (this.highWaterMark > MAX_HIGH_WATER_MARK) {
      throw new Error('Stream overflow occurred');
    }
  }

  waitEvent(event) {
    return new Promise((resolve) => {
      this.once(event, resolve);
    });
  }

  async *[Symbol.asyncIterator]() {
    while (this.streaming) {
      const chunk = await this.read();
      if (!chunk) return;
      yield chunk;
    }
  }
}

class MetaWritable extends Emitter {
  constructor(id, name, size, transport) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    this.transport = transport;
    this.init();
  }

  init() {
    const { id, name, size } = this;
    const packet = { type: 'stream', id, name, size };
    this.transport.send(packet);
  }

  write(data) {
    const chunk = chunkEncode(this.id, data);
    this.transport.write(chunk);
    return true;
  }

  end() {
    const packet = { type: 'stream', id: this.id, status: 'end' };
    this.transport.send(packet);
  }

  terminate() {
    const packet = { type: 'stream', id: this.id, status: 'terminate' };
    this.transport.send(packet);
  }
}

// metacom.js

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
  static transport = {
    ws: ClientWsTransport,
    http: ClientHttpTransport,
    event: ClientEventTransport,
  };

  static online() {
    Metacom.isOnline = true;
    for (const connection of Metacom.connections) {
      connection.#transport.online();
      if (!connection.active) {
        connection.open().catch((error) => {
          connection.emit('error', error);
        });
      }
    }
  }

  static offline() {
    Metacom.isOnline = false;
    for (const connection of Metacom.connections) {
      connection.#transport.offline();
    }
  }

  static initialize() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', Metacom.online);
      window.addEventListener('offline', Metacom.offline);
      return;
    }
    if (typeof self !== 'undefined') {
      self.addEventListener('online', Metacom.online);
      self.addEventListener('offline', Metacom.offline);
    }
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
    const { callTimeout, reconnectTimeout, proxy } = options;
    const { queueSize, restore, generateId } = options;
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
    const escalate = (error) => this.emit('error', error);
    const report = (error) => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    };

    this.#transport.on('open', () => {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.emit('open');
      this.#resume().catch(escalate);
    });

    this.#transport.on('close', () => {
      this.emit('close');
      this.#scheduleReconnect();
    });

    this.#transport.on('error', escalate);

    this.#transport.on('status', (status) => {
      this.emit('status', status);
      if (status.connected) this.#refresh().catch(report);
    });

    this.#transport.on('message', (data) => {
      if (typeof data === 'string') this.#handlePacket(data).catch(escalate);
      else this.#handleBinary(data).catch(escalate);
    });
  }

  #scheduleReconnect() {
    if (this.active) return;
    if (!Metacom.connections.has(this)) return;
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.open().catch((error) => this.emit('error', error));
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

  // Send now or keep until connected, false when the queue is full
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
    const { name } = packet;
    const slash = name.indexOf('/');
    const unit = slash === -1 ? name : name.slice(0, slash);
    const eventName = slash === -1 ? '' : name.slice(slash + 1);
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
    if (status === 'end') {
      await stream.close();
      this.#streams.delete(id);
    } else if (status === 'terminate') {
      await stream.terminate();
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
    const createSystemMethod = this.#scaffold('system');
    const introspect = createSystemMethod('introspect');
    return introspect(units);
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
      const request = this.#scaffold(unit);
      const methodNames = Object.keys(introspection[unit]);
      for (let j = 0; j < methodNames.length; j++) {
        const methodName = methodNames[j];
        if (Object.hasOwn(methods, methodName)) continue;
        methods[methodName] = request(methodName);
      }
      this.api[unit] = methods;
    }
  }

  #call(id, data) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#calls.has(id)) return;
        this.#calls.delete(id);
        reject(new Error('Request timeout'));
      }, this.#callTimeout);
      this.#calls.set(id, { resolve, reject, timeout });
      const fail = (error) => {
        this.#calls.delete(id);
        clearTimeout(timeout);
        reject(error);
      };
      try {
        const isAccepted = this.#post(data);
        if (!isAccepted) fail(new MetacomError(QUEUE_OVERFLOW));
      } catch (error) {
        fail(error);
      }
    });
  }

  // Own calls skip the queue while the session is being restored
  #post(data) {
    if (!this.active) return this.deliver(data);
    this.#transport.write(data);
    return true;
  }

  #scaffold(unit, version) {
    const createMethod = (methodName) => {
      const suffix = version ? `.${version}` : '';
      const target = `${unit}${suffix}/${methodName}`;
      const method = async (args = {}) => {
        const id = this.#generateId();
        const packet = { type: 'call', id, method: target, args };
        const data = JSON.stringify(packet);
        return this.#call(id, data);
      };
      return method;
    };
    return createMethod;
  }
}

Metacom.initialize();

// proxy.js

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

const encodeEvent = (name, data) => {
  const packet = { type: 'event', name, data };
  return JSON.stringify(packet);
};

// Method format: unit/name or unit.version/name
const parseMethod = (method) => {
  const slash = method.indexOf('/');
  const target = slash === -1 ? method : method.slice(0, slash);
  const name = slash === -1 ? '' : method.slice(slash + 1);
  const dot = target.indexOf('.');
  const unit = dot === -1 ? target : target.slice(0, dot);
  return { unit, name };
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

class MetacomProxy extends Emitter {
  #ports = new Map();
  #calls = new Map();
  #streams = new Map();
  #units = new Map();
  #interfaces = new Map();
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
      const callback = { type: 'callback', id, result };
      port.postMessage(JSON.stringify(callback));
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : 500;
      sendError(port, id, { message: error.message, code });
    }
  }

  // Offline tab gets local and cached methods, the rest after reconnect
  #introspect(port, packet, data) {
    const { id, args } = packet;
    const units = Array.isArray(args) ? args : [];
    if (this.#server.active) {
      return void this.#forwardCall(port, id, data, units);
    }
    const callback = { type: 'callback', id, result: this.#describe(units) };
    port.postMessage(JSON.stringify(callback));
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
    const callback = { type: 'callback', id, result: this.#describe(units) };
    return JSON.stringify(callback);
  }

  #forwardCall(port, id, data, units) {
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
    for (const id of this.#streams.keys()) {
      const { port, expires, upload } = this.#streams.get(id);
      if (expires !== 0) continue;
      if (upload) sendError(port, id, UNAVAILABLE);
      else sendTerminate(port, id);
      this.#streams.delete(id);
    }
  }
}

export {
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  chunkEncode,
  chunkDecode,
  MetaReadable,
  MetaWritable,
  Metacom,
  MetacomError,
  MetacomProxy,
};
