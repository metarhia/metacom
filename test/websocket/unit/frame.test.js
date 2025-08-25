'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { Frame } = require('../../../lib/websocket/frame.js');
const { OPCODES } = require('../../../lib/websocket/constants.js');
const { FrameParser } = require('../../../lib/websocket/frameParser.js');

test('Frame: create and parse text frame', () => {
  const message = 'Hello tinyWS';
  const frame = Frame.text(message);

  const buffer = frame.toBuffer();
  const parsedFrame = FrameParser.parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.opcode, OPCODES.TEXT);
  assert.strictEqual(parsedFrame.toString(), message);
});

test('Frame: mask and unmask payload', () => {
  const payload = Buffer.from('mask-test');
  const frame = Frame.text(payload);

  frame.maskPayload(Buffer.from([1, 2, 3, 4]));
  const maskedPayload = Buffer.from(frame.payload);

  frame.unmaskPayload();
  assert.strictEqual(frame.toString(), 'mask-test');

  assert.notDeepStrictEqual(maskedPayload, frame.payload);
});

test('Frame: create binary frame', () => {
  const data = crypto.randomBytes(10);
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = FrameParser.parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.opcode, OPCODES.BINARY);
  assert.deepStrictEqual(parsedFrame.payload, data);
});

test('Frame: extended 16-bit length', () => {
  const data = Buffer.alloc(200, 0x42); //B
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = FrameParser.parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.payload.length, 200);
  assert.deepStrictEqual(parsedFrame.payload, data);
});

test('Frame: extended 64-bit length', () => {
  const size = 70 * 1024;
  const data = Buffer.alloc(size, 0x42); //B
  const frame = Frame.binary(data);
  const buffer = frame.toBuffer();
  const parsedFrame = FrameParser.parse(buffer).value.frame;

  assert.strictEqual(parsedFrame.payload.length, size);
  assert.deepStrictEqual(parsedFrame.payload, data);
});
