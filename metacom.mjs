import { Emitter, generateUUID, jsonParse } from './metautil.js';

// chunks-browser.js

const ID_LENGTH_BYTES = 1;

const chunkEncode = (id, payload) => {
  const encoder = new TextEncoder();
  const idBuffer = encoder.encode(id);
  const idLength = idBuffer.length;
  if (idLength > 255) {
    throw new Error(`ID length ${idLength} exceeds maximum of 255 characters`);
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
    await this.stop();
    this.status = 'closed';
  }

  async terminate() {
    await this.stop();
    this.status = 'terminated';
  }

  async stop() {
    while (this.bytesRead !== this.size) {
      await this.waitEvent(PULL_EVENT);
    }
    this.streaming = false;
    this.emit(PUSH_EVENT, null);
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
    return new Promise((resolve) => this.once(event, resolve));
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

const CALL_TIMEOUT = 7 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const toByteView = async (input) => {
  if (typeof input.arrayBuffer === 'function') {
    const buffer = await input.arrayBuffer();
    return new Uint8Array(buffer);
  }
  return new Uint8Array(input);
};

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomUnit extends Emitter {
  emit(...args) {
    super.emit('*', ...args);
    super.emit(...args);
  }

  post(...args) {
    super.emit(...args);
  }
}

class ClientTransport extends Emitter {
  active = false;
  connected = false;
  opening = null;

  constructor(url) {
    super();
    this.url = url;
  }

  send(data) {
    const payload = JSON.stringify(data);
    this.write(payload);
  }
}

class Metacom extends Emitter {
  static connections = new Set();
  static isOnline = true;

  static online() {
    Metacom.isOnline = true;
    for (const connection of Metacom.connections) {
      connection.transport.online?.();
      if (!connection.connected && connection.active) {
        connection.open().catch((error) => connection.emit('error', error));
      }
    }
  }

  static offline() {
    Metacom.isOnline = false;
    for (const connection of Metacom.connections) {
      connection.transport.offline?.();
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

  transport = null;
  api = {};
  calls = new Map();
  streams = new Map();
  callTimeout = CALL_TIMEOUT;
  reconnectTimeout = RECONNECT_TIMEOUT;
  generateId = generateUUID;
  reconnectTimer = null;
  openOptions = {};

  get active() {
    return this.transport.active;
  }

  get connected() {
    return this.transport.connected;
  }

  get opening() {
    return this.transport.opening;
  }

  constructor(url, transport, options = {}) {
    super();
    const { callTimeout, reconnectTimeout, generateId } = options;
    if (callTimeout) this.callTimeout = callTimeout;
    if (reconnectTimeout) this.reconnectTimeout = reconnectTimeout;
    if (generateId) this.generateId = generateId;
    this.url = url;
    this.transport = transport;
    this.bindTransport();
  }

  static create(url, options = {}) {
    if (options.worker) {
      const transport = Metacom.transport.event.getInstance(url);
      const metacom = new Metacom(url, transport, options);
      metacom.open(options).catch((error) => metacom.emit('error', error));
      return metacom;
    }

    const isHttp = url.startsWith('http');
    const Transport = isHttp ? Metacom.transport.http : Metacom.transport.ws;
    const transport = new Transport(url);
    const metacom = new Metacom(url, transport, options);
    metacom.open(options).catch((error) => metacom.emit('error', error));
    return metacom;
  }

  bindTransport() {
    this.transport.on('open', () => {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.emit('open');
    });

    this.transport.on('close', () => {
      this.emit('close');
      this.scheduleReconnect();
    });

    this.transport.on('error', (error) => {
      this.emit('error', error);
    });

    this.transport.on('message', (data) => {
      const isBinary = typeof data !== 'string';
      const processed = isBinary ? this.binary(data) : this.handlePacket(data);
      processed.catch((error) => this.emit('error', error));
    });
  }

  scheduleReconnect() {
    if (!this.active) return;
    if (this.connected) return;
    if (!Metacom.isOnline) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.active || this.connected) return;
      this.open().catch((error) => this.emit('error', error));
    }, this.reconnectTimeout);
  }

  open(options = this.openOptions) {
    this.openOptions = { ...this.openOptions, ...options };
    this.transport.active = true;
    Metacom.connections.add(this);
    if (!Metacom.isOnline) return Promise.resolve();
    return this.transport.open(this.openOptions);
  }

  close() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    Metacom.connections.delete(this);
    this.transport.close();
  }

  write(data) {
    this.transport.write(data);
  }

  send(data) {
    this.transport.send(data);
  }

  getStream(id) {
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = this.generateId();
    return new MetaWritable(id, name, size, this);
  }

  createBlobUploader(blob) {
    const name = blob.name || 'blob';
    const size = blob.size;
    const consumer = this.createStream(name, size);
    return {
      id: consumer.id,
      upload: async () => {
        for await (const chunk of blob.stream()) {
          consumer.write(chunk);
        }
        consumer.end();
      },
    };
  }

  async handlePacket(data) {
    const packet = jsonParse(data);
    if (!packet) throw new Error('Invalid JSON packet');
    const { type, id, name } = packet;
    if (type === 'event') {
      const parts = name.split('/');
      const unit = parts[0];
      const eventName = parts[1];
      const metacomUnit = this.api[unit];
      if (metacomUnit) metacomUnit.emit(eventName, packet.data);
      return;
    }
    if (!id) throw new Error('Packet structure error');
    if (type === 'callback') {
      const promised = this.calls.get(id);
      if (!promised) throw new Error(`Callback ${id} not found`);
      const resolve = promised[0];
      const reject = promised[1];
      const timeout = promised[2];
      this.calls.delete(id);
      clearTimeout(timeout);
      if (packet.error) {
        return void reject(new MetacomError(packet.error));
      }
      resolve(packet.result);
      return;
    }
    if (type !== 'stream') return;
    const { size, status } = packet;
    const stream = this.streams.get(id);
    if (status === undefined) {
      if (typeof name !== 'string') {
        throw new Error('Stream name must be string');
      }
      if (name.length === 0) {
        throw new Error('Stream name must be non-empty');
      }
      if (!Number.isSafeInteger(size)) {
        throw new Error('Stream size must be safe integer');
      }
      if (stream) {
        throw new Error(`Stream ${name} is already initialized`);
      }
      const readableStream = new MetaReadable(id, name, size);
      this.streams.set(id, readableStream);
      return;
    }
    if (!stream) {
      throw new Error(`Stream ${id} is not initialized`);
    }
    if (status === 'end') {
      await stream.close();
      this.streams.delete(id);
      return;
    }
    if (status === 'terminate') {
      await stream.terminate();
      this.streams.delete(id);
      return;
    }
    throw new Error('Stream packet structure error');
  }

  async binary(input) {
    const byteView = await toByteView(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.streams.get(id);
    if (!stream) {
      throw new Error(`Stream ${id} is not initialized`);
    }
    await stream.push(payload);
  }

  async load(...units) {
    const introspect = this.scaffold('system')('introspect');
    const introspection = await introspect(units);
    const available = Object.keys(introspection);
    for (const unit of units) {
      if (!available.includes(unit)) continue;
      const methods = new MetacomUnit();
      const instance = introspection[unit];
      const request = this.scaffold(unit);
      const methodNames = Object.keys(instance);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[unit] = methods;
    }
  }

  scaffold(unit, ver) {
    const createMethod = (methodName) => {
      const method = async (args = {}) => {
        const id = this.generateId();
        const unitName = `${unit}${ver ? `.${ver}` : ''}`;
        const target = `${unitName}/${methodName}`;
        if (this.opening) await this.opening;
        const packet = { type: 'call', id, method: target, args };
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!this.calls.has(id)) return;
            this.calls.delete(id);
            reject(new Error('Request timeout'));
          }, this.callTimeout);
          this.calls.set(id, [resolve, reject, timeout]);
          this.send(packet);
        });
      };
      return method;
    };
    return createMethod;
  }
}

