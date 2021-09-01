import { EventEmitter } from './events.js';

const CALL_TIMEOUT = 7 * 1000;
const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const connections = new Set();

window.addEventListener('online', () => {
  for (const connection of connections) {
    if (!connection.connected) connection.open();
  }
});

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomInterface {
  constructor() {
    this._events = new Map();
  }

  on(name, fn) {
    const event = this._events.get(name);
    if (event) event.add(fn);
    else this._events.set(name, new Set([fn]));
  }

  emit(name, ...args) {
    const event = this._events.get(name);
    if (!event) return;
    for (const fn of event.values()) fn(...args);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const metadataPattern = /^mc:-?\d+;$/;
const finisherByte = 59; // ;

class MetacomChunk {
  static encode(streamId, payload) {
    const metadata = encoder.encode(`mc:${streamId};`);
    return new Uint8Array([...metadata, ...payload]);
  }

  static decode(byteView) {
    const finisherIndex = byteView.findIndex((byte) => byte === finisherByte);
    let metadata = null;
    if (finisherIndex > -1) {
      const payloadStart = finisherIndex + 1;
      const metadataView = byteView.subarray(0, payloadStart);
      metadata = decoder.decode(metadataView);
      if (metadataPattern.test(metadata)) {
        const streamId = parseInt(metadata.slice(3, -1), 10);
        const payload = byteView.subarray(payloadStart);
        return {
          streamId,
          payload
        };
      }
    }
    throw new Error('Invalid chunk metadata: ' + metadata);
  }
}

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 256 * 1024;

class MetacomReadable extends EventEmitter {
  constructor(initData, options = {}) {
    super();
    this.streamId = initData.streamId;
    this.name = initData.name;
    this.size = initData.size;
    this.highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    this.queue = [];
    this.streaming = true;
    this.status = null;
    this.bytesRead = 0;
  }

  async push(data) {
    if (this.checkQueueOverflow()) {
      await this.waitEvent(PULL_EVENT);
      return this.push(data);
    }
    this.queue.push(data);
    if (this.queue.length === 1) this.emit(PUSH_EVENT);
    return data;
  }

  async pipe(writable) {
    const waitEvent = this.waitEvent.bind(writable);
    writable.once('error', () => this.terminate());
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await waitEvent('drain');
    }
    writable.end();
    await waitEvent('close');
    await this.close();
    return {
      status: this.status,
      bytesRead: this.bytesRead
    };
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
    if (this.bytesRead === this.size) {
      this.streaming = false;
      this.emit(PUSH_EVENT, null);
    } else {
      await this.waitEvent(PULL_EVENT);
      return this.stop();
    }
  }

  async read() {
    if (this.queue.length > 0) return this.pull();
    const finisher = await this.waitEvent(PUSH_EVENT);
    if (finisher === null) return null;
    return this.pull();
  }

  pull() {
    const data = this.queue.shift();
    this.bytesRead += data.length;
    this.emit(PULL_EVENT);
    return data;
  }

  checkQueueOverflow() {
    const currentSize = this.queue.reduce(
      (total, data) => (total += data.length), 0
    );
    return currentSize > this.highWaterMark;
  }

  waitEvent(event) {
    return new Promise((resolve) => this.once(event, resolve));
  }

  async* [Symbol.asyncIterator]() {
    while (this.streaming) {
      const chunk = await this.read();
      if (chunk) yield chunk;
      else return;
    }
  }
}

class MetacomWritable extends EventEmitter {
  constructor(initData) {
    super();
    this.transport = initData.transport;
    this.streamId = initData.streamId;
    this.name = initData.name;
    this.size = initData.size;
    this.init();
  }

  init() {
    const packet = {
      stream: this.streamId,
      name: this.name,
      size: this.size
    };
    this.transport.send(JSON.stringify(packet));
  }

  write(data) {
    const chunk = MetacomChunk.encode(this.streamId, data);
    this.transport.send(chunk);
  }

  end() {
    const packet = { stream: this.streamId, status: 'end' };
    this.transport.send(JSON.stringify(packet));
  }

  terminate() {
    const packet = { stream: this.streamId, status: 'terminate' };
    this.transport.send(JSON.stringify(packet));
  }
}

export class Metacom extends EventEmitter {
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
    this.lastActivity = new Date().getTime();
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.open();
  }

  static create(url, options) {
    const { transport } = Metacom;
    const Transport = url.startsWith('ws') ? transport.ws : transport.http;
    return new Transport(url, options);
  }

  async getStreamProducer(streamProducerApi, args = {}) {
    const result = await streamProducerApi(args);
    const producer = this.streams.get(result.streamId);
    return { producer, result };
  }

  createStreamConsumer(name, size, streamConsumerApi, args = {}) {
    const streamId = ++this.streamId;
    const initData = {
      transport: this,
      streamId,
      name,
      size
    };
    const consumer = new MetacomWritable(initData);
    const result = streamConsumerApi({ ...args, streamId: this.streamId });
    return { consumer, result };
  }

  async uploadBlob(blob, blobConsumerApi, args = {}) {
    const name = blob.name || 'blob';
    const size = blob.size;
    const { consumer, result } = this.createStreamConsumer(
      name, size, blobConsumerApi, args
    );
    const reader = blob.stream().getReader();
    let chunk;
    while (!(chunk = await reader.read()).done) {
      consumer.write(chunk.value);
    }
    consumer.end();
    return result;
  }

  async message(data) {
    if (data === '{}') return;
    this.lastActivity = new Date().getTime();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      if (callType === 'callback') {
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        if (packet.error) {
          reject(new MetacomError(packet.error));
          return;
        }
        resolve(args);
        return;
      }
      if (callType === 'event') {
        const [interfaceName, eventName] = target.split('/');
        const metacomInterface = this.api[interfaceName];
        metacomInterface.emit(eventName, args);
      }
      if (callType === 'stream') {
        const { stream: streamId, name, size, status } = packet;
        const stream = this.streams.get(streamId);
        if (typeof name === 'string' && typeof size === 'number') {
          if (stream) {
            console.error(new Error(`Stream ${name} is already initialized`));
          } else {
            const streamData = { streamId, name, size };
            const stream = new MetacomReadable(streamData);
            this.streams.set(streamId, stream);
          }
        } else if (!stream) {
          console.error(new Error(`Stream ${streamId} is not initialized`));
        } else if (status === 'end') {
          await stream.close();
          this.streams.delete(streamId);
        } else if (status === 'terminate') {
          await stream.terminate();
          this.streams.delete(streamId);
        } else {
          console.error(new Error('Stream packet structure error'));
        }
      }
    }
  }

  async binary(blob) {
    const buffer = await blob.arrayBuffer();
    const byteView = new Uint8Array(buffer);
    const { streamId, payload } = MetacomChunk.decode(byteView);
    const stream = this.streams.get(streamId);
    if (stream) await stream.push(payload);
    else console.warn(`Stream ${streamId} is not initialized`);
  }

  async load(...interfaces) {
    const introspect = this.scaffold('system')('introspect');
    const introspection = await introspect(interfaces);
    const available = Object.keys(introspection);
    for (const interfaceName of interfaces) {
      if (!available.includes(interfaceName)) continue;
      const methods = new MetacomInterface();
      const iface = introspection[interfaceName];
      const request = this.scaffold(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[interfaceName] = methods;
    }
  }

  scaffold(iname, ver) {
    return (methodName) =>
      async (args = {}) => {
        const callId = ++this.callId;
        const interfaceName = ver ? `${iname}.${ver}` : iname;
        const target = interfaceName + '/' + methodName;
        if (!this.connected) await this.open();
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (this.calls.has(callId)) {
              this.calls.delete(callId);
              reject(new Error('Request timeout'));
            }
          }, this.callTimeout);
          this.calls.set(callId, [resolve, reject]);
          const packet = { call: callId, [target]: args };
          this.send(JSON.stringify(packet));
        });
      };
  }
}

