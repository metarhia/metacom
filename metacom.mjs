import { Emitter, generateUUID, delay, jsonParse, split } from './metautil.js';

// client.js

const { WebSocket } = globalThis;

const PING_INTERVAL_MS = 20 * 1000;
const PONG_TIMEOUT_MS = 5 * 1000;
const HANDSHAKE_TIMEOUT_MS = 5 * 1000;
const BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_INTERVAL_MS = 10;

const startInterval = (listener, interval) => {
  const timer = setInterval(listener, interval);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

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
  drain() {
    return Promise.resolve();
  }

  // eslint-disable-next-line class-methods-use-this
  announce() {}
  // eslint-disable-next-line class-methods-use-this
  online() {}
  // eslint-disable-next-line class-methods-use-this
  offline() {}
}

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
      // Error is always followed by close, listening to both emits twice
      const onClose = (event) => {
        this.#socket = null;
        if (this.#opening) {
          this.#opening = null;
          return void reject(new Error('Connection closed'));
        }
        this.active = false;
        this.emit('close', event);
      };
      const onOpen = () => {
        this.active = true;
        this.emit('open');
        this.#opening = null;
        resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('close', onClose, { once: true });
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
    return this.#socket.bufferedAmount < BUFFER_HIGH_WATER_BYTES;
  }

  // Browser WebSocket has no drain event, bufferedAmount is polled
  async drain() {
    while (this.#isBuffered()) await delay(DRAIN_INTERVAL_MS);
  }

  #isBuffered() {
    const socket = this.#socket;
    if (!socket) return false;
    return socket.bufferedAmount >= BUFFER_HIGH_WATER_BYTES;
  }
}

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
    this.#post(data);
  }

  // Failed request is answered with callback error to reject the call
  async #post(data) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: data };
    try {
      const response = await fetch(this.url, options);
      const type = response.headers.get('Content-Type') ?? '';
      if (type.startsWith('application/json')) {
        const packet = await response.text();
        return void this.emit('message', packet);
      }
      const message = response.statusText || 'Invalid response';
      const code = response.ok ? 502 : response.status;
      this.#reply(data, { message, code });
    } catch (error) {
      this.#reply(data, { message: error.message, code: 503 });
    }
  }

  #reply(data, error) {
    const request = jsonParse(data);
    const id = request?.id ?? '';
    const packet = { type: 'callback', id, error };
    this.emit('message', JSON.stringify(packet));
  }
}

class ClientEventTransport extends ClientTransport {
  static instance = null;

