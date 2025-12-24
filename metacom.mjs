// Copyright (c) 2018-2025 Metarhia contributors
// Version 3.2.6 metacom MIT License

import { Emitter } from 'metautil';

//#region client-listeners.js
const listenOnline = (connections) => {
  const online = () => {
    for (const connection of connections) {
      if (!connection.connected) connection.open();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', online);
  }
  if (typeof self !== 'undefined' && !!self.registration) {
    self.addEventListener('online', online);
  }
};
export { listenOnline };
//#endregion

//#region chunks.js
const ID_LENGTH_BYTES = 1;
const chunkEncode = (id, payload) => {
  const idBuffer = Buffer.from(id, 'utf8');
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
  const id = Buffer.from(idBuffer).toString('utf8');
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};
export {
  chunkEncode,
  chunkDecode,
};
//#endregion

//#region streams.js
const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_LISTENERS = 10;
const MAX_HIGH_WATER_MARK = 1000;
class MetaReadable extends Emitter {
  constructor(id, name, size, options = {}) {
    super(options);
    this.id = id;
    this.name = name;
    this.size = size;
    this.highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    this.queue = [];
    this.streaming = true;
    this.status = 'active';
    this.bytesRead = 0;
  }
  async push(data) {
    if (this.queue.length > this.highWaterMark) {
      this.checkStreamLimits();
      await this.waitEvent(PULL_EVENT);
      return this.push(data);
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
    this.finalize(writable);
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
export {
  MetaReadable,
  MetaWritable,
};
//#endregion

//#region metacom.js
const CALL_TIMEOUT = 7 * 1000;
const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;
const connections = new Set();
listenOnline(connections);
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
  constructor(url, options = {}) {
    super(options);
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
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.generateId = options.generateId || (() => crypto.randomUUID());
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
    if (data === '{}') return;
    this.lastActivity = Date.now();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    const { type, id, name } = packet;
    if (type === 'event') {
      const [unit, eventName] = name.split('/');
      const metacomUnit = this.api[unit];
      if (metacomUnit) metacomUnit.emit(eventName, packet.data);
      return;
    }
    if (!id) {
      console.error(new Error('Packet structure error'));
      return;
    }
    if (type === 'callback') {
      const promised = this.calls.get(id);
      if (!promised) return;
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
          console.error(new Error(`Stream ${name} is already initialized`));
        } else {
          const stream = new MetaReadable(id, name, size);
          this.streams.set(id, stream);
        }
      } else if (!stream) {
        console.error(new Error(`Stream ${id} is not initialized`));
      } else if (status === 'end') {
        await stream.close();
        this.streams.delete(id);
      } else if (status === 'terminate') {
        await stream.terminate();
        this.streams.delete(id);
      } else {
        console.error(new Error('Stream packet structure error'));
      }
    }
  }
  async binary(input) {
    const byteView = await toByteView(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.streams.get(id);
    if (stream) await stream.push(payload);
    else console.warn(`Stream ${id} is not initialized`);
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
    return (method) =>
      async (args = {}) => {
        const id = this.generateId();
        const unitName = unit + (ver ? '.' + ver : '');
        const target = unitName + '/' + method;
        if (this.opening) await this.opening;
        if (!this.connected) await this.open();
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.calls.has(id)) {
              this.calls.delete(id);
              reject(new Error('Request timeout'));
            }
          }, this.callTimeout);
          this.calls.set(id, [resolve, reject, timeout]);
          const packet = { type: 'call', id, method: target, args };
          this.send(packet);
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
    if (this.pingInterval) {
      this.ping = setInterval(() => {
        if (this.active) {
          const interval = Date.now() - this.lastActivity;
          if (interval > this.pingInterval) this.write('{}');
        }
      }, this.pingInterval);
    }
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
    if (this.ping) clearInterval(this.ping);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }
  write(data) {
    if (!this.connected) return;
    this.lastActivity = Date.now();
    this.socket.send(data);
  }
  send(data) {
    if (!this.connected) return;
    this.lastActivity = Date.now();
    const payload = JSON.stringify(data);
    this.socket.send(payload);
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
Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
};
export {
  Metacom,
  MetacomUnit,
};
//#endregion
