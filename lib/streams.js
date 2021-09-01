'use strict';
const { EventEmitter } = require('events');
const { Blob } = require('buffer');

// todo add timeouts
// todo add writable queue
// todo implement remote backpressure: send msg to client to pause stream
// todo try TypedArrays for performance improvement

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

module.exports = {
  MetacomChunk,
  MetacomReadable,
  MetacomWritable
};
