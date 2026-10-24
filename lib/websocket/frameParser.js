'use strict';

const { isUtf8 } = require('node:buffer');

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { Frame } = require('./frame.js');
const { Result } = require('./result.js');

const FIN_MASK = 0x80;
const RSV_MASK = 0x70;
const OPCODE_MASK = 0x0f;
const MASK_MASK = 0x80;
const PAYLOAD_LEN_MASK = 0x7f;
const LEN_16_BIT = 126;
const LEN_64_BIT = 127;
const MAX_SAFE_HIGH_MASK = 0xffe00000;
const TWO_32 = 4294967296;
const VALID_USER_CLOSE_CODES = { MIN: 3000, MAX: 4999 };

const VALID_CLOSE_CODES = new Set([
  CLOSE_CODES.NORMAL_CLOSE,
  CLOSE_CODES.GOING_AWAY,
  CLOSE_CODES.PROTOCOL_ERROR,
  CLOSE_CODES.UNSUPPORTED_DATA,
  CLOSE_CODES.INVALID_PAYLOAD,
  CLOSE_CODES.POLICY_VIOLATED,
  CLOSE_CODES.MESSAGE_TOO_BIG,
  CLOSE_CODES.MANDATORY_EXTENSION,
  CLOSE_CODES.INTERNAL_SERVER_ERROR,
]);

const isValidCloseCode = (code) => {
  if (VALID_CLOSE_CODES.has(code)) return true;
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

const parse = (buffer) => {
  if (buffer.length < 2) return Result.ok();

  const fin = (buffer[0] & FIN_MASK) !== 0;
  const rsv = buffer[0] & RSV_MASK;
  const opcode = buffer[0] & OPCODE_MASK;
  const masked = (buffer[1] & MASK_MASK) !== 0;
  let length = buffer[1] & PAYLOAD_LEN_MASK;
  let offset = 2;

  if (rsv !== 0) {
    const error = new ParseError('RSV', 'RSV bits must be 0');
    return Result.fail(error);
  }

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
      const error = new ParseError(
        'MESSAGE_TOO_BIG',
        'Payload length exceeds MAX_SAFE_INTEGER',
      );
      return Result.fail(error);
    }
    length = high * TWO_32 + low;
  }

  let mask;
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
const expectedFrameLength = (buffer) => {
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
    // immediately and produces a MESSAGE_TOO_BIG error
    if ((high & MAX_SAFE_HIGH_MASK) !== 0) return buffer.length;
    length = high * TWO_32 + buffer.readUInt32BE(6);
    offset = 10;
  }
  if (masked) offset += 4;
  return offset + length;
};

const isControlOpcode = (opcode) =>
  opcode === OPCODES.CLOSE ||
  opcode === OPCODES.PING ||
  opcode === OPCODES.PONG;

const isDataOpcode = (opcode) => opcode <= OPCODES.BINARY;

const checkControlFrame = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isControlOpcode(opcode) || !fin) {
    const error = new ParseError('COMMON', 'Protocol error');
    return Result.fail(error);
  }
  if (payload.length > 125) {
    const error = new ParseError('CTRL_TOO_LONG', 'Control frame too long');
    return Result.fail(error);
  }
  if (opcode === OPCODES.CLOSE) {
    if (payload.length === 0) return Result.ok(true);
    if (payload.length === 1) {
      const error = new ParseError('COMMON', 'Protocol error');
      return Result.fail(error);
    }
    const code = payload.readUInt16BE(0);
    const reason = payload.subarray(2);
    if (!isValidCloseCode(code)) {
      const error = new ParseError('COMMON', `Invalid close code: ${code}`);
      return Result.fail(error);
    }
    if (!isUtf8(reason)) {
      const error = new ParseError(
        'INVALID_PAYLOAD',
        'Invalid UTF-8 in close reason',
      );
      return Result.fail(error);
    }
  }
  return Result.ok(true);
};

const checkDataFrame = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isDataOpcode(opcode)) {
    const error = new ParseError('COMMON', 'Protocol error');
    return Result.fail(error);
  }
  const isText = opcode === OPCODES.TEXT;
  if (isText && fin && !isUtf8(payload)) {
    const error = new ParseError(
      'INVALID_PAYLOAD',
      'Invalid UTF-8 in text frame',
    );
    return Result.fail(error);
  }
  return Result.ok(true);
};

module.exports = {
  parse,
  expectedFrameLength,
  checkControlFrame,
  checkDataFrame,
  ParseError,
};