class WebsocketTransport extends Metacom {
  async open() {
    if (this.connected) return;
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    connections.add(this);

    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') this.message(data);
      else this.binary(data);
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });

    socket.addEventListener('error', (err) => {
      this.emit('error', err);
      socket.close();
    });

    setInterval(() => {
      if (this.active) {
        const interval = new Date().getTime() - this.lastActivity;
        if (interval > this.pingInterval) this.send('{}');
      }
    }, this.pingInterval);

    return new Promise((resolve) => {
      socket.addEventListener('open', () => {
        this.connected = true;
        resolve();
      });
    });
  }

  close() {
    this.active = false;
    connections.delete(this);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  send(data) {
    if (!this.connected) return;
    this.lastActivity = new Date().getTime();
    this.socket.send(data);
  }
}

class HttpTransport extends Metacom {
  async open() {
    this.active = true;
    this.connected = true;
  }

  close() {
    this.active = false;
    this.connected = false;
  }

  send(data) {
    this.lastActivity = new Date().getTime();
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }).then((res) => {
      const { status } = res;
      if (status === 200) {
        return res.text().then((packet) => {
          if (packet.error) throw new MetacomError(packet.error);
          this.message(packet);
        });
      }
      throw new Error(`Status Code: ${status}`);
    });
  }
}

Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
};
