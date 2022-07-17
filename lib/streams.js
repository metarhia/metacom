'use strict';

const { EventEmitter } = require('events');
const { Blob } = require('buffer');

// todo add timeouts
// todo add stream reconnection
// todo add promise async queue or semaphore?
// todo implement remote backpressure: send msg to client to pause stream

const numToBytesInt32 = (num) => {
  const numBytes = new ArrayBuffer(4);
  const numView = new DataView(numBytes);
  numView.setInt32(0, num);
  return numBytes;
};

const numFromBytesInt32 = (buffer) => {
  const numView = new DataView(buffer);
  return numView.getInt32(buffer.length);
};

const metadataCreator = (streamId) => numToBytesInt32(streamId);
const getStreamId = (metadata) => numFromBytesInt32(metadata);

class MetacomChunk {
  static encode(streamId, payload) {
    const metadata = new Uint8Array(metadataCreator(streamId));
    const byteView = new Uint8Array(4 + payload.length);

    byteView.set(metadata);
    byteView.set(payload, 4);
    return byteView;
  }

  static decode(byteView) {
    const metadata = byteView.subarray(0, 4);
    const streamId = getStreamId(metadata.buffer);
    const payload = byteView.subarray(4);

    return {
      streamId,
      payload,
    };
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

  // implements nodejs readable pipe method
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
      await this.stop();
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

  // implements nodejs writable write method
  write(data) {
    const chunk = MetacomChunk.encode(this.streamId, data);
    this.transport.send(chunk);
    return true;
  }

  // implements nodejs writable end method
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
  MetacomWritable,
};