  #id = generateUUID();
  #port = null;
  #worker = null;
  #container = null;
  #instance = '';
  #opening = null;
  #handshake = null;
  #pingTimer = null;
  #pongTimer = null;
  #pingInterval = PING_INTERVAL_MS;
  #pongTimeout = PONG_TIMEOUT_MS;
  #handshakeTimeout = HANDSHAKE_TIMEOUT_MS;
  #onContainerMessage = null;
  #onControllerChange = null;
  #onPageHide = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  constructor(url) {
    super(url);
    this.#onContainerMessage = ({ data }) => {
      if (data?.type === 'metacom:reset') this.#drop();
    };
    // First claim reports the worker this tab is already connected to
    this.#onControllerChange = () => {
      const { controller } = this.#container;
      if (!controller || controller === this.#worker) return;
      this.#worker = controller;
      this.#drop();
    };
    this.#onPageHide = () => {
      this.#disconnect();
      this.#drop();
    };
  }

  async open(options = {}) {
    if (this.active) return;
    if (this.#opening) {
      await this.#opening;
      return;
    }
    this.#configure(options);
    if (!this.#worker) throw new Error('Service Worker not provided');
    this.#opening = this.#connect(options.callTimeout);
    try {
      await this.#opening;
    } finally {
      this.#opening = null;
    }
  }

  #configure(options) {
    const { pingInterval, pongTimeout, handshakeTimeout } = options;
    if (pingInterval) this.#pingInterval = pingInterval;
    if (pongTimeout) this.#pongTimeout = pongTimeout;
    if (handshakeTimeout) this.#handshakeTimeout = handshakeTimeout;
    const container = options.container ?? globalThis.navigator?.serviceWorker;
    this.#container = container ?? null;
    const worker = this.#worker ?? options.worker ?? null;
    const isStale = worker !== null && worker.state === 'redundant';
    const controller = this.#container ? this.#container.controller : null;
    this.#worker = isStale && controller ? controller : worker;
  }

  // Worker answers with metacom:ready when it holds the other port
  #connect(callTimeout) {
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      this.#port = port1;
      port1.addEventListener('message', ({ data }) => {
        if (this.#port === port1) this.#receive(data);
      });
      port1.start();
      const timer = setTimeout(() => {
        this.#reject(new Error('Service Worker handshake timeout'));
        this.#release();
      }, this.#handshakeTimeout);
      this.#handshake = { resolve, reject, timer };
      const message = { type: 'metacom:connect', id: this.#id, callTimeout };
      this.#worker.postMessage(message, [port2]);
    });
  }

  #receive(data) {
    if (data === undefined) return;
    const isPacket = typeof data === 'string' || ArrayBuffer.isView(data);
    if (isPacket) return void this.emit('message', data);
    const { type } = data;
    if (type === 'metacom:ready') this.#accept(data);
    else if (type === 'metacom:pong') this.#alive(data.instance);
    else if (type === 'metacom:status') this.#report(data.connected);
  }

  #accept({ instance, connected }) {
    const handshake = this.#handshake;
    if (!handshake) return;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    this.#instance = instance;
    this.active = true;
    this.#bind();
    this.#pingTimer = startInterval(() => this.#ping(), this.#pingInterval);
    this.emit('open');
    handshake.resolve();
    this.#report(connected);
  }

  #reject(error) {
    const handshake = this.#handshake;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    handshake.reject(error);
  }

  #report(connected) {
    this.emit('status', { connected });
  }

  // Ping is posted to the worker itself to extend its lifetime
  #ping() {
    this.#worker.postMessage({ type: 'metacom:ping', id: this.#id });
    if (this.#pongTimer) return;
    this.#pongTimer = setTimeout(() => this.#drop(), this.#pongTimeout);
  }

  // Restarted worker has another instance id and no port of this tab
  #alive(instance) {
    clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
    if (instance !== this.#instance) this.#drop();
  }

  #bind() {
    const container = this.#container;
    if (container) {
      container.addEventListener('message', this.#onContainerMessage);
      container.addEventListener('controllerchange', this.#onControllerChange);
    }
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', this.#onPageHide);
  }

  #unbind() {
    const container = this.#container;
    if (container) {
      container.removeEventListener('message', this.#onContainerMessage);
      const onChange = this.#onControllerChange;
      container.removeEventListener('controllerchange', onChange);
    }
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.#onPageHide);
  }

  #release() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
    if (this.#handshake) this.#reject(new Error('Connection closed'));
    this.#unbind();
    if (this.#port) this.#port.close();
    this.#port = null;
    this.active = false;
  }

  // Connection to the worker is lost, Metacom reconnects on close
  #drop() {
    if (!this.active) return;
    this.#release();
    this.emit('close');
  }

  #disconnect() {
    this.#worker.postMessage({ type: 'metacom:disconnect', id: this.#id });
  }

  close() {
    if (!this.#port) return;
    const wasActive = this.active;
    this.#disconnect();
    this.#release();
    if (wasActive) this.emit('close');
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

const TRANSPORTS = {
  ws: ClientWsTransport,
  http: ClientHttpTransport,
  event: ClientEventTransport,
};

// chunks-browser.js

const ID_LENGTH_BYTES = 1;
const MAX_ID_LENGTH = 255;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const chunkEncode = (id, payload) => {
  const idBuffer = TEXT_ENCODER.encode(id);
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
  const id = TEXT_DECODER.decode(idBuffer);
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};

// streams.js

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_PENDING_PUSHES = 1000;

// Works for both node:stream Writable and metautil Emitter
const waitEvent = (emitter, eventName) => {
  const executor = (resolve) => emitter.once(eventName, resolve);
  return new Promise(executor);
};

class MetaReadable extends Emitter {
  queue = [];
  streaming = true;
  status = 'active';
  bytesRead = 0;
  highWaterMark = DEFAULT_HIGH_WATER_MARK;
  #pending = [];

  constructor(id, name, size, options = {}) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    const { highWaterMark } = options;
    if (highWaterMark) this.highWaterMark = highWaterMark;
  }

  // Chunks over highWaterMark wait in arrival order, pull moves them to queue
  async push(data) {
    if (this.queue.length <= this.highWaterMark) return this.#enqueue(data);
    if (this.#pending.length >= MAX_PENDING_PUSHES) {
      throw new Error('Stream overflow occurred');
    }
    return new Promise((resolve) => {
      this.#pending.push({ data, resolve });
    });
  }

  #enqueue(data) {
    this.queue.push(data);
    if (this.queue.length === 1) this.emit(PUSH_EVENT);
    return data;
  }

  async finalize(writable) {
    const onError = () => this.terminate();
    writable.once('error', onError);
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await waitEvent(writable, 'drain');
    }
    this.emit('end');
    writable.end();
    await waitEvent(writable, 'close');
    writable.off('error', onError);
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
    const { bytesRead, size } = this;
    const isComplete = bytesRead === size;
    this.status = isComplete ? 'closed' : 'terminated';
    if (isComplete) return;
    throw new Error(`Stream size mismatch: ${bytesRead} of ${size} bytes`);
  }

  async terminate() {
    await this.stop(true);
    this.status = 'terminated';
  }

  async stop(force = false) {
    if (!force) {
      while (this.streaming && this.queue.length > 0) {
        await this.toPromise(PULL_EVENT);
      }
    }
    this.streaming = false;
    this.queue.length = 0;
    const pending = this.#pending;
    this.#pending = [];
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      entry.resolve(entry.data);
    }
    this.emit(PUSH_EVENT, null);
    this.emit(PULL_EVENT);
  }

  async read() {
    if (this.queue.length > 0) return this.pull();
    const finisher = await this.toPromise(PUSH_EVENT);
    if (finisher === null) return null;
    return this.pull();
  }

  pull() {
    const data = this.queue.shift();
    if (!data) return data;
    this.bytesRead += data.length;
    const next = this.#pending.shift();
    if (next) next.resolve(this.#enqueue(next.data));
    this.emit(PULL_EVENT);
    return data;
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
  #draining = false;

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

  // Transport returns false when its buffer is full, undefined is writable
  write(data) {
    const chunk = chunkEncode(this.id, data);
    const isWritable = this.transport.write(chunk) !== false;
    if (!isWritable) this.#waitDrain();
    return isWritable;
  }

  async #waitDrain() {
    if (this.#draining) return;
    this.#draining = true;
    await this.transport.drain();
    this.#draining = false;
    this.emit('drain');
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
      this.#terminateStreams();
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

  // Server forgets streams on disconnect, expected ones wait for a call
  #terminateStreams() {
    for (const entry of this.#streams) {
      const id = entry[0];
      if (this.#expected.has(id)) continue;
      this.#streams.delete(id);
      entry[1].terminate().catch((error) => this.#report(error));
    }
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
    return this.#transport.write(data);
  }

  drain() {
    return this.#transport.drain();
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
        const isWritable = consumer.write(chunk);
        if (!isWritable) await consumer.toPromise('drain');
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

// proxy.js

const ROUTE_TIMEOUT_MS = 7 * 1000;
const SWEEP_INTERVAL_MS = 10 * 1000;
const PROXY_QUEUE_SIZE = 1000;
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

class MetacomProxy extends Emitter {
  #instance = generateUUID();
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
      if (event.data) this.#control(event);
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

  #control(event) {
    const { type, id } = event.data;
    if (type === 'metacom:connect') this.#connect(event);
    else if (type === 'metacom:ping') this.#pong(id, event.source);
    else if (type === 'metacom:disconnect') this.#disconnect(id);
    else if (type === 'metacom:online') Metacom.online();
    else if (type === 'metacom:offline') Metacom.offline();
  }

  #connect(event) {
    const port = event.ports[0];
    if (!port) return;
    const { id = '', callTimeout = this.#callTimeout } = event.data;
    const client = event.source ? event.source.id : '';
    this.#disconnect(id);
    this.#ports.set(port, { id, client, callTimeout });
    if (id) this.#peers.set(id, port);
    port.addEventListener('message', ({ data }) => {
      this.#receive(port, data);
    });
    port.start();
    const instance = this.#instance;
    const connected = this.#server.active;
    port.postMessage({ type: 'metacom:ready', instance, connected });
    this.#startSweep();
    this.emit('connect', id);
    if (!connected) this.open().catch((error) => this.#escalate(error));
  }

  // Unknown tab means the worker was restarted and lost its ports
  #pong(id, source) {
    const port = this.#peers.get(id);
    const instance = this.#instance;
    if (port) return void port.postMessage({ type: 'metacom:pong', instance });
    if (source) source.postMessage({ type: 'metacom:reset' });
  }

  #disconnect(id) {
    const port = this.#peers.get(id);
    if (port) this.#removePort(port);
  }

  #removePort(port) {
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
    const { clients } = self;
    if (!clients) return;
    const query = { includeUncontrolled: true, type: 'all' };
    const list = await clients.matchAll(query);
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
      port.postMessage(encodeCallback(id, result));
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : 500;
      sendError(port, id, { message: error.message, code });
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

export {
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  TRANSPORTS,
  chunkEncode,
  chunkDecode,
  MetaReadable,
  MetaWritable,
  Metacom,
  MetacomError,
  MetacomProxy,
};
