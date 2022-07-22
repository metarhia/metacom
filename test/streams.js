'use strict';

const { Readable } = require('stream');
const metatests = require('metatests');
const metautil = require('metautil');
const {
  MetacomReadable,
  MetacomWritable,
  MetacomChunk,
} = require('../lib/streams');

const UINT_8_MAX = 255;

const generateInitData = () => ({
  streamId: metautil.random(UINT_8_MAX),
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

const createWritable = (initData) => {
  const writeBuffer = [];
  const transport = { send: (packet) => writeBuffer.push(packet) };
  const stream = new MetacomWritable(transport, initData);
  return [stream, writeBuffer];
};

const populateStream = (stream) => ({
  with: (buffer) =>
    Readable.from(buffer)
      .on('data', (chunk) => stream.push(chunk))
      .on('data', () => stream.stop()),
});

metatests.test('MetacomChunk / encode / decode', (test) => {
  const initData = generateInitData();
  const dataView = generateDataView();
  const chunkView = MetacomChunk.encode(initData.streamId, dataView);
  test.type(chunkView, 'Uint8Array');
  const decoded = MetacomChunk.decode(chunkView);
  test.strictEqual(decoded.streamId, initData.streamId);
  test.strictEqual(decoded.payload, dataView);
  test.end();
});

metatests.test('MetacomWritable / constructor', (test) => {
  const initData = generateInitData();
  const [, writeBuffer] = createWritable(initData);
  test.strictEqual(writeBuffer.length, 1);
  const packet = writeBuffer.pop();
  test.type(packet, 'string');
  const parsed = JSON.parse(packet);
  test.strictEqual(parsed.stream, initData.streamId);
  test.strictEqual(parsed.name, initData.name);
  test.strictEqual(parsed.size, initData.size);
  test.end();
});

metatests.test(
  'MetacomWritable / end: should send packet with "end" status',
  (test) => {
    const initData = generateInitData();
    const [writable, writeBuffer] = createWritable(initData);
    test.strictEqual(writeBuffer.length, 1);
    writable.end();
    test.strictEqual(writeBuffer.length, 2);
    const packet = writeBuffer.pop();
    test.strictEqual(typeof packet, 'string');
    const parsed = JSON.parse(packet);
    test.strictEqual(parsed.stream, initData.streamId);
    test.strictEqual(parsed.status, 'end');
    test.end();
  },
);

metatests.test(
  'MetacomWritable / terminate: should send packet with "terminate" status',
  (test) => {
    const initData = generateInitData();
    const [writable, writeBuffer] = createWritable(initData);
    test.strictEqual(writeBuffer.length, 1);
    writable.terminate();
    test.strictEqual(writeBuffer.length, 2);
    const packet = writeBuffer.pop();
    test.type(packet, 'string');
    const parsed = JSON.parse(packet);
    test.strictEqual(parsed.stream, initData.streamId);
    test.strictEqual(parsed.status, 'terminate');
    test.end();
  },
);

metatests.test(
  'MetacomWritable / write: should send encoded packet',
  (test) => {
    const initData = generateInitData();
    const [writable, writeBuffer] = createWritable(initData);
    const dataView = generateDataView();
    test.strictEqual(writeBuffer.length, 1);
    const result = writable.write(dataView);
    test.strictEqual(result, true);
    test.strictEqual(writeBuffer.length, 2);
    const packet = writeBuffer.pop();
    test.type(packet, 'Uint8Array');
    const decoded = MetacomChunk.decode(packet);
    test.strictEqual(decoded.streamId, initData.streamId);
    test.strictEqual(decoded.payload, dataView);
    test.end();
  },
);

metatests.test('MetacomReadable', async (test) => {
  const dataView = generateDataView();
  const initData = generateInitData();
  Object.assign(initData, { size: dataView.buffer.byteLength });
  const stream = new MetacomReadable(initData);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const received = Buffer.concat(chunks);
  test.strictEqual(received, buffer);
  test.end();
});

metatests.test('MetacomReadable / toBlob', async (test) => {
  const dataView = generateDataView();
  const initData = generateInitData();
  Object.assign(initData, { size: dataView.buffer.byteLength });
  const stream = new MetacomReadable(initData);
  const buffer = Buffer.from(dataView.buffer);
  populateStream(stream).with(buffer);
  const blob = await stream.toBlob();
  const arrayBuffer = await blob.arrayBuffer();
  const received = new Uint8Array(arrayBuffer);
  test.strictEqual(received, dataView);
  test.end();
});
