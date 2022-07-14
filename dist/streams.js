import EventEmitter from './events.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const metadataPattern = /^mc:-?\d+;$/;
const finisherByte = 59; // ;

class MetacomChunk {
  static encode(streamId, payload) {
    const metadata = encoder.encode(`mc:${streamId};`);
    const byteView = new Uint8Array(metadata.length + payload.length);
    byteView.set(metadata);
    byteView.set(payload, metadata.length);
    return byteView;
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
          payload,
        };
      }
    }
    throw new Error('Invalid chunk metadata: ' + metadata);
  }
}

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_HIGH_WATER_MARK = 1000;

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
    this.maxListenersCount = this.getMaxListeners() - 1;
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
    const waitWritableEvent = this.waitEvent.bind(writable);
    writable.once('error', () => this.terminate());
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await waitWritableEvent('drain');
    }
    this.emit('end');
    writable.end();
    await waitWritableEvent('close');
    await this.close();
  }

  pipe(writable) {
    void this.finalize(writable);
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
    if (this.bytesRead === this.size) {
      this.streaming = false;
      this.emit(PUSH_EVENT, null);
    } else {
      await this.waitEvent(PULL_EVENT);
      this.stop();
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

  // increase queue if source is much faster than reader
  // implement remote backpressure to resolve
  checkStreamLimits() {
    if (this.listenerCount(PULL_EVENT) >= this.maxListenersCount) {
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
      if (chunk) yield chunk;
      else return;
    }
  }
}

class MetacomWritable extends EventEmitter {
  constructor(transport, initData) {
    super();
    this.transport = transport;
    this.streamId = initData.streamId;
    this.name = initData.name;
    this.size = initData.size;
    this.init();
  }

  init() {
    const packet = {
      stream: this.streamId,
      name: this.name,
      size: this.size,
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

export { MetacomChunk, MetacomReadable, MetacomWritable };
