'use strict';

const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert');
const metautil = require('metautil');
const streams = require('../lib/streams.js');
const { chunkEncode, chunkDecode, MetaReadable, MetaWritable } = streams;

const UINT_8_MAX = 255;

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

const generatePacket = () => ({
  id: randomUUID(),
  name: metautil.random(UINT_8_MAX).toString(),
  size: metautil.random(UINT_8_MAX),
});

const generateDataView = () => {
  const encoder = new TextEncoder();
  const randomString = [...new Array(metautil.random(UINT_8_MAX))]
    .map(() => metautil.random(UINT_8_MAX))
    .map((num) => String.fromCharCode(num))
    .join('');
  return encoder.encode(randomString);
};

const createWritable = (id, name, size) => {
  const writeBuffer = [];
  const transport = {
    send: (packet) => writeBuffer.push(JSON.stringify(packet)),
    write: (data) => writeBuffer.push(data),
  };
  const stream = new MetaWritable(id, name, size, transport);
  return [stream, writeBuffer];
};

const populateStream = (stream) => ({
  with: (buffer) =>
    Readable.from(buffer)
      .on('data', (chunk) => stream.push(chunk))
      .on('end', () => stream.stop()),
});

test('Chunk / encode / decode', () => {
  const { id } = generatePacket();
  const dataView = generateDataView();
  const chunkView = chunkEncode(id, dataView);
  assert.strictEqual(typeof chunkView, 'object');
  assert.strictEqual(chunkView.constructor.name, 'Uint8Array');
  const decoded = chunkDecode(chunkView);
  assert.strictEqual(decoded.id, id);
  assert.deepStrictEqual(decoded.payload, dataView);
});

test('Chunk / encode / decode with different ID lengths', () => {
  const testCases = [
    'short',
    'medium_length_id',
    'very_long_identifier_for_testing_purposes',
    randomUUID(),
    'a',
    '123456789012345678901234567890123456789012345678901234567890',
  ];

  for (const id of testCases) {
    const dataView = generateDataView();
    const chunkView = chunkEncode(id, dataView);
    test.type(chunkView, 'Uint8Array');
    const decoded = chunkDecode(chunkView);
    test.strictEqual(decoded.id, id);
    test.strictEqual(decoded.payload, dataView);
  }
});

test('Chunk / encode validation for ID length limit', () => {
  const maxId = 'a'.repeat(255);
  const dataView = generateDataView();

  const chunkView = chunkEncode(maxId, dataView);
  test.type(chunkView, 'Uint8Array');
  const decoded = chunkDecode(chunkView);
  test.strictEqual(decoded.id, maxId);
  test.strictEqual(decoded.payload, dataView);

  const tooLongId = 'a'.repeat(256);

  test.throws(() => {
    chunkEncode(tooLongId, dataView);
  }, /ID length 256 exceeds maximum of 255 characters/);
});

test('MetaWritable / constructor', () => {
  const { id, name, size } = generatePacket();
  const [, writeBuffer] = createWritable(id, name, size);
  assert.strictEqual(writeBuffer.length, 1);
  const packet = writeBuffer.pop();
  assert.strictEqual(typeof packet, 'string');
  const parsed = JSON.parse(packet);
  assert.strictEqual(parsed.type, 'stream');
  assert.strictEqual(parsed.id, id);
  assert.strictEqual(parsed.name, name);
  assert.strictEqual(parsed.size, size);
});

test('MetaWritable / end: should send packet with "end" status', () => {
  const { id, name, size } = generatePacket();
  const [writable, writeBuffer] = createWritable(id, name, size);
  assert.strictEqual(writeBuffer.length, 1);
  writable.end();
  assert.strictEqual(writeBuffer.length, 2);
  const packet = writeBuffer.pop();
  assert.strictEqual(typeof packet, 'string');
  const parsed = JSON.parse(packet);
  assert.strictEqual(parsed.type, 'stream');
  assert.strictEqual(parsed.id, id);
  assert.strictEqual(parsed.status, 'end');
});

test('MetaWritable / terminate: sends packet with "terminate" status', () => {
  const { id, name, size } = generatePacket();
  const [writable, writeBuffer] = createWritable(id, name, size);
  assert.strictEqual(writeBuffer.length, 1);
  writable.terminate();
  assert.strictEqual(writeBuffer.length, 2);
  const packet = writeBuffer.pop();
  assert.strictEqual(typeof packet, 'string');
  const parsed = JSON.parse(packet);
  assert.strictEqual(parsed.type, 'stream');
  assert.strictEqual(parsed.id, id);
  assert.strictEqual(parsed.status, 'terminate');
});

test('MetaWritable / write: should send encoded packet', () => {
  const { id, name, size } = generatePacket();
  const [writable, writeBuffer] = createWritable(id, name, size);
  const dataView = generateDataView();
  assert.strictEqual(writeBuffer.length, 1);
  const result = writable.write(dataView);
  assert.strictEqual(result, true);
  assert.strictEqual(writeBuffer.length, 2);
  const packet = writeBuffer.pop();
  assert.strictEqual(typeof packet, 'object');
  assert.strictEqual(packet.constructor.name, 'Uint8Array');
  const decoded = chunkDecode(packet);
  assert.strictEqual(decoded.id, id);
  assert.deepStrictEqual(decoded.payload, dataView);
});

test('MetaReadable', async () => {
  const dataView = generateDataView();
  const { id, name } = generatePacket();
  const size = dataView.buffer.byteLength;
  const stream = new MetaReadable(id, name, size);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const received = Buffer.concat(chunks);
  assert.deepStrictEqual(received, buffer);
});

test('MetaReadable / toBlob', async () => {
  const dataView = generateDataView();
  const { id, name } = generatePacket();
  const size = dataView.buffer.byteLength;
  const stream = new MetaReadable(id, name, size);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const blob = await stream.toBlob();
  const arrayBuffer = await blob.arrayBuffer();
  const received = new Uint8Array(arrayBuffer);
  assert.deepStrictEqual(received, dataView);
});
