'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OPCODES,
  FINAL_FRAME,
  LEN_64_BIT,
} = require('../../../lib/websocket/constants.js');
const {
  FrameParser,
  PARSE_ERR_CODES,
} = require('../../../lib/websocket/frameParser.js');
const { Frame } = require('../../../lib/websocket/frame.js');

// eslint-disable-next-line max-len
test('FrameParser: returns parse error when payload length exceeds MAX_SAFE_INTEGER', () => {
  const buffer = Buffer.alloc(14);
  buffer[0] = FINAL_FRAME & OPCODES.BINARY;
  buffer[1] = LEN_64_BIT;

  const bigValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  buffer.writeUInt32BE(Number(bigValue >> 32n), 2);
  buffer.writeUInt32BE(Number(bigValue & 0xffffffffn), 6);

  buffer.writeUInt32BE(0, 10);

  const result = FrameParser.parse(buffer);
  assert.ok(result.error, 'Expected parse result to contain an error');
  assert.strictEqual(result.error.name, 'ParseError');
  assert.strictEqual(result.error.code, PARSE_ERR_CODES.MESSAGE_TOO_BIG);
});

// eslint-disable-next-line max-len
test('FrameParser: returns empty result when buffer smaller than header', () => {
  const buf = Buffer.alloc(1); // less than 2 bytes header
  const res = FrameParser.parse(buf);
  assert.strictEqual(res.value, null);
  assert.strictEqual(res.error, null);
});

// eslint-disable-next-line max-len
test('FrameParser: returns empty when mask bit set but mask bytes missing', () => {
  // 0x81 = FIN + TEXT opcode, 0x80 = MASK bit set + 0 payload length
  const buf = Buffer.from([0x81, 0x80]);
  const res = FrameParser.parse(buf);
  assert.strictEqual(res.value, null);
  assert.strictEqual(res.error, null);
});

// eslint-disable-next-line max-len
test('FrameParser: parses masked frame and Frame.unmaskPayload recovers original', () => {
  const msg = 'ok';
  const frame = Frame.text(msg);
  frame.maskPayload(Buffer.from([1, 2, 3, 4]));
  const buf = frame.toBuffer();

  const res = FrameParser.parse(buf);
  assert.ok(res.value, 'expected a value');
  const parsed = res.value.frame;
  // frame should be marked masked; after unmask we get original text
  assert.strictEqual(parsed.masked, true);
  parsed.unmaskPayload();
  assert.strictEqual(parsed.toString(), msg);

  const expectedBytes = buf.length;
  assert.strictEqual(res.value.bytesUsed, expectedBytes);
});

// eslint-disable-next-line max-len
test('FrameParser: parses first of two concatenated frames and returns correct bytesUsed', () => {
  const f1 = Frame.text('first');
  const f2 = Frame.text('second');
  const buf = Buffer.concat([f1.toBuffer(), f2.toBuffer()]);

  const res = FrameParser.parse(buf);
  assert.ok(res.value, 'expected a value for first frame');
  const first = res.value.frame;
  assert.strictEqual(first.toString(), 'first');
  assert.strictEqual(res.value.bytesUsed, f1.toBuffer().length);
});
