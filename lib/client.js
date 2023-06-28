'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const metautil = require('metautil');
const { MetaWritable, MetaReadable, chunkDecode } = require('./streams.js');
const protocol = require('./protocol.js');

const CALL_TIMEOUT = 7 * 1000;
const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const connections = new Set();

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomUnit extends EventEmitter {
  emit(...args) {
    super.emit('*', ...args);
    super.emit(...args);
  }
}

const messageHandlers = {
  error: async (client, { id, message, code }) => {
    const promised = client.calls.get(id);
    if (!promised) return;
    const [, reject, timeout] = promised;
    client.calls.delete(id);
    clearTimeout(timeout);
    reject(new MetacomError({ message, code }));
  },
  callback: async (client, { id, meta, result }) => {
    const promised = client.calls.get(id);
    if (!promised) return;
    const [resolve, , timeout] = promised;
    client.calls.delete(id);
    clearTimeout(timeout);
    resolve({ ...result, meta });
  },
  event: async (client, { unit, eventName, meta, data }) => {
    const metacomUnit = client.api[unit];
    if (metacomUnit) metacomUnit.emit(eventName, { ...data, meta });
  },
  stream: async (client, { id, name, size, status }) => {
    const stream = client.streams.get(id);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        console.error(new Error(`Stream ${name} is already initialized`));
      } else {
        const stream = new MetaReadable(id, name, size);
        client.streams.set(id, stream);
      }
    } else if (!stream) {
      console.error(new Error(`Stream ${id} is not initialized`));
    } else if (status === 'end') {
      await stream.close();
      client.streams.delete(id);
    } else if (status === 'terminate') {
      await stream.terminate();
      client.streams.delete(id);
    } else {
      console.error(new Error('Stream packet structure error'));
    }
  },
};

class Metacom extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.socket = null;
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.streams = new Map();
    this.streamId = 0;
    this.active = false;
    this.connected = false;
    this.opening = null;
    this.lastActivity = Date.now();
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.ping = null;
    this.open();
  }

  static create(url, options) {
    const { transport } = Metacom;
    const Transport = url.startsWith('ws') ? transport.ws : transport.http;
    return new Transport(url, options);
  }

  getStream(id) {
    const stream = this.streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = ++this.streamId;
    return new MetaWritable(this, { id, name, size });
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

  async message(raw) {
    if (raw === '{}') return;
    this.lastActivity = Date.now();
    const packet = metautil.jsonParse(raw);
    const parsed = protocol.deserialize(packet);
    if (!parsed) this.emit('error', new Error('Packet structure error'));
    const { type, data } = parsed;
    const handler = messageHandlers[type];
    if (!handler) this.emit('error', new Error('Packet structure error'));
    await handler(this, data);
  }

  async binary(blob) {
    const buffer = await blob.arrayBuffer();
    const byteView = new Uint8Array(buffer);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.streams.get(id);
    if (stream) await stream.push(payload);
    else console.warn(`Stream ${id} is not initialized`);
  }

  async load(...units) {
    const introspect = this.#scaffold('system')('introspect');
    const introspection = await introspect(units);
    const available = Object.keys(introspection);
    for (const unit of units) {
      if (!available.includes(unit)) continue;
      const methods = new MetacomUnit();
      const instance = introspection[unit];
      const request = this.#scaffold(unit);
      const methodNames = Object.keys(instance);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      methods.on('*', (eventName, data) => {
        const packet = protocol.serialize('event', { unit, eventName, data });
        this.send(JSON.stringify(packet));
      });
      this.api[unit] = methods;
    }
  }

  #scaffold(unit, version) {
    return (name) =>
      async (args = {}) => {
        if (this.opening) await this.opening;
        if (!this.connected) await this.open();
        const id = ++this.callId;
        const raw = { id, unit, version, name, args };
        const packet = protocol.serialize('call', raw);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.calls.has(id)) {
              this.calls.delete(id);
              reject(new Error('Request timeout'));
            }
          }, this.callTimeout);
          this.calls.set(id, [resolve, reject, timeout]);
          this.send(JSON.stringify(packet));
        });
      };
  }
}

class WebsocketTransport extends Metacom {
  async open() {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    connections.add(this);

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

    this.ping = setInterval(() => {
      if (this.active) {
        const interval = Date.now() - this.lastActivity;
        if (interval > this.pingInterval) this.send('{}');
      }
    }, this.pingInterval);

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
    connections.delete(this);
    clearInterval(this.ping);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  send(data) {
    if (!this.connected) return;
    this.lastActivity = Date.now();
    this.socket.send(data);
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
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }).then((res) =>
      res.text().then((packet) => {
        this.message(packet);
      }),
    );
  }
}

Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
};

module.exports = { Metacom, MetacomUnit };
