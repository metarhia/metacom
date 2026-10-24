'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { Frame, parse, checkControlFrame, OPCODES } = require('#ws');

test('Frame: create and parse text frame', () => {
  const message = 'Hello tinyWS';
  const frame = Frame.text(message);

  const buffer = frame.toBuffer();
  const parsedFrame = parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.opcode, OPCODES.TEXT);
  assert.strictEqual(parsedFrame.toString(), message);
});

test('Frame: mask and unmask payload', () => {
  const payload = Buffer.from('mask-test');
  const frame = Frame.text(payload);

  frame.maskPayload();
  assert.strictEqual(frame.masked, true);
  assert.strictEqual(frame.mask.length, 4);
  const maskedPayload = Buffer.from(frame.payload);

  frame.unmaskPayload();
  assert.strictEqual(frame.masked, false);
  assert.strictEqual(frame.toString(), 'mask-test');

  assert.notDeepStrictEqual(maskedPayload, frame.payload);
});

test('Frame: create binary frame', () => {
  const data = crypto.randomBytes(10);
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.opcode, OPCODES.BINARY);
  assert.deepStrictEqual(parsedFrame.payload, data);
});

test('Frame: extended 16-bit length', () => {
  const data = Buffer.alloc(200, 0x42); //B
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.payload.length, 200);
  assert.deepStrictEqual(parsedFrame.payload, data);
});

test('Frame: extended 64-bit length', () => {
  const size = 70 * 1024;
  const data = Buffer.alloc(size, 0x42); //B
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.payload.length, size);
  assert.deepStrictEqual(parsedFrame.payload, data);
});

test('Frame: truncates close reason to 123 bytes', () => {
  const reason = 'x'.repeat(200);
  const frame = Frame.close(1000, reason);

  assert.strictEqual(frame.payload.length, 2 + 123);
  const parsed = parse(frame.toBuffer()).value.frame;
  const check = checkControlFrame(parsed);
  assert.strictEqual(check.error, null);
});

test('Frame: ping with no payload', () => {
  const frame = Frame.ping();
  assert.strictEqual(frame.opcode, OPCODES.PING);
  assert.strictEqual(frame.fin, true);
  assert.strictEqual(frame.masked, false);
  assert.strictEqual(frame.payload.length, 0);
});

test('Frame: ping with string payload', () => {
  const frame = Frame.ping('hello');
  assert.strictEqual(frame.opcode, OPCODES.PING);
  assert.deepStrictEqual(frame.payload, Buffer.from('hello'));
});

test('Frame: pong with no payload', () => {
  const frame = Frame.pong();
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  assert.strictEqual(frame.fin, true);
  assert.strictEqual(frame.masked, false);
  assert.strictEqual(frame.payload.length, 0);
});

test('Frame: pong with string payload', () => {
  const frame = Frame.pong('hello');
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  assert.deepStrictEqual(frame.payload, Buffer.from('hello'));
});

test('Frame: emptyClientPingBuffer returns 6-byte masked buffer', () => {
  const buf = Frame.emptyClientPingBuffer();
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.length, 6);
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x80);
});

test('Frame: emptyClientPongBuffer returns 6-byte masked buffer', () => {
  const buf = Frame.emptyClientPongBuffer();
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.length, 6);
  assert.strictEqual(buf[0], 0x8a);
  assert.strictEqual(buf[1], 0x80);
});

test('Frame: emptyClientPingBuffer randomises the mask on each call', () => {
  const a = Frame.emptyClientPingBuffer();
  const b = Frame.emptyClientPingBuffer();
  assert.strictEqual(a[0], b[0]);
  assert.strictEqual(a[1], b[1]);
  const aMask = a.subarray(2);
  const bMask = b.subarray(2);
  // Probabilistic: masks should differ across independent calls
  assert.ok(!aMask.equals(bMask));
});

test('Frame: errorClose returns a Buffer with correct close code', () => {
  const buf = Frame.errorClose('MESSAGE_TOO_BIG');
  assert.ok(Buffer.isBuffer(buf));
  const code = buf.readUInt16BE(2);
  assert.strictEqual(code, 1009);
});

// eslint-disable-next-line max-len
test('Frame: protocolErrorClose returns a Buffer with protocol error code', () => {
  const buf = Frame.protocolErrorClose('COMMON');
  assert.ok(Buffer.isBuffer(buf));
  const code = buf.readUInt16BE(2);
  assert.strictEqual(code, 1002);
});

test('Frame: protocolErrorClose isClient masks the payload', () => {
  const serverBuf = Frame.protocolErrorClose('UNMASKED');
  const clientBuf = Frame.protocolErrorClose('UNMASKED', true);
  assert.ok(clientBuf.length > serverBuf.length);
});

test('Frame: getCloseDetails extracts code and reason', () => {
  const frame = Frame.close(1001, 'going away');
  const { value, error } = frame.getCloseDetails();
  assert.strictEqual(error, null);
  assert.strictEqual(value.code, 1001);
  assert.strictEqual(value.reason, 'going away');
});

test('Frame: getCloseDetails with no payload returns null code', () => {
  const frame = Frame.close(null);
  const result = frame.getCloseDetails();
  assert.strictEqual(result.value.code, null);
  assert.strictEqual(result.value.reason, '');
});

test('Frame: isControlFrame true for ping, pong, close', () => {
  assert.strictEqual(Frame.ping().isControlFrame, true);
  assert.strictEqual(Frame.pong().isControlFrame, true);
  assert.strictEqual(Frame.close(1000).isControlFrame, true);
});

test('Frame: isControlFrame false for text and binary', () => {
  assert.strictEqual(Frame.text('hi').isControlFrame, false);
  assert.strictEqual(Frame.binary(Buffer.from([1])).isControlFrame, false);
});

test('Frame: toString returns null for non-text frames', () => {
  assert.strictEqual(Frame.binary(Buffer.from([1, 2])).toString(), null);
  assert.strictEqual(Frame.ping().toString(), null);
  assert.strictEqual(Frame.close(1000).toString(), null);
});
