'use strict';

const crypto = require('node:crypto');

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { Result } = require('./result.js');

const FINAL_FRAME = 0x80;
const RSV = 0x00;
const LEN_16_BIT = 126;
const LEN_64_BIT = 127;
const MAX_16_BIT = 65535;
const TWO_32 = 4294967296;
const MASK_MASK = 0x80;
const RSV_MASK = 0x70;
const CONTROL_FRAME_MASK = 0x08;
const ENCODING = 'utf8';
const MAX_CLOSE_REASON = 123;
const EMPTY_BUFFER = Buffer.alloc(0);
const EMPTY_PING = Buffer.from([0x89, 0x00]);
const EMPTY_PONG = Buffer.from([0x8a, 0x00]);
const CLIENT_EMPTY_PING = Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00]);
const CLIENT_EMPTY_PONG = Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]);

const ERROR_REASONS = {
  INVALID_PAYLOAD: 'Invalid payload data',
  MESSAGE_TOO_BIG: 'Message too big',
};

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

const truncateCloseReason = (reason) => {
  const bytes = Buffer.from(reason, ENCODING);
  if (bytes.length <= MAX_CLOSE_REASON) return reason;
  let end = MAX_CLOSE_REASON;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
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

  static ping(payload = EMPTY_BUFFER) {
    const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    return new Frame(true, OPCODES.PING, false, buf);
  }

  static pong(payload = EMPTY_BUFFER) {
    const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    return new Frame(true, OPCODES.PONG, false, buf);
  }

  static #emptyClientControlBuffer(template) {
    const buf = Buffer.from(template);
    crypto.randomBytes(4).copy(buf, 2);
    return buf;
  }

  static emptyClientPingBuffer() {
    return Frame.#emptyClientControlBuffer(CLIENT_EMPTY_PING);
  }

  static emptyClientPongBuffer() {
    return Frame.#emptyClientControlBuffer(CLIENT_EMPTY_PONG);
  }

  static #closeBuffer(code, reason, isClient = false) {
    const frame = Frame.close(code, reason);
    if (isClient) frame.maskPayload();
    return frame.toBuffer();
  }

  static errorClose(type, isClient = false) {
    return Frame.#closeBuffer(CLOSE_CODES[type], ERROR_REASONS[type], isClient);
  }

  static protocolErrorClose(type, isClient = false) {
    return Frame.#closeBuffer(
      CLOSE_CODES.PROTOCOL_ERROR,
      PROTOCOL_ERROR_REASONS[type],
      isClient,
    );
  }

  static isProtocolErrorType(type) {
    return Object.hasOwn(PROTOCOL_ERROR_REASONS, type);
  }

  static close(code = 1000, reason = '') {
    if (code === null) {
      const payload = Buffer.alloc(0);
      return new Frame(true, OPCODES.CLOSE, false, payload);
    }
    const truncatedReason = truncateCloseReason(reason);
    const payload = Buffer.alloc(
      2 + Buffer.byteLength(truncatedReason, ENCODING),
    );
    payload.writeUInt16BE(code, 0);
    if (truncatedReason) payload.write(truncatedReason, 2, ENCODING);
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
    const code = this.payload.length >= 2 ? this.payload.readUInt16BE(0) : null;
    const reason =
      this.payload.length > 2
        ? this.payload.subarray(2).toString(ENCODING)
        : '';

    return Result.ok({ code, reason });
  }

  get header() {
    const length = this.payload.length;
    const fin = this.fin ? FINAL_FRAME : 0;
    const masked = this.masked ? MASK_MASK : 0;
    let header;
    let lengthField;

    if (length < LEN_16_BIT) {
      header = Buffer.alloc(this.masked ? 6 : 2);
      header[0] = fin | this.rsv | this.opcode;
      header[1] = masked | length;
      lengthField = 2;
    } else if (length <= MAX_16_BIT) {
      header = Buffer.alloc(this.masked ? 8 : 4);
      header[0] = fin | this.rsv | this.opcode;
      header[1] = masked | LEN_16_BIT;
      header.writeUInt16BE(length, 2);
      lengthField = 4;
    } else {
      header = Buffer.alloc(this.masked ? 14 : 10);
      header[0] = fin | this.rsv | this.opcode;
      header[1] = masked | LEN_64_BIT;
      const high = Math.trunc(length / TWO_32);
      const low = length >>> 0;
      header.writeUInt32BE(high, 2);
      header.writeUInt32BE(low, 6);
      lengthField = 10;
    }

    if (this.masked) {
      this.mask.copy(header, lengthField);
    }

    return header;
  }

  toBuffer() {
    const header = this.header;
    const buf = Buffer.allocUnsafe(header.length + this.payload.length);
    header.copy(buf, 0);
    this.payload.copy(buf, header.length);
    return buf;
  }

  get isControlFrame() {
    return (this.opcode & CONTROL_FRAME_MASK) !== 0;
  }
}

module.exports = { Frame, EMPTY_PING, EMPTY_PONG };
