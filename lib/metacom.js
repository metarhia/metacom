'use strict';

const { Emitter, generateUUID, jsonParse } = require('metautil');
const { chunkDecode } = require('./chunks.js');
const { MetaReadable, MetaWritable } = require('./streams.js');
const { ClientWsTransport } = require('./client-ws.js');
const { ClientHttpTransport } = require('./client-http.js');
const { ClientEventTransport } = require('./client-event.js');

const CALL_TIMEOUT = 7 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const toByteView = async (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input.arrayBuffer === 'function') {
    return new Uint8Array(await input.arrayBuffer());
  }
  return new Uint8Array(input);
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
  #callTimeout = CALL_TIMEOUT;
  #reconnectTimeout = RECONNECT_TIMEOUT;
  #reconnectTimer = null;
  #proxyPacket = null;
  #options = {};

  get active() {
    return this.#transport.active;
  }

  constructor(url, transport, options = {}) {
    super();
    const { callTimeout, reconnectTimeout, proxy } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (reconnectTimeout) this.#reconnectTimeout = reconnectTimeout;
    if (proxy) this.#proxyPacket = proxy;
    this.url = url;
    this.#transport = transport;
    this.#options = options;
    this.#bindTransport();
  }

  static async connect(url, options = {}) {
    if (options.worker) {
      const transport = Metacom.transport.event.getInstance(url);
      const metacom = new Metacom(url, transport, options);
      await metacom.open();
      return metacom;
    }
    const isHttp = url.startsWith('http');
    const Transport = isHttp ? Metacom.transport.http : Metacom.transport.ws;
    const transport = new Transport(url);
    const metacom = new Metacom(url, transport, options);
    await metacom.open();
    return metacom;
  }

  #bindTransport() {
    this.#transport.on('open', () => {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.emit('open');
    });

    this.#transport.on('close', () => {
      this.emit('close');
      this.#scheduleReconnect();
    });

    this.#transport.on('error', (error) => {
      this.emit('error', error);
    });

    this.#transport.on('message', (data) => {
      const escalate = (error) => this.emit('error', error);
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
    await this.#transport.open(this.#options);
  }

  close() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    Metacom.connections.delete(this);
    this.#transport.close();
  }

  write(data) {
    this.#transport.write(data);
  }

  send(data) {
    this.#transport.send(data);
  }

  getStream(id) {
    const stream = this.#streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = generateUUID();
    return new MetaWritable(id, name, size, this);
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
    if (this.#proxyPacket) return void this.#proxyPacket(data);
    const packet = jsonParse(data);
    if (!packet) throw new Error('Invalid JSON packet');
    const { type, id, name } = packet;
    if (type === 'event') {
      const slash = name.indexOf('/');
      const unit = slash === -1 ? name : name.slice(0, slash);
      const eventName = slash === -1 ? '' : name.slice(slash + 1);
      const metacomUnit = this.api[unit];
      if (metacomUnit) metacomUnit.emit(eventName, packet.data);
      return;
    }
    if (!id) throw new Error('Packet structure error');
    if (type === 'callback') {
      const pending = this.#calls.get(id);
      if (!pending) throw new Error(`Callback ${id} not found`);
      const { resolve, reject, timeout } = pending;
      this.#calls.delete(id);
      clearTimeout(timeout);
      if (packet.error) {
        return void reject(new MetacomError(packet.error));
      }
      resolve(packet.result);
      return;
    }
    if (type === 'stream') await this.#handleStream(packet);
  }

  async #handleStream(packet) {
    const { id, name, size, status } = packet;
    const stream = this.#streams.get(id);
    if (status === undefined) {
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
    const byteView = await toByteView(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.#streams.get(id);
    if (!stream) {
      throw new Error(`Stream ${id} is not initialized`);
    }
    await stream.push(payload);
  }

  async load(...units) {
    if (!this.active) throw new Error('Not connected');
    const introspect = this.#scaffold('system')('introspect');
    const introspection = await introspect(units);
    for (const unit of units) {
      if (!Object.hasOwn(introspection, unit)) continue;
      const methods = new Emitter();
      const instance = introspection[unit];
      const request = this.#scaffold(unit);
      const methodNames = Object.keys(instance);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[unit] = methods;
    }
  }

  #scaffold(unit, version) {
    const createMethod = (methodName) => {
      const method = async (args = {}) => {
        const id = generateUUID();
        const ver = version ? `.${version}` : '';
        const target = `${unit}${ver}/${methodName}`;
        const packet = { type: 'call', id, method: target, args };
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!this.#calls.has(id)) return;
            this.#calls.delete(id);
            reject(new Error('Request timeout'));
          }, this.#callTimeout);
          this.#calls.set(id, { resolve, reject, timeout });
          this.send(packet);
        });
      };
      return method;
    };
    return createMethod;
  }
}

class MetacomProxy extends Emitter {
  #ports = new Set();
  #pending = new Map();
  #connection = null;
  #callTimeout = CALL_TIMEOUT;
  #reconnectTimeout = RECONNECT_TIMEOUT;

  constructor(options = {}) {
    super();
    const { callTimeout, reconnectTimeout } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (reconnectTimeout) this.#reconnectTimeout = reconnectTimeout;
    if (typeof self === 'undefined') {
      throw new Error('MetacomProxy must run in ServiceWorker context');
    }
    self.addEventListener('message', (event) => {
      const { type } = event.data;
      if (type?.startsWith('metacom')) this.#handleEvent(event);
    });
  }

  async open() {
    if (this.#connection) {
      if (this.#connection.active) return;
      await this.#connection.open();
      return;
    }
    const protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${self.location.host}`;
    const options = {
      callTimeout: this.#callTimeout,
      reconnectTimeout: this.#reconnectTimeout,
      proxy: (data) => this.#proxyPacket(data),
    };
    this.#connection = await Metacom.connect(url, options);
  }

  close() {
    if (!this.#connection) return;
    this.#connection.close();
    this.#connection = null;
  }

  #handleEvent(event) {
    const { type } = event.data;
    if (type === 'metacom:connect') {
      const port = event.ports[0];
      if (!port) throw new Error('MessagePort not provided');
      this.#ports.add(port);
      port.addEventListener('message', (messageEvent) => {
        this.#handleMessage(messageEvent, port);
      });
      port.start();
      return;
    }
    if (type === 'metacom:online') Metacom.online();
    else if (type === 'metacom:offline') Metacom.offline();
    else throw new Error(`Unknown event: ${type}`);
  }

  async #handleMessage(event, port) {
    const { data } = event;
    if (data === undefined) throw new Error('Message data is undefined');
    await this.open();
    if (!this.#connection || !this.#connection.active) {
      throw new Error('Not connected to server');
    }
    const packet = jsonParse(data);
    if (!packet || !packet.id) throw new Error('Invalid JSON packet');
    this.#pending.set(packet.id, port);
    this.#connection.write(data);
  }

  #proxyPacket(data) {
    if (typeof data !== 'string') return void this.#broadcast(data);
    const packet = jsonParse(data);
    if (!packet) return void this.#broadcast(data);
    const { type, id, status } = packet;
    if (type === 'event') return void this.#broadcast(data);
    const port = this.#pending.get(id);
    if (!port) return void this.#broadcast(data);
    port.postMessage(data);
    if (type === 'callback') return void this.#pending.delete(id);
    if (type !== 'stream') return;
    const streamDone = status === 'end' || status === 'terminate';
    if (streamDone) this.#pending.delete(id);
  }

  #broadcast(data, excludePort = null) {
    for (const port of this.#ports) {
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

module.exports = { Metacom, MetacomProxy, MetacomError };
