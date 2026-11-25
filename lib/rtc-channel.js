'use strict';

const { Emitter } = require('metautil');

const { TEXT_ENCODER, Waiters } = require('./utils.js');

const RTC_HEADER_BYTES = 16;
const RTC_FRAME_BYTES = 16384;
const RTC_MESSAGE_BYTES = 16 * 1024 * 1024;
const RTC_QUEUE_BYTES = 32 * 1024 * 1024;
const RTC_HIGH_WATER_BYTES = 256 * 1024;
const RTC_FRAGMENT_LIMIT = 4096;
const RTC_ASSEMBLY_TIMEOUT_MS = 10 * 1000;
const RTC_DECODER = new TextDecoder('utf-8', { fatal: true });

const rtcBytes = (data) => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('RTC data must be text or binary');
};

const rtcPositive = (value, name) => {
  if (Number.isSafeInteger(value) && value > 0) return;
  throw new RangeError(`Invalid RTC ${name}`);
};

// Binary envelopes preserve message boundaries across fragmentation.
class RtcChannelEndpoint extends Emitter {
  #channel;
  #options;
  #queue = [];
  #bytes = 0;
  #sequence = 0;
  #received = 0;
  #assembly = null;
  #waiters = new Waiters();
  #listeners = [];
  closed = false;

  constructor(channel, options = {}) {
    super();
    const messageBytes = options.maxMessageBytes ?? RTC_MESSAGE_BYTES;
    const queueBytes = options.maxQueueBytes ?? RTC_QUEUE_BYTES;
    const highWater = options.highWaterBytes ?? RTC_HIGH_WATER_BYTES;
    const fragments = options.maxFragments ?? RTC_FRAGMENT_LIMIT;
    const timeout = options.assemblyTimeout ?? RTC_ASSEMBLY_TIMEOUT_MS;
    const negotiated = options.maxMessageSize || RTC_FRAME_BYTES;
    const frameBytes = Math.min(negotiated, RTC_FRAME_BYTES);
    const limits = {
      messageBytes,
      queueBytes,
      highWater,
      fragments,
      timeout,
      frameBytes,
    };
    const names = Object.keys(limits);
    for (let i = 0; i < names.length; i++) {
      rtcPositive(limits[names[i]], names[i]);
    }
    if (frameBytes <= RTC_HEADER_BYTES || frameBytes > highWater) {
      throw new RangeError('RTC frame size exceeds buffer or header limit');
    }
    this.#channel = channel;
    this.#options = limits;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = Math.min(
      Math.floor(highWater / 2),
      highWater - frameBytes,
    );
    const listen = (name, listener) => {
      channel.addEventListener(name, listener);
      this.#listeners.push(() => channel.removeEventListener(name, listener));
    };
    listen('bufferedamountlow', () => this.#flush());
    listen('close', () => this.close(new Error('RTC channel closed')));
    listen('error', () => this.close(new Error('RTC channel error')));
    listen('message', ({ data }) => {
      try {
        this.#receive(data);
      } catch (error) {
        this.close(error);
      }
    });
  }

  write(data) {
    if (this.closed || this.#channel.readyState !== 'open') {
      throw new Error('RTC channel is not connected');
    }
    const isText = typeof data === 'string';
    const payload = isText ? TEXT_ENCODER.encode(data) : rtcBytes(data);
    const { messageBytes, fragments, frameBytes, queueBytes } = this.#options;
    const capacity = frameBytes - RTC_HEADER_BYTES;
    const count = Math.max(1, Math.ceil(payload.length / capacity));
    const size = payload.length + count * RTC_HEADER_BYTES;
    if (payload.length > messageBytes || count > fragments) {
      throw new RangeError('RTC message limit exceeded');
    }
    if (this.#bytes + size > queueBytes) {
      throw new RangeError('RTC send queue overflow');
    }
    this.#sequence = (this.#sequence % 0xffffffff) + 1;
    const id = this.#sequence;
    for (let index = 0; index < count; index++) {
      const offset = index * capacity;
      const part = payload.subarray(offset, offset + capacity);
      const frame = new Uint8Array(RTC_HEADER_BYTES + part.length);
      const header = new DataView(frame.buffer);
      frame.set([0x4d, 0x43, 1, isText ? 0 : 1]);
      header.setUint32(4, id);
      header.setUint32(8, payload.length);
      header.setUint32(12, offset);
      frame.set(part, RTC_HEADER_BYTES);
      this.#queue.push(frame);
    }
    this.#bytes += size;
    this.#flush();
    if (this.closed) throw new Error('RTC send failed');
    return this.#writable();
  }

