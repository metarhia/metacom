'use strict';

const { Emitter } = require('metautil');
const { WebSocket, crypto } = require('./utils.js');
const { chunkDecode } = require('./chunks.js');
const { MetaReadable, MetaWritable } = require('./streams.js');
const { listenOnline } = require('./client-listeners.js');

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
    if (!options.messagePortTransport) {
      this.open();
    }
  }

  static async createProxy(url, options) {
    const { transport } = Metacom;
    const Transport = transport.mp;
    options.messagePortTransport = true;
    const instance = new Transport(url, options);
    await instance.open(options.metacomLoad);
    return instance;
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
    this.initApi(units, introspection);
    return introspection;
  }

  initApi(units, introspection) {
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
          this.send(packet, { unit, method });
        });
      };
  }
  async uploadFile(file, { unit = 'files', method = 'upload' } = {}) {
    this.lastActivity = Date.now();
    const uploader = this.createBlobUploader(file);
    await this.api[unit][method]({
      streamId: uploader.id,
      name: file.name || `blob-${uploader.id}`,
    });
    await uploader.upload();
    return file;
  }
  async downloadFile(name, { unit = 'files', method = 'download' } = {}) {
    const { streamId } = await this.api[unit][method]({ name });
    const readable = await this.getStream(streamId);
    const blob = await readable.toBlob();
    return new File([blob], name);
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

class MessagePortTransport extends Metacom {
  async open(metacomLoad) {
    this.active = true;
    this.connected = true;

    const { port1, port2 } = new MessageChannel();
    this.messagePort = port1;

    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;

    worker.postMessage(
      {
        type: 'PORT_INITIALIZATION',
        url: this.url,
        metacomLoad,
      },
      [port2],
    );

    const { promise, resolve } = Promise.withResolvers();

    this.messagePort.onmessage = ({ data }) => {
      const { payload, type } = data;

      if (type === 'introspection') {
        // instead of metacom.load with implicit introspection call
        // use initApi, when introspection data comes from worker
        this.initApi(metacomLoad, payload);
        resolve(this);
        return;
      }

      if (type === 'callback') {
        this.message(JSON.stringify(payload));
      }

      if (type === 'uploaded') {
        if (!payload.done) return;
        // awaited in uploadFile
        this.emit(`stream_${payload.meta.id}`, payload.meta);
      }

      if (type === 'downloaded') {
        if (!payload.done) return;
        const { arrayBuffer, meta } = payload;
        const file = new File([arrayBuffer], meta.name);
        // awaited in downloadFile
        this.emit(`stream_${meta.id}`, file);
      }
    };

    return promise;
  }

  close() {
    this.active = false;
    this.connected = false;
  }

  send(packet, { unit, method } = {}) {
    if (!this.messagePort) throw new Error('MessagePort is not initialized');

    this.lastActivity = Date.now();
    this.messagePort.postMessage({ unit, method, packet });
  }

  // overriden methods for passing files through service worker
  async uploadFile(file, { unit = 'files', method = 'upload' } = {}) {
    const arrayBuffer = await file.arrayBuffer();
    if (!this.messagePort) throw new Error('MessagePort is not initialized');
    this.lastActivity = Date.now();
    const id = this.generateId();
    const meta = { id, name: file.name, size: file.size, type: file.type };
    const message = { type: 'upload', unit, method, packet: arrayBuffer, meta };
    this.messagePort.postMessage(message, [arrayBuffer]);

    return await this.toPromise(`stream_${id}`).then(() => file);
  }

  async downloadFile(name, { unit = 'files', method = 'download' } = {}) {
    if (!this.messagePort) throw new Error('MessagePort is not initialized');
    this.lastActivity = Date.now();
    const id = this.generateId();
    const packet = { name };
    const meta = { id };
    const message = { type: 'download', unit, method, packet, meta };
    this.messagePort.postMessage(message);
    return await this.toPromise(`stream_${id}`);
  }
}

Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
  mp: MessagePortTransport,
};

module.exports = { Metacom, MetacomUnit };