class ClientWsTransport extends ClientTransport {
  socket = null;

  async open() {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      this.emit('message', data);
    });

    socket.addEventListener('close', () => {
      this.opening = null;
      this.connected = false;
      this.socket = null;
      this.emit('close');
    });

    socket.addEventListener('error', (error) => {
      this.emit('error', error);
      socket.close();
    });

    this.opening = new Promise((resolve) => {
      socket.addEventListener('open', () => {
        this.opening = null;
        this.connected = true;
        this.emit('open');
        resolve();
      });
    });

    return this.opening;
  }

  close() {
    this.active = false;
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  write(data) {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected');
    }
    this.socket.send(data);
  }
}

class ClientHttpTransport extends ClientTransport {
  async open() {
    if (this.connected) return Promise.resolve();
    this.active = true;
    this.connected = true;
    this.emit('open');
    return Promise.resolve();
  }

  close() {
    if (!this.active && !this.connected) return;
    this.active = false;
    this.connected = false;
    this.emit('close');
  }

  write(data) {
    const headers = { 'Content-Type': 'application/json' };
    fetch(this.url, { method: 'POST', headers, body: data })
      .then((res) => res.text())
      .then((packet) => this.emit('message', packet))
      .catch((error) => this.emit('error', error));
  }
}

class ClientEventTransport extends ClientTransport {
  static instance = null;

