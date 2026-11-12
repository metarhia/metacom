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
const MASK_BYTES = 4;
const INCOMPLETE = -1;
const OVERSIZED = -2;
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

// Payload length and header size before mask, while extended length
// is incomplete length is INCOMPLETE and offset is bytes required
const readLength = (buffer) => {
  const code = buffer[1] & PAYLOAD_LEN_MASK;
  if (code === LEN_16_BIT) {
    if (buffer.length < 4) return { length: INCOMPLETE, offset: 4 };
    return { length: buffer.readUInt16BE(2), offset: 4 };
  }
  if (code !== LEN_64_BIT) return { length: code, offset: 2 };
  if (buffer.length < 10) return { length: INCOMPLETE, offset: 10 };
  const high = buffer.readUInt32BE(2);
  const isOversized = (high & MAX_SAFE_HIGH_MASK) !== 0;
  if (isOversized) return { length: OVERSIZED, offset: 10 };
  const length = high * TWO_32 + buffer.readUInt32BE(6);
  return { length, offset: 10 };
};

const parse = (buffer) => {
  if (buffer.length < 2) return Result.ok();

  const fin = (buffer[0] & FIN_MASK) !== 0;
  const rsv = buffer[0] & RSV_MASK;
  const opcode = buffer[0] & OPCODE_MASK;
  const masked = (buffer[1] & MASK_MASK) !== 0;
  if (rsv !== 0) return failParse('RSV', 'RSV bits must be 0');

  const { length, offset } = readLength(buffer);
  if (length === INCOMPLETE) return Result.ok();
  if (length === OVERSIZED) {
    const message = 'Payload length exceeds MAX_SAFE_INTEGER';
    return failParse('Message too big', message);
  }

  const start = masked ? offset + MASK_BYTES : offset;
  const end = start + length;
  if (buffer.length < end) return Result.ok();
  const mask = masked ? buffer.subarray(offset, start) : null;
  const payload = buffer.subarray(start, end);
  const frame = new Frame(fin, opcode, masked, payload, mask, rsv);
  return Result.ok({ frame, bytesUsed: end });
};

// Total byte size of the next frame in the buffer, or the minimum
// number of bytes required to determine it while the header is still
// incomplete. Lets callers buffer incoming chunks without re-parsing.
const frameLength = (buffer) => {
  if (buffer.length < 2) return 2;
  const { length, offset } = readLength(buffer);
  if (length === INCOMPLETE) return offset;
  // Oversized frame: report current length so parse() runs
  // immediately and produces a Message too big error
  if (length === OVERSIZED) return buffer.length;
  const masked = (buffer[1] & MASK_MASK) !== 0;
  const maskBytes = masked ? MASK_BYTES : 0;
  return offset + maskBytes + length;
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
