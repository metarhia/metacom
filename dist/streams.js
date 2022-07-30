import EventEmitter from './events.js';

const STREAM_ID_LENGTH = 4;

const createStreamIdBuffer = (num) => {
  const buffer = new ArrayBuffer(STREAM_ID_LENGTH);
  const view = new DataView(buffer);
  view.setInt32(0, num);
  return buffer;
};

const getStreamId = (buffer) => {
  const view = new DataView(buffer);
  return view.getInt32(0);
};

class MetacomChunk {
  static encode(streamId, payload) {
    const streamIdView = new Uint8Array(createStreamIdBuffer(streamId));
    const chunkView = new Uint8Array(STREAM_ID_LENGTH + payload.length);
    chunkView.set(streamIdView);
    chunkView.set(payload, STREAM_ID_LENGTH);
    return chunkView;
  }

  static decode(chunkView) {
    const streamId = getStreamId(chunkView.buffer);
    const payload = chunkView.subarray(STREAM_ID_LENGTH);
    return { streamId, payload };
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
    this.size = initData.size || Infinity;
    this.highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    this.queue = [];
    this.streaming = true;
    this.status = null;
    this.bytesRead = 0;
    this.packetsRead = 0;
    this.packetsNeedToRead = 0;
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

  async close(isForced) {
    await this.stop(isForced);
    this.status = 'closed';
  }

  async terminate() {
    await this.stop();
    this.status = 'terminated';
  }

  async stop(isForced) {
    if (isForced) {
      this.#stop();
      return;
    }
    if (
      this.bytesRead === this.size ||
      this.packetsRead === this.packetsNeedToRead
    ) {
      this.size = this.bytesRead;
      this.#stop();
    } else {
      await this.waitEvent(PULL_EVENT);
      await this.stop();
    }
  }

  #stop() {
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
    this.bytesRead += data.length;
    this.packetsRead += 1;
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
    this.size = initData.size ? initData.size : Infinity;
    this.totalSent = 0;
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
    this.totalSent += 1;
    return true;
  }

  end() {
    const packet = {
      stream: this.streamId,
      status: 'end',
      totalSent: this.totalSent,
    };
    this.transport.send(JSON.stringify(packet));
  }

  terminate() {
    const packet = { stream: this.streamId, status: 'terminate' };
    this.transport.send(JSON.stringify(packet));
  }
}

export { MetacomChunk, MetacomReadable, MetacomWritable };
