'use strict';

const { Readable } = require('node:stream');
const metatests = require('metatests');
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
  id: metautil.random(UINT_8_MAX),
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

metatests.test('Chunk / encode / decode', (test) => {
  const { id } = generatePacket();
  const dataView = generateDataView();
  const chunkView = chunkEncode(id, dataView);
  test.type(chunkView, 'Uint8Array');
  const decoded = chunkDecode(chunkView);
  test.strictEqual(decoded.id, id);
  test.strictEqual(decoded.payload, dataView);
  test.end();
});

metatests.test('MetaWritable / constructor', (test) => {
  const { id, name, size } = generatePacket();
  const [, writeBuffer] = createWritable(id, name, size);
  test.strictEqual(writeBuffer.length, 1);
  const packet = writeBuffer.pop();
  test.type(packet, 'string');
  const parsed = JSON.parse(packet);
  test.strictEqual(parsed.type, 'stream');
  test.strictEqual(parsed.id, id);
  test.strictEqual(parsed.name, name);
  test.strictEqual(parsed.size, size);
  test.end();
});

metatests.test(
  'MetaWritable / end: should send packet with "end" status',
  (test) => {
    const { id, name, size } = generatePacket();
    const [writable, writeBuffer] = createWritable(id, name, size);
    test.strictEqual(writeBuffer.length, 1);
    writable.end();
    test.strictEqual(writeBuffer.length, 2);
    const packet = writeBuffer.pop();
    test.strictEqual(typeof packet, 'string');
    const parsed = JSON.parse(packet);
    test.strictEqual(parsed.type, 'stream');
    test.strictEqual(parsed.id, id);
    test.strictEqual(parsed.status, 'end');
    test.end();
  },
);

metatests.test(
  'MetaWritable / terminate: should send packet with "terminate" status',
  (test) => {
    const { id, name, size } = generatePacket();
    const [writable, writeBuffer] = createWritable(id, name, size);
    test.strictEqual(writeBuffer.length, 1);
    writable.terminate();
    test.strictEqual(writeBuffer.length, 2);
    const packet = writeBuffer.pop();
    test.type(packet, 'string');
    const parsed = JSON.parse(packet);
    test.strictEqual(parsed.type, 'stream');
    test.strictEqual(parsed.id, id);
    test.strictEqual(parsed.status, 'terminate');
    test.end();
  },
);

metatests.test('MetaWritable / write: should send encoded packet', (test) => {
  const { id, name, size } = generatePacket();
  const [writable, writeBuffer] = createWritable(id, name, size);
  const dataView = generateDataView();
  test.strictEqual(writeBuffer.length, 1);
  const result = writable.write(dataView);
  test.strictEqual(result, true);
  test.strictEqual(writeBuffer.length, 2);
  const packet = writeBuffer.pop();
  test.type(packet, 'Uint8Array');
  const decoded = chunkDecode(packet);
  test.strictEqual(decoded.id, id);
  test.strictEqual(decoded.payload, dataView);
  test.end();
});

metatests.test('MetaReadable', async (test) => {
  const dataView = generateDataView();
  const { id, name } = generatePacket();
  const size = dataView.buffer.byteLength;
  const stream = new MetaReadable(id, name, size);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const received = Buffer.concat(chunks);
  test.strictEqual(received, buffer);
  test.end();
});

metatests.test('MetaReadable / toBlob', async (test) => {
  const dataView = generateDataView();
  const { id, name } = generatePacket();
  const size = dataView.buffer.byteLength;
  const stream = new MetaReadable(id, name, size);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const blob = await stream.toBlob();
  const arrayBuffer = await blob.arrayBuffer();
  const received = new Uint8Array(arrayBuffer);
  test.strictEqual(received, dataView);
  test.end();
});
