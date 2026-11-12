'use strict';

const { Emitter } = require('metautil');

const { chunkEncode } = require('./chunks-node.js');

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_PENDING_PUSHES = 1000;

// Works for both node:stream Writable and metautil Emitter
const waitEvent = (emitter, eventName) => {
  const executor = (resolve) => emitter.once(eventName, resolve);
  return new Promise(executor);
};

class MetaReadable extends Emitter {
  queue = [];
  streaming = true;
  status = 'active';
  bytesRead = 0;
  highWaterMark = DEFAULT_HIGH_WATER_MARK;
  #pending = [];

  constructor(id, name, size, options = {}) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    const { highWaterMark } = options;
    if (highWaterMark) this.highWaterMark = highWaterMark;
  }

  // Chunks over highWaterMark wait in arrival order, pull moves them to queue
  async push(data) {
    if (this.queue.length <= this.highWaterMark) return this.#enqueue(data);
    if (this.#pending.length >= MAX_PENDING_PUSHES) {
      throw new Error('Stream overflow occurred');
    }
    return new Promise((resolve) => {
      this.#pending.push({ data, resolve });
    });
  }

  #enqueue(data) {
    this.queue.push(data);
    if (this.queue.length === 1) this.emit(PUSH_EVENT);
    return data;
  }

  async finalize(writable) {
    const onError = () => this.terminate();
    writable.once('error', onError);
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await waitEvent(writable, 'drain');
    }
    this.emit('end');
    writable.end();
    await waitEvent(writable, 'close');
    writable.off('error', onError);
  }

  pipe(writable) {
    this.finalize(writable).catch((error) => this.emit('error', error));
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
    await this.stop(false);
    const { bytesRead, size } = this;
    const isComplete = bytesRead === size;
    this.status = isComplete ? 'closed' : 'terminated';
    if (isComplete) return;
    throw new Error(`Stream size mismatch: ${bytesRead} of ${size} bytes`);
  }

  async terminate() {
    await this.stop(true);
    this.status = 'terminated';
  }

  async stop(force = false) {
    if (!force) {
      while (this.streaming && this.queue.length > 0) {
        await this.toPromise(PULL_EVENT);
      }
    }
    this.streaming = false;
    this.queue.length = 0;
    const pending = this.#pending;
    this.#pending = [];
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      entry.resolve(entry.data);
    }
    this.emit(PUSH_EVENT, null);
    this.emit(PULL_EVENT);
  }

  async read() {
    if (this.queue.length > 0) return this.pull();
    const finisher = await this.toPromise(PUSH_EVENT);
    if (finisher === null) return null;
    return this.pull();
  }

  pull() {
    const data = this.queue.shift();
    if (!data) return data;
    this.bytesRead += data.length;
    const next = this.#pending.shift();
    if (next) next.resolve(this.#enqueue(next.data));
    this.emit(PULL_EVENT);
    return data;
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

module.exports = { MetaReadable, MetaWritable };
