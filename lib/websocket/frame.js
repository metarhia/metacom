'use strict';

const crypto = require('node:crypto');

const constants = require('./constants.js');
const { OPCODES, CLOSE_CODES, FIN_MASK, RSV_MASK, MASK_MASK } = constants;
const { LEN_16_BIT, LEN_64_BIT, TWO_32 } = constants;

const RSV = 0x00;
const MAX_16_BIT = 65535;
const CONTROL_FRAME_MASK = 0x08;
const ENCODING = 'utf8';
const MAX_CLOSE_REASON_BYTES = 123;
const UTF8_MASK = 0xc0;
const UTF8_TAIL = 0x80;
const EMPTY_BUFFER = Buffer.alloc(0);
const EMPTY_PING = Buffer.from([0x89, 0x00]);
const EMPTY_PONG = Buffer.from([0x8a, 0x00]);
const CLIENT_EMPTY_PING = Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00]);
const CLIENT_EMPTY_PONG = Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]);

const PROTOCOL_ERROR_REASONS = {
  COMMON: 'Protocol error',
  UNMASKED: 'Unmasked frame from client',
  MASKED: 'Masked frame from server',
  RSV: 'RSV bits must be 0',
  CTRL_TOO_LONG: 'Control frame too long',
};

const applyMask = (payload, mask) => {
  const length = payload.length;
  const m0 = mask[0];
  const m1 = mask[1];
  const m2 = mask[2];
  const m3 = mask[3];
  const aligned = length - (length % 4);
  let i = 0;
  for (; i < aligned; i += 4) {
    payload[i] ^= m0;
    payload[i + 1] ^= m1;
    payload[i + 2] ^= m2;
    payload[i + 3] ^= m3;
  }
  for (; i < length; i++) payload[i] ^= mask[i % 4];
};

const headerBytesFor = (length) => {
  if (length > MAX_16_BIT) return 10;
  if (length >= LEN_16_BIT) return 4;
  return 2;
};

// Second byte and extended length, returns where the mask or payload starts
const writeLength = (header, length, maskBit) => {
  if (length > MAX_16_BIT) {
    header[1] = maskBit | LEN_64_BIT;
    header.writeUInt32BE(Math.trunc(length / TWO_32), 2);
    header.writeUInt32BE(length >>> 0, 6);
    return 10;
  }
  if (length >= LEN_16_BIT) {
    header[1] = maskBit | LEN_16_BIT;
    header.writeUInt16BE(length, 2);
    return 4;
  }
  header[1] = maskBit | length;
  return 2;
};

// Unmasked final text frame in one buffer: header and UTF-8 payload
const encodeText = (message) => {
  const length = Buffer.byteLength(message, ENCODING);
  const offset = headerBytesFor(length);
  const buffer = Buffer.allocUnsafe(offset + length);
  buffer[0] = FIN_MASK | OPCODES.TEXT;
  writeLength(buffer, length, 0);
  buffer.write(message, offset, ENCODING);
  return buffer;
};

// Unmasked final binary frame header, payload is written after it
const binaryHeader = (length) => {
  const header = Buffer.allocUnsafe(headerBytesFor(length));
  header[0] = FIN_MASK | OPCODES.BINARY;
  writeLength(header, length, 0);
  return header;
};

const truncateCloseReason = (reason) => {
  const bytes = Buffer.from(reason, ENCODING);
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  while (end > 0 && (bytes[end] & UTF8_MASK) === UTF8_TAIL) end--;
  return bytes.subarray(0, end).toString(ENCODING);
};

class Frame {
  constructor(fin, opcode, masked, payload, mask = null, rsv = RSV) {
    this.fin = fin;
    this.rsv = rsv & RSV_MASK;
    this.opcode = opcode;
    this.masked = masked;
    this.payload = payload;
    this.mask = mask;
  }

  static text(message, fin = true, masked = false) {
    const payload = Buffer.from(message, ENCODING);
    return new Frame(fin, OPCODES.TEXT, masked, payload);
  }

