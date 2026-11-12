'use strict';

const { isUtf8 } = require('node:buffer');

const constants = require('./constants.js');
const { OPCODES, CLOSE_CODES, CONTROL_OPCODES } = constants;
const { FIN_MASK, RSV_MASK, MASK_MASK } = constants;
const { LEN_16_BIT, LEN_64_BIT, TWO_32 } = constants;
const { Frame } = require('./frame.js');
const { Result } = require('./result.js');

const OPCODE_MASK = 0x0f;
const PAYLOAD_LEN_MASK = 0x7f;
const MAX_SAFE_HIGH_MASK = 0xffe00000;
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const VALID_USER_CLOSE_CODES = { MIN: 3000, MAX: 4999 };
const INVALID_PAYLOAD = 'Invalid payload data';
const CLOSE_REASONS = Object.keys(CLOSE_CODES);
const VALID_CLOSE_CODES = CLOSE_REASONS.map((reason) => CLOSE_CODES[reason]);

const isValidCloseCode = (code) => {
  if (VALID_CLOSE_CODES.includes(code)) return true;
  const { MIN, MAX } = VALID_USER_CLOSE_CODES;
  return code >= MIN && code <= MAX;
};

class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

const failParse = (code, message) => {
  const error = new ParseError(code, message);
  return Result.fail(error);
};

const parse = (buffer) => {
  if (buffer.length < 2) return Result.ok();

  const fin = (buffer[0] & FIN_MASK) !== 0;
  const rsv = buffer[0] & RSV_MASK;
  const opcode = buffer[0] & OPCODE_MASK;
  const masked = (buffer[1] & MASK_MASK) !== 0;
  let length = buffer[1] & PAYLOAD_LEN_MASK;
  let offset = 2;

  if (rsv !== 0) return failParse('RSV', 'RSV bits must be 0');

  if (length === LEN_16_BIT) {
    if (buffer.length < offset + 2) return Result.ok();
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === LEN_64_BIT) {
    if (buffer.length < offset + 8) return Result.ok();
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    offset += 8;
    const isSafeHigh = (high & MAX_SAFE_HIGH_MASK) === 0;
    if (!isSafeHigh) {
      const message = 'Payload length exceeds MAX_SAFE_INTEGER';
      return failParse('Message too big', message);
    }
    length = high * TWO_32 + low;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return Result.ok();
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return Result.ok();
  const payload = buffer.subarray(offset, offset + length);
  const frame = new Frame(fin, opcode, masked, payload, mask, rsv);
  return Result.ok({ frame, bytesUsed: offset + length });
};

// Total byte size of the next frame in the buffer, or the minimum
// number of bytes required to determine it while the header is still
// incomplete. Lets callers buffer incoming chunks without re-parsing.
const frameLength = (buffer) => {
  if (buffer.length < 2) return 2;
  const masked = (buffer[1] & MASK_MASK) !== 0;
  let length = buffer[1] & PAYLOAD_LEN_MASK;
  let offset = 2;
  if (length === LEN_16_BIT) {
    if (buffer.length < 4) return 4;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === LEN_64_BIT) {
    if (buffer.length < 10) return 10;
    const high = buffer.readUInt32BE(2);
    // Oversized frame: report current length so parse() runs
    // immediately and produces a Message too big error
    if ((high & MAX_SAFE_HIGH_MASK) !== 0) return buffer.length;
    length = high * TWO_32 + buffer.readUInt32BE(6);
    offset = 10;
  }
  if (masked) offset += 4;
  return offset + length;
};

const isControlOpcode = (opcode) => CONTROL_OPCODES.includes(opcode);

const isDataOpcode = (opcode) => opcode <= OPCODES.BINARY;

const checkClose = (payload) => {
  if (payload.length === 0) return Result.ok(true);
  if (payload.length === 1) return failParse('COMMON', 'Protocol error');
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2);
  if (!isValidCloseCode(code)) {
    return failParse('COMMON', `Invalid close code: ${code}`);
  }
  if (!isUtf8(reason)) {
    return failParse(INVALID_PAYLOAD, 'Invalid UTF-8 in close reason');
  }
  return Result.ok(true);
};

const checkControl = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isControlOpcode(opcode) || !fin) {
    return failParse('COMMON', 'Protocol error');
  }
  if (payload.length > MAX_CONTROL_PAYLOAD_BYTES) {
    return failParse('CTRL_TOO_LONG', 'Control frame too long');
  }
  if (opcode === OPCODES.CLOSE) return checkClose(payload);
  return Result.ok(true);
};

const checkData = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isDataOpcode(opcode)) return failParse('COMMON', 'Protocol error');
  const isText = opcode === OPCODES.TEXT;
  if (isText && fin && !isUtf8(payload)) {
    return failParse(INVALID_PAYLOAD, 'Invalid UTF-8 in text frame');
  }
  return Result.ok(true);
};

module.exports = { parse, frameLength, checkControl, checkData, ParseError };