  #writable() {
    const idle = this.#queue.length === 0;
    const below = this.#channel.bufferedAmount < this.#options.highWater;
    return idle && below;
  }

  #flush() {
    if (this.closed) return;
    const { highWater } = this.#options;
    try {
      while (this.#queue.length) {
        const frame = this.#queue[0];
        if (this.#channel.bufferedAmount + frame.length > highWater) break;
        this.#channel.send(frame);
        this.#queue.shift();
        this.#bytes -= frame.length;
      }
    } catch (error) {
      return void this.close(error);
    }
    if (this.#writable()) this.#waiters.release();
  }

  drain() {
    if (this.closed || this.#writable()) return Promise.resolve();
    return this.#waiters.wait();
  }

  #receive(data) {
    if (this.closed) return;
    const frame = rtcBytes(data);
    const { messageBytes, fragments, frameBytes, timeout } = this.#options;
    const tooShort = frame.length < RTC_HEADER_BYTES;
    const tooLong = frame.length > frameBytes;
    const magic = frame[0] === 0x4d && frame[1] === 0x43;
    const version = frame[2] === 1;
    const kind = frame[3] <= 1;
    if (tooShort || tooLong || !magic || !version || !kind) {
      throw new Error('Invalid RTC frame');
    }
    const header = new DataView(
      frame.buffer,
      frame.byteOffset,
      RTC_HEADER_BYTES,
    );
    const id = header.getUint32(4);
    const length = header.getUint32(8);
    const offset = header.getUint32(12);
    const payload = frame.subarray(RTC_HEADER_BYTES);
    const missingId = id === 0;
    const overMessage = length > messageBytes;
    const pastEnd = payload.length + offset > length;
    const emptyPayload = length > 0 && payload.length === 0;
    if (missingId || overMessage || pastEnd || emptyPayload) {
      throw new Error('Invalid RTC fragment size');
    }
    let assembly = this.#assembly;
    if (!assembly) {
      const expected = (this.#received % 0xffffffff) + 1;
      if (offset !== 0 || id !== expected) {
        throw new Error('Invalid RTC message order');
      }
      const timer = setTimeout(
        () => this.close(new Error('RTC assembly timeout')),
        timeout,
      );
      assembly = {
        id,
        length,
        type: frame[3],
        data: new Uint8Array(length),
        offset: 0,
        count: 0,
        timer,
      };
      this.#assembly = assembly;
    }
    const idMismatch = assembly.id !== id;
    const lengthMismatch = assembly.length !== length;
    const typeMismatch = assembly.type !== frame[3];
    const offsetMismatch = assembly.offset !== offset;
    const mismatch =
      idMismatch || lengthMismatch || typeMismatch || offsetMismatch;
    if (mismatch) throw new Error('Invalid RTC fragment order');
    assembly.count += 1;
    if (assembly.count > fragments) {
      throw new Error('Invalid RTC fragment order');
    }
    assembly.data.set(payload, offset);
    assembly.offset += payload.length;
    if (assembly.offset !== length) return;
    clearTimeout(assembly.timer);
    this.#assembly = null;
    this.#received = id;
    const result =
      assembly.type === 0 ? RTC_DECODER.decode(assembly.data) : assembly.data;
    this.emit('message', result);
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    const listeners = this.#listeners;
    for (let i = 0; i < listeners.length; i++) listeners[i]();
    this.#listeners = [];
    if (this.#assembly) clearTimeout(this.#assembly.timer);
    this.#assembly = null;
    this.#queue = [];
    this.#bytes = 0;
    this.#waiters.release();
    this.#channel.close();
    this.emit('close', error);
  }
}

module.exports = { RtcChannelEndpoint };
