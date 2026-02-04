'use strict';

const metautil = require('metautil');
const { Emitter } = metautil;
const WebSocket = globalThis.WebSocket || require('ws');
const { chunkDecode } = require('./chunks.js');
const { MetaReadable, MetaWritable } = require('./streams.js');

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

class Metacom extends Emitter {
  static connections = new Set();
  static isOnline = true;

  static online() {
    Metacom.isOnline = true;
    for (const connection of Metacom.connections) {
      if (!connection.connected) connection.open();
    }
  }

  static offline() {
    Metacom.isOnline = false;
  }

  static initialize() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', Metacom.online);
      window.addEventListener('offline', Metacom.offline);
    } else if (typeof self !== 'undefined') {
      self.addEventListener('online', Metacom.online);
      self.addEventListener('offline', Metacom.offline);
    }
  }

  constructor(url, options = {}) {
    super();
    this.url = url;
    this.socket = null;
    this.api = {};
    this.calls = new Map();
    this.streams = new Map();
    this.active = false;
    this.connected = false;
    this.opening = null;
    this.lastActivity = Date.now();
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.generateId = options.generateId || metautil.generateId;
    this.open(options);
  }

  static create(url, options) {
    const { transport } = Metacom;
    if (options.worker) return transport.event.getInstance(url, options);
    const Transport = url.startsWith('ws') ? transport.ws : transport.http;
    return new Transport(url, options);
  }

  getStream(id) {
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = this.generateId();
    const transport = this;
    return new MetaWritable(id, name, size, transport);
  }

  createBlobUploader(blob) {
    const name = blob.name || 'blob';
    const size = blob.size;
    const consumer = this.createStream(name, size);
    return {
      id: consumer.id,
      upload: async () => {
        const reader = blob.stream().getReader();
        let chunk;
        while (!(chunk = await reader.read()).done) {
          consumer.write(chunk.value);
        }
        consumer.end();
      },
    };
  }

  async message(data) {
    this.lastActivity = Date.now();
    const packet = JSON.parse(data);
    const { type, id, name } = packet;
    if (type === 'event') {
      const [unit, eventName] = name.split('/');
      const metacomUnit = this.api[unit];
      if (metacomUnit) metacomUnit.emit(eventName, packet.data);
      return;
    }
    if (!id) throw new Error('Packet structure error');
    if (type === 'callback') {
      const promised = this.calls.get(id);
      if (!promised) throw new Error(`Callback ${id} not found`);
      const [resolve, reject, timeout] = promised;
      this.calls.delete(id);
      clearTimeout(timeout);
      if (packet.error) {
        return void reject(new MetacomError(packet.error));
      }
      resolve(packet.result);
    } else if (type === 'stream') {
      const { name, size, status } = packet;
      const stream = this.streams.get(id);
      if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
        if (stream) {
          throw new Error(`Stream ${name} is already initialized`);
        } else {
          const newStream = new MetaReadable(id, name, size);
          this.streams.set(id, newStream);
        }
      } else if (!stream) {
        throw new Error(`Stream ${id} is not initialized`);
      } else if (status === 'end') {
        await stream.close();
        this.streams.delete(id);
      } else if (status === 'terminate') {
        await stream.terminate();
        this.streams.delete(id);
      } else {
        throw new Error('Stream packet structure error');
      }
    }
  }

  async binary(input) {
    const byteView = await toByteView(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.streams.get(id);
    if (stream) await stream.push(payload);
    else throw new Error(`Stream ${id} is not initialized`);
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
        const unitName = unit + (ver ? '.' + ver : '');
        const target = unitName + '/' + methodName;
        if (this.opening) await this.opening;
        const packet = { type: 'call', id, method: target, args };
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.calls.has(id)) {
              this.calls.delete(id);
              reject(new Error('Request timeout'));
            }
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

class WebsocketTransport extends Metacom {
  async open() {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    Metacom.connections.add(this);

    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') this.message(data);
      else this.binary(data);
    });

    socket.addEventListener('close', () => {
      this.opening = null;
      this.connected = false;
      this.emit('close');
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });

    socket.addEventListener('error', (err) => {
      this.emit('error', err);
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
    Metacom.connections.delete(this);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  write(data) {
    if (!this.connected) throw new Error('Not connected');
    this.lastActivity = Date.now();
    this.socket.send(data);
  }

  send(data) {
    const payload = JSON.stringify(data);
    this.write(payload);
  }
}

class HttpTransport extends Metacom {
  async open() {
    this.active = true;
    this.connected = true;
    this.emit('open');
  }

  close() {
    this.active = false;
    this.connected = false;
  }

  send(data) {
    this.lastActivity = Date.now();
    const body = JSON.stringify(data);
    const headers = { 'Content-Type': 'application/json' };
    fetch(this.url, { method: 'POST', headers, body }).then((res) =>
      res.text().then((packet) => {
        this.message(packet);
      }),
    );
  }
}

class EventTransport extends Metacom {
  static messagePort = null;
  static instance = null;

  static getInstance(url, options = {}) {
    if (EventTransport.instance) return EventTransport.instance;
    EventTransport.instance = new EventTransport(url, options);
    return EventTransport.instance;
  }

  async open(options = {}) {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    this.active = true;
    const worker = options.worker || this.worker;
    if (!worker) throw new Error('Service Worker not provided');
    this.worker = worker;
    this.opening = new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      EventTransport.messagePort = port1;
      port1.addEventListener('message', (event) => {
        const { data } = event;
        if (data !== undefined) {
          if (typeof data === 'string') this.message(data);
          else this.binary(data);
        }
      });
      port1.start();
      this.worker.postMessage({ type: 'metacom:connect' }, [port2]);
      this.connected = true;
      resolve();
    });
    return this.opening;
  }

  close() {
    this.active = false;
    this.opening = null;
    Metacom.connections.delete(this);
    this.connected = false;
  }

  online() {
    if (this.worker) {
      this.worker.postMessage({ type: 'metacom:online' });
    }
  }

  offline() {
    if (this.worker) {
      this.worker.postMessage({ type: 'metacom:offline' });
    }
  }

  write(data) {
    if (!EventTransport.messagePort) throw new Error('Not connected');
    this.lastActivity = Date.now();
    EventTransport.messagePort.postMessage(data);
  }

  send(data) {
    const payload = JSON.stringify(data);
    this.write(payload);
  }
}