  static binary(buffer, fin = true, masked = false) {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return new Frame(fin, OPCODES.BINARY, masked, payload);
  }

  static #control(opcode, payload) {
    const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
    return new Frame(true, opcode, false, data);
  }

  static ping(payload = EMPTY_BUFFER) {
    return Frame.#control(OPCODES.PING, payload);
  }

  static pong(payload = EMPTY_BUFFER) {
    return Frame.#control(OPCODES.PONG, payload);
  }

  static #emptyClientControlBuffer(template) {
    const buffer = Buffer.from(template);
    const mask = crypto.randomBytes(4);
    mask.copy(buffer, 2);
    return buffer;
  }

  static emptyClientPingBuffer() {
    return Frame.#emptyClientControlBuffer(CLIENT_EMPTY_PING);
  }

  static emptyClientPongBuffer() {
    return Frame.#emptyClientControlBuffer(CLIENT_EMPTY_PONG);
  }

  static closeBuffer(code, reason, isClient = false) {
    const frame = Frame.close(code, reason);
    if (isClient) frame.maskPayload();
    return frame.toBuffer();
  }

  static errorClose(type, isClient = false) {
    const code = CLOSE_CODES[type];
    return Frame.closeBuffer(code, type, isClient);
  }

  static protocolErrorClose(type, isClient = false) {
    const code = CLOSE_CODES['Protocol error'];
    const reason = PROTOCOL_ERROR_REASONS[type];
    return Frame.closeBuffer(code, reason, isClient);
  }

  static isProtocolErrorType(type) {
    return Object.hasOwn(PROTOCOL_ERROR_REASONS, type);
  }

  static close(code = 1000, reason = '') {
    if (code === null) {
      return new Frame(true, OPCODES.CLOSE, false, EMPTY_BUFFER);
    }
    const truncated = truncateCloseReason(reason);
    const reasonBytes = Buffer.byteLength(truncated, ENCODING);
    const payload = Buffer.alloc(2 + reasonBytes);
    payload.writeUInt16BE(code, 0);
    if (truncated) payload.write(truncated, 2, ENCODING);
    return new Frame(true, OPCODES.CLOSE, false, payload);
  }

  unmaskPayload() {
    if (!this.masked) return;
    applyMask(this.payload, this.mask);
    this.masked = false;
  }

  maskPayload() {
    if (this.masked) return;
    this.mask = crypto.randomBytes(4);
    // Copy to keep the caller's buffer intact, Frame.binary does not copy
    this.payload = Buffer.from(this.payload);
    applyMask(this.payload, this.mask);
    this.masked = true;
  }

  toString() {
    if (this.opcode === OPCODES.TEXT) {
      return this.payload.toString(ENCODING);
    }
    return null;
  }

  getCloseDetails() {
    const { payload } = this;
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
    const hasReason = payload.length > 2;
    const reason = hasReason ? payload.toString(ENCODING, 2) : '';
    return { code, reason };
  }

  // Every byte is written: first byte, length, then the mask if any
  get header() {
    const length = this.payload.length;
    const fin = this.fin ? FIN_MASK : 0;
    const maskBit = this.masked ? MASK_MASK : 0;
    const maskBytes = this.masked ? 4 : 0;
    const header = Buffer.allocUnsafe(headerBytesFor(length) + maskBytes);
    header[0] = fin | this.rsv | this.opcode;
    const maskOffset = writeLength(header, length, maskBit);
    if (this.masked) this.mask.copy(header, maskOffset);
    return header;
  }

  toBuffer() {
    const header = this.header;
    const buffer = Buffer.allocUnsafe(header.length + this.payload.length);
    header.copy(buffer, 0);
    this.payload.copy(buffer, header.length);
    return buffer;
  }

  get isControlFrame() {
    return (this.opcode & CONTROL_FRAME_MASK) !== 0;
  }
}

module.exports = { encodeText, binaryHeader, Frame, EMPTY_PING, EMPTY_PONG };
