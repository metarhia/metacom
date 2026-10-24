'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ws = require('#ws');
const { OPCODES } = ws;
const { Frame, parse, expectedFrameLength } = ws;
const { checkControlFrame, checkDataFrame } = ws;

const FIN = 0x80;
const LEN_64_BIT = 127;

test('FrameParser: payload length > MAX_SAFE_INTEGER -> error', () => {
  const buffer = Buffer.alloc(14);
  buffer[0] = FIN | OPCODES.BINARY;
  buffer[1] = LEN_64_BIT;

  const bigValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  buffer.writeUInt32BE(Number(bigValue >> 32n), 2);
  buffer.writeUInt32BE(Number(bigValue & 0xffffffffn), 6);

  buffer.writeUInt32BE(0, 10);

  const result = parse(buffer);
  assert.ok(result.error, 'Expected parse result to contain an error');
  assert.strictEqual(result.error.name, 'ParseError');
  assert.strictEqual(result.error.code, 'MESSAGE_TOO_BIG');
});

test('FrameParser: empty result when buffer smaller than header', () => {
  const buf = Buffer.alloc(1); // less than 2 bytes header
  const res = parse(buf);
  assert.strictEqual(res.value, null);
  assert.strictEqual(res.error, null);
});

test('FrameParser: empty when mask set but mask bytes missing', () => {
  // 0x81 = FIN + TEXT opcode, 0x80 = MASK bit set + 0 payload length
  const buf = Buffer.from([0x81, 0x80]);
  const res = parse(buf);
  assert.strictEqual(res.value, null);
  assert.strictEqual(res.error, null);
});

test('FrameParser: masked frame, unmaskPayload recovers original', () => {
  const msg = 'ok';
  const frame = Frame.text(msg);
  frame.maskPayload();
  const buf = frame.toBuffer();

  const res = parse(buf);
  assert.ok(res.value, 'expected a value');
  const parsed = res.value.frame;
  assert.strictEqual(parsed.fin, true);
  assert.strictEqual(parsed.masked, true);
  parsed.unmaskPayload();
  assert.strictEqual(parsed.toString(), msg);

  const expectedBytes = buf.length;
  assert.strictEqual(res.value.bytesUsed, expectedBytes);
});

test('FrameParser: first of two concatenated frames, bytesUsed', () => {
  const f1 = Frame.text('first');
  const f2 = Frame.text('second');
  const buf = Buffer.concat([f1.toBuffer(), f2.toBuffer()]);

  const res = parse(buf);
  assert.ok(res.value, 'expected a value for first frame');
  const first = res.value.frame;
  assert.strictEqual(first.toString(), 'first');
  assert.strictEqual(res.value.bytesUsed, f1.toBuffer().length);
});

test('expectedFrameLength: needs 2 bytes for header', () => {
  assert.strictEqual(expectedFrameLength(Buffer.alloc(0)), 2);
  assert.strictEqual(expectedFrameLength(Buffer.alloc(1)), 2);
});

test('expectedFrameLength: short unmasked and masked frames', () => {
  const unmasked = Frame.text('hello').toBuffer();
  assert.strictEqual(expectedFrameLength(unmasked), unmasked.length);
  const frame = Frame.text('hello');
  frame.maskPayload();
  const masked = frame.toBuffer();
  assert.strictEqual(expectedFrameLength(masked), masked.length);
  assert.strictEqual(expectedFrameLength(masked.subarray(0, 3)), 2 + 4 + 5);
});

test('expectedFrameLength: 16-bit length frame', () => {
  const buf = Frame.binary(Buffer.alloc(300)).toBuffer();
  assert.strictEqual(expectedFrameLength(buf.subarray(0, 2)), 4);
  assert.strictEqual(expectedFrameLength(buf.subarray(0, 4)), buf.length);
});

test('expectedFrameLength: 64-bit length frame', () => {
  const buf = Frame.binary(Buffer.alloc(70000)).toBuffer();
  assert.strictEqual(expectedFrameLength(buf.subarray(0, 2)), 10);
  assert.strictEqual(expectedFrameLength(buf.subarray(0, 10)), buf.length);
});

test('expectedFrameLength: oversized frame reports current length', () => {
  const buffer = Buffer.alloc(10);
  buffer[0] = FIN | OPCODES.BINARY;
  buffer[1] = LEN_64_BIT;
  buffer.writeUInt32BE(0xffffffff, 2);
  assert.strictEqual(expectedFrameLength(buffer), buffer.length);
});

test('checkControlFrame: rejects too long control frame', () => {
  const frame = new Frame(true, OPCODES.PING, false, Buffer.alloc(126));
  const { error } = checkControlFrame(frame);
  assert.strictEqual(error.code, 'CTRL_TOO_LONG');
});

test('checkControlFrame: rejects invalid close code', () => {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(1005);
  const frame = new Frame(true, OPCODES.CLOSE, false, payload);
  const { error } = checkControlFrame(frame);
  assert.strictEqual(error.code, 'COMMON');
});

test('checkDataFrame: rejects invalid UTF-8 in final text frame', () => {
  const payload = Buffer.from([0xff, 0xfe]);
  const frame = new Frame(true, OPCODES.TEXT, false, payload);
  const { error } = checkDataFrame(frame);
  assert.strictEqual(error.code, 'INVALID_PAYLOAD');
});

test('Frame: mask defaults to null', () => {
  const frame = new Frame(true, OPCODES.TEXT, false, Buffer.from('a'));
  assert.strictEqual(frame.mask, null);
});
