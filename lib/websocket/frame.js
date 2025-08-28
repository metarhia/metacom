'use strict';

const crypto = require('node:crypto');

const {
  FINAL_FRAME,
  MASK_MASK,
  LEN_16_BIT,
  LEN_64_BIT,
  OPCODES,
  MAX_16_BIT,
  CONTROL_FRAME_MASK,
  EMPTY_BUFFER,
  RSV_MASK,
  CONTROL_OPCODES,
  DATA_OPCODES,
  RSV,
  ENCODING,
  CLIENT_EMPTY_PING,
  EMPTY_PING,
  CLIENT_EMPTY_PONG,
  EMPTY_PONG,
  CLOSE_FRAMES,
  CLOSE_CODES,
  TWO_32,
} = require('./constants.js');
const { Result } = require('./utils/result.js');

class Frame {
  constructor(fin, opcode, masked, payload, mask, rsv = RSV) {
    this.fin = fin;
    this.rsv = rsv & RSV_MASK;
    this.opcode = opcode;
    this.masked = masked;
    this.payload = payload;
    this.mask = mask;
  }

  static text(message, fin = true, masked = false) {
    const payload = Buffer.from(message, ENCODING);
    return new this(fin, OPCODES.TEXT, masked, payload, null);
  }

  static binary(buffer, fin = true, masked = false) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    return new this(fin, OPCODES.BINARY, masked, buffer, null);
  }

  static ping(payload = EMPTY_BUFFER) {
    if (typeof payload === 'string') {
      payload = Buffer.from(payload);
    }
    return new this(true, OPCODES.PING, false, payload, null);
  }

  static pong(payload = EMPTY_BUFFER) {
    if (typeof payload === 'string') {
      payload = Buffer.from(payload);
    }
    return new this(true, OPCODES.PONG, false, payload, null);
  }

  static emptyPingBuffer(isClient = false) {
    const buf = isClient ? Buffer.from(CLIENT_EMPTY_PING) : EMPTY_PING;
    if (isClient) crypto.randomBytes(4).copy(buf, 2);
    return buf;
  }

  static emptyPongBuffer(isClient = false) {
    const buf = isClient ? Buffer.from(CLIENT_EMPTY_PONG) : EMPTY_PONG;
    if (isClient) crypto.randomBytes(4).copy(buf, 2);
    return buf;
  }

  static normalClose(isClient = false) {
    const template = CLOSE_FRAMES.NORMAL_CLOSE;
    if (isClient) {
      const frame = this.close(CLOSE_CODES.NORMAL_CLOSE, template.reason);
      frame.maskPayload();
      return frame.toBuffer();
    }
    return template.buf;
  }

  static errorClose(type, isClient = false) {
    const template = CLOSE_FRAMES[type];
    if (isClient) {
      const frame = this.close(CLOSE_CODES[type], template.reason);
      frame.maskPayload();
      return frame.toBuffer();
    }
    return template.buf;
  }

  static protocolErrorClose(type, isClient = false) {
    const template = CLOSE_FRAMES.PROTOCOL_ERROR[type];
    if (isClient) {
      const frame = this.close(CLOSE_CODES.PROTOCOL_ERROR, template.reason);
      frame.maskPayload();
      return frame.toBuffer();
    }
    return template.buf;
  }

  static close(code = 1000, reason = '') {
    if (code === null || code === undefined) {
      const payload = Buffer.alloc(0);
      return new this(true, OPCODES.CLOSE, false, payload, null);
    }
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    if (reason) payload.write(reason, 2);
    return new this(true, OPCODES.CLOSE, false, payload, null);
  }

  unmaskPayload() {
    if (!this.masked) return;
    for (let i = 0; i < this.payload.length; i++) {
      this.payload[i] ^= this.mask[i & 0x03];
    }
    this.masked = false;
  }

  maskPayload() {
    if (this.masked) return;
    this.mask = crypto.randomBytes(4);
    for (let i = 0; i < this.payload.length; i++) {
      this.payload[i] ^= this.mask[i & 0x03];
    }
    this.masked = true;
  }

  toString() {
    if (this.opcode === OPCODES.TEXT) {
      return this.payload.toString(ENCODING);
    }
    return null;
  }

  getCloseDetails() {
    if (this.opcode !== OPCODES.CLOSE) return Result.empty();

    const code = this.payload.length >= 2 ? this.payload.readUInt16BE(0) : null;
    const reason =
      this.payload.length > 2
        ? this.payload.subarray(2).toString(ENCODING)
        : '';

    return Result.from({ code, reason });
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
    return Buffer.concat([this.header, this.payload]);
  }

  get isControlFrame() {
    return (this.opcode & CONTROL_FRAME_MASK) !== 0;
  }

  get isValidControlFrame() {
    return CONTROL_OPCODES.has(this.opcode);
  }

  get isValidDataFrame() {
    return DATA_OPCODES.has(this.opcode);
  }
}

module.exports = { Frame };
