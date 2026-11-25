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
const CHECK_PASSED = Result.ok(true);

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

// Extended payload length follows the second byte: 0, 2, or 8 bytes
const headerBytes = (buffer) => {
  const code = buffer[1] & PAYLOAD_LEN_MASK;
  if (code === LEN_16_BIT) return 4;
  if (code === LEN_64_BIT) return 10;
  return 2;
};

// Payload length, INCOMPLETE while the extended length is not received
const readLength = (buffer, offset) => {
  if (buffer.length < offset) return INCOMPLETE;
  const code = buffer[1] & PAYLOAD_LEN_MASK;
  if (code === LEN_16_BIT) return buffer.readUInt16BE(2);
  if (code !== LEN_64_BIT) return code;
  const high = buffer.readUInt32BE(2);
  const isOversized = (high & MAX_SAFE_HIGH_MASK) !== 0;
  if (isOversized) return OVERSIZED;
  return high * TWO_32 + buffer.readUInt32BE(6);
};

// Complete frame, null while bytes are missing, or ParseError
const readFrame = (buffer) => {
  if (buffer.length < 2) return null;
  const rsv = buffer[0] & RSV_MASK;
  if (rsv !== 0) return new ParseError('RSV', 'RSV bits must be 0');
  const offset = headerBytes(buffer);
  const length = readLength(buffer, offset);
  if (length === INCOMPLETE) return null;
  if (length === OVERSIZED) {
    const message = 'Payload length exceeds MAX_SAFE_INTEGER';
    return new ParseError('Message too big', message);
  }
  const masked = (buffer[1] & MASK_MASK) !== 0;
  const start = masked ? offset + MASK_BYTES : offset;
  const end = start + length;
  if (buffer.length < end) return null;
  const fin = (buffer[0] & FIN_MASK) !== 0;
  const opcode = buffer[0] & OPCODE_MASK;
  const mask = masked ? buffer.subarray(offset, start) : null;
  const payload = buffer.subarray(start, end);
  return new Frame(fin, opcode, masked, payload, mask, rsv);
};

// Payload of a parsed frame is a view on the tail of the frame bytes
const frameEnd = (buffer, frame) => {
  const { payload } = frame;
  return payload.byteOffset - buffer.byteOffset + payload.length;
};

const parse = (buffer) => {
  const frame = readFrame(buffer);
  if (frame instanceof ParseError) return Result.fail(frame);
  if (frame === null) return Result.ok();
  const bytesUsed = frameEnd(buffer, frame);
  return Result.ok({ frame, bytesUsed });
};

// Full frame size, or how many header bytes are still required
const frameLength = (buffer) => {
  if (buffer.length < 2) return 2;
  const offset = headerBytes(buffer);
  const length = readLength(buffer, offset);
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

const closeError = (payload) => {
  if (payload.length === 0) return null;
  if (payload.length === 1) return new ParseError('COMMON', 'Protocol error');
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2);
  if (!isValidCloseCode(code)) {
    return new ParseError('COMMON', `Invalid close code: ${code}`);
  }
  if (!isUtf8(reason)) {
    return new ParseError(INVALID_PAYLOAD, 'Invalid UTF-8 in close reason');
  }
  return null;
};

const controlError = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isControlOpcode(opcode) || !fin) {
    return new ParseError('COMMON', 'Protocol error');
  }
  if (payload.length > MAX_CONTROL_PAYLOAD_BYTES) {
    return new ParseError('CTRL_TOO_LONG', 'Control frame too long');
  }
  if (opcode === OPCODES.CLOSE) return closeError(payload);
  return null;
};

const dataError = (frame) => {
  const { fin, opcode, payload } = frame;
  if (!isDataOpcode(opcode)) return new ParseError('COMMON', 'Protocol error');
  const isText = opcode === OPCODES.TEXT;
  if (isText && fin && !isUtf8(payload)) {
    return new ParseError(INVALID_PAYLOAD, 'Invalid UTF-8 in text frame');
  }
  return null;
};

// Result is immutable, one passed check serves every frame
const toResult = (error) => (error ? Result.fail(error) : CHECK_PASSED);

const checkControl = (frame) => toResult(controlError(frame));

const checkData = (frame) => toResult(dataError(frame));

module.exports = {
  readFrame,
  frameEnd,
  parse,
  frameLength,
  controlError,
  dataError,
  checkControl,
  checkData,
  ParseError,
};