  messagePort = null;
  worker = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  async open(options = {}) {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const worker = options.worker || this.worker;
    if (!worker) throw new Error('Service Worker not provided');
    this.active = true;
    this.worker = worker;
    this.opening = new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      this.messagePort = port1;
      port1.addEventListener('message', ({ data }) => {
        if (data === undefined) return;
        this.emit('message', data);
      });
      port1.start();
      this.worker.postMessage({ type: 'metacom:connect' }, [port2]);
      this.connected = true;
      this.opening = null;
      this.emit('open');
      resolve();
    });
    return this.opening;
  }

  close() {
    this.active = false;
    this.connected = false;
    this.opening = null;
    if (this.messagePort) {
      this.messagePort.close?.();
      this.messagePort = null;
    }
    this.emit('close');
  }

  online() {
    if (this.worker) this.worker.postMessage({ type: 'metacom:online' });
  }

  offline() {
    if (this.worker) this.worker.postMessage({ type: 'metacom:offline' });
  }

  write(data) {
    if (!this.messagePort) throw new Error('Not connected');
    this.messagePort.postMessage(data);
  }
}

class MetacomProxy extends Emitter {
  ports = new Set();
  pending = new Map();
  connection = null;
  callTimeout = CALL_TIMEOUT;
  reconnectTimeout = RECONNECT_TIMEOUT;
  generateId = generateUUID;

  constructor(options = {}) {
    super();
    const { callTimeout, reconnectTimeout, generateId } = options;
    if (callTimeout) this.callTimeout = callTimeout;
    if (reconnectTimeout) this.reconnectTimeout = reconnectTimeout;
    if (generateId) this.generateId = generateId;
    if (typeof self === 'undefined') {
      throw new Error('MetacomProxy must run in ServiceWorker context');
    }
    self.addEventListener('message', (event) => {
      const { type } = event.data;
      if (type?.startsWith('metacom')) this.handleEvent(event);
    });
  }

  async open(options = {}) {
    if (this.connection) {
      if (this.connection.connected) return Promise.resolve();
      return this.connection.open(options);
    }
    const protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${self.location.host}`;
    const transport = new ClientWsTransport(url);
    const metacomOptions = {
      callTimeout: this.callTimeout,
      reconnectTimeout: this.reconnectTimeout,
      generateId: this.generateId,
    };
    this.connection = new Metacom(url, transport, metacomOptions);
    this.connection.handlePacket = async (data) => this.handlePacket(data);
    this.connection.binary = async (input) => {
      const data = await toByteView(input);
      this.handlePacket(data);
    };
    return this.connection.open(options);
  }

  close() {
    if (!this.connection) return;
    this.connection.close();
    this.connection = null;
  }

  async handleEvent(event) {
    const { type } = event.data;
    if (type === 'metacom:connect') {
      const port = event.ports[0];
      if (!port) throw new Error('MessagePort not provided');
      this.ports.add(port);
      port.addEventListener('message', (messageEvent) => {
        this.handleMessage(messageEvent, port);
      });
      port.start();
      return;
    }
    if (type === 'metacom:online') {
      Metacom.online();
      return;
    }
    if (type === 'metacom:offline') {
      Metacom.offline();
    }
  }

  async handleMessage(event, port) {
    const { data } = event;
    if (data === undefined) throw new Error('Message data is undefined');
    await this.open();
    if (!this.connection || !this.connection.connected) {
      throw new Error('Not connected to server');
    }
    const packet = jsonParse(data);
    if (!packet || !packet.id) throw new Error('Invalid JSON packet');
    this.pending.set(packet.id, port);
    this.connection.write(data);
  }

  handlePacket(data) {
    const packet = jsonParse(data);
    if (!packet) {
      this.broadcast(data);
      return;
    }
    const { type, id, status } = packet;
    if (type === 'event') {
      this.broadcast(data);
      return;
    }
    const port = this.pending.get(id);
    if (!port) {
      this.broadcast(data);
      return;
    }
    port.postMessage(data);
    const isCallback = type === 'callback';
    const isStreamEnd = type === 'stream' && status === 'end';
    const isStreamTerminate = type === 'stream' && status === 'terminate';
    if (isCallback || isStreamEnd || isStreamTerminate) {
      this.pending.delete(id);
    }
  }

  broadcast(data, excludePort = null) {
    for (const port of this.ports) {
      if (port === excludePort) continue;
      port.postMessage(data);
    }
  }
}

Metacom.transport = {
  ws: ClientWsTransport,
  http: ClientHttpTransport,
  event: ClientEventTransport,
};

Metacom.initialize();

export {
  chunkEncode,
  chunkDecode,
  MetaReadable,
  MetaWritable,
  Metacom,
  MetacomUnit,
  MetacomProxy,
};