class MetacomProxy extends Emitter {
  constructor(options = {}) {
    super(options);
    this.ports = new Map();
    this.connection = null;
    this.url = null;
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.generateId = options.generateId || metautil.generateId;
    if (typeof self !== 'undefined') {
      self.addEventListener('message', (event) => {
        const { type } = event.data;
        if (type && type.startsWith('metacom')) this.handleMessage(event);
      });
    }
  }

  async open(options = {}) {
    if (this.connection) {
      if (this.connection.connected) return Promise.resolve();
      return this.connection.open(options);
    }
    const protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${protocol}//${self.location.host}`;
    const opts = {
      callTimeout: this.callTimeout,
      reconnectTimeout: this.reconnectTimeout,
      generateId: this.generateId,
    };
    this.connection = new WebsocketTransport(this.url, opts);
    this.connection.message = async (data) => {
      this.broadcast(data);
    };
    this.connection.binary = async (input) => {
      const data = await toByteView(input);
      this.broadcast(data);
    };
    return this.connection.open(opts);
  }

  close() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }

  async handleMessage(event) {
    const { type } = event.data;
    if (type === 'metacom:connect') {
      const port = event.ports[0];
      if (!port) throw new Error('MessagePort not provided');
      const portId = this.generateId();
      this.ports.set(portId, port);
      port.addEventListener('message', async (messageEvent) => {
        const { data } = messageEvent;
        if (data === undefined) throw new Error('Message data is undefined');
        await this.open();
        if (!this.connection || !this.connection.connected) {
          throw new Error('Not connected to server');
        }
        this.connection.write(data);
      });
      port.start();
    } else if (type === 'metacom:online') {
      Metacom.online();
    } else if (type === 'metacom:offline') {
      Metacom.offline();
    }
  }

  broadcast(data, excludePort = null) {
    for (const port of this.ports.values()) {
      if (port === excludePort) continue;
      port.postMessage(data);
    }
  }
}

Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
  event: EventTransport,
};

Metacom.initialize();
module.exports = { Metacom, MetacomUnit, MetacomProxy };
