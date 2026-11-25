'use strict';

const { Emitter } = require('metautil');

const { TEXT_ENCODER, Waiters } = require('./utils.js');

// Header: magic 'MC', version, kind (0 text, 1 binary), then uint32
// message id, message length, and fragment offset, big-endian
const RTC_HEADER_BYTES = 16;
const RTC_FRAME_MAGIC_M = 0x4d;
const RTC_FRAME_MAGIC_C = 0x43;
const RTC_FRAME_VERSION = 1;
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

// Typed array stores keep the low byte of each shifted value
const writeUint32 = (bytes, offset, value) => {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
};

const readUint32 = (bytes, offset) => {
  const first = bytes[offset] * 0x1000000;
  const second = bytes[offset + 1] << 16;
  const third = bytes[offset + 2] << 8;
  return first + (second | third | bytes[offset + 3]);
};

const writeHeader = (frame, kind, id, length, offset) => {
  frame[0] = RTC_FRAME_MAGIC_M;
  frame[1] = RTC_FRAME_MAGIC_C;
  frame[2] = RTC_FRAME_VERSION;
  frame[3] = kind;
  writeUint32(frame, 4, id);
  writeUint32(frame, 8, length);
  writeUint32(frame, 12, offset);
};

// Text that surely fits one fragment is encoded right after the header
const textFrame = (text) => {
  const frame = new Uint8Array(RTC_HEADER_BYTES + text.length * 3);
  const body = frame.subarray(RTC_HEADER_BYTES);
  const { written } = TEXT_ENCODER.encodeInto(text, body);
  return frame.subarray(0, RTC_HEADER_BYTES + written);
};

const splitFrames = (payload, capacity, count) => {
  const frames = new Array(count);
  for (let index = 0; index < count; index++) {
    const offset = index * capacity;
    const part = payload.subarray(offset, offset + capacity);
    const frame = new Uint8Array(RTC_HEADER_BYTES + part.length);
    frame.set(part, RTC_HEADER_BYTES);
    frames[index] = frame;
  }
  return frames;
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
    const capacity = this.#options.frameBytes - RTC_HEADER_BYTES;
    const isText = typeof data === 'string';
    const isShortText = isText && data.length * 3 <= capacity;
    if (isShortText) {
      const frame = textFrame(data);
      this.#checkMessage(frame.length - RTC_HEADER_BYTES, 1);
      return this.#enqueue([frame], 0);
    }
    const payload = isText ? TEXT_ENCODER.encode(data) : rtcBytes(data);
    const count = Math.max(1, Math.ceil(payload.length / capacity));
    this.#checkMessage(payload.length, count);
    const frames = splitFrames(payload, capacity, count);
    return this.#enqueue(frames, isText ? 0 : 1);
  }

  #checkMessage(length, count) {
    const { messageBytes, fragments } = this.#options;
    if (length <= messageBytes && count <= fragments) return;
    throw new RangeError('RTC message limit exceeded');
  }

  // Headers are written once the message gets its id
  #enqueue(frames, kind) {
    let size = 0;
    for (let i = 0; i < frames.length; i++) size += frames[i].length;
    if (this.#bytes + size > this.#options.queueBytes) {
      throw new RangeError('RTC send queue overflow');
    }
    this.#sequence = (this.#sequence % 0xffffffff) + 1;
    const id = this.#sequence;
    const length = size - frames.length * RTC_HEADER_BYTES;
    let offset = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      writeHeader(frame, kind, id, length, offset);
      offset += frame.length - RTC_HEADER_BYTES;
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
    const magicM = frame[0] === RTC_FRAME_MAGIC_M;
    const magicC = frame[1] === RTC_FRAME_MAGIC_C;
    const version = frame[2] === RTC_FRAME_VERSION;
    const kind = frame[3];
    if (tooShort || tooLong || !magicM || !magicC || !version || kind > 1) {
      throw new Error('Invalid RTC frame');
    }
    const id = readUint32(frame, 4);
    const length = readUint32(frame, 8);
    const offset = readUint32(frame, 12);
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
      const isWhole = payload.length === length;
      if (isWhole) return void this.#deliver(id, kind, payload);
      const onTimeout = () => this.close(new Error('RTC assembly timeout'));
      const timer = setTimeout(onTimeout, timeout);
      const buffer = new Uint8Array(length);
      assembly = { id, length, kind, buffer, offset: 0, count: 0, timer };
      this.#assembly = assembly;
    }
    const idMismatch = assembly.id !== id;
    const lengthMismatch = assembly.length !== length;
    const kindMismatch = assembly.kind !== kind;
    const offsetMismatch = assembly.offset !== offset;
    const mismatch =
      idMismatch || lengthMismatch || kindMismatch || offsetMismatch;
    if (mismatch) throw new Error('Invalid RTC fragment order');
    assembly.count += 1;
    if (assembly.count > fragments) {
      throw new Error('Invalid RTC fragment order');
    }
    assembly.buffer.set(payload, offset);
    assembly.offset += payload.length;
    if (assembly.offset !== length) return;
    clearTimeout(assembly.timer);
    this.#assembly = null;
    this.#deliver(id, kind, assembly.buffer);
  }

  #deliver(id, kind, payload) {
    this.#received = id;
    const message = kind === 0 ? RTC_DECODER.decode(payload) : payload;
    this.emit('message', message);
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
