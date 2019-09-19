'use strict';

const metatests = require('metatests');
const parser = require('../lib/parser');
const { writeBigIntToBuffer } = require('../lib/bigint-buffer');

const LONG_BUFFER_SIZE = 16384;
const testData = {};

const fillHandskakeBuffer = (handshake, buf) => {
  buf.writeIntLE(parser.constants.PROTOCOL_VERSION, 0, 2);
  buf.writeIntLE(handshake.status, 2, 1);
  buf.writeIntLE(handshake.reserved, 3, 1);
  buf.write(handshake.token, 4);
};

const fillParcelBuffer = (parcel, buf) => {
  buf.writeIntLE(parser.constants.STRUCT_PARCEL, 0, 1);
  buf.writeIntLE(parcel.parcelId, 1, 4);
  buf.writeIntLE(parcel.parcelType, 5, 1);
  buf.writeIntLE(parcel.compression, 6, 1);
  buf.writeIntLE(parcel.encoding, 7, 1);
  writeBigIntToBuffer(parcel.length, buf, 8);
};

const fillChunkBuffer = (chunk, buf) => {
  buf.writeIntLE(parser.constants.STRUCT_CHUNK, 0, 1);
  buf.writeIntLE(chunk.parcelId, 1, 4);
  buf.writeIntLE(chunk.chunkId, 5, 4);
  buf.writeIntLE(chunk.flag, 9, 1);
  buf.writeIntLE(chunk.length, 10, 2);
  chunk.payload.copy(buf, 12);
};

const initHandshakeTestData = () => {
  const handshake = {
    version: parser.constants.PROTOCOL_VERSION,
    status: 0,
    reserved: 0,
    token: '___METACOM__CONNECTION__TOKEN___'
  };

  const buffer = Buffer.alloc(36);
  fillHandskakeBuffer(handshake, buffer);

  const longBuffer = Buffer.alloc(LONG_BUFFER_SIZE);
  fillHandskakeBuffer(handshake, longBuffer);

  testData.handshake = { handshake, buffer, longBuffer };
};

const initParcelTestData = () => {
  const parcel = {
    structType: 0,
    parcelId: 1,
    parcelType: 0,
    compression: 0,
    encoding: 0,
    length: BigInt(12345) // eslint-disable-line no-undef, new-cap
  };

  const buffer = Buffer.alloc(parser.constants.PARCEL_LENGTH);
  fillParcelBuffer(parcel, buffer);

  const longBuffer = Buffer.alloc(LONG_BUFFER_SIZE);
  fillParcelBuffer(parcel, longBuffer);

  testData.parcel = { parcel, buffer, longBuffer };
};

const initChunkTestData = () => {
  const chunk = {
    structType: 1,
    parcelId: 1,
    chunkId: 0,
    flag: 1,
    length: '__PAYLOAD__'.length,
    payload: Buffer.from('__PAYLOAD__')
  };

  const emptyChunk = {
    structType: 1,
    parcelId: 1,
    chunkId: 0,
    flag: 1,
    length: 0,
    payload: Buffer.alloc(0)
  };

  const buffer = Buffer.alloc(parser.constants.CHUNK_LENGTH + chunk.length);
  fillChunkBuffer(chunk, buffer);

  const longBuffer = Buffer.alloc(LONG_BUFFER_SIZE);
  fillChunkBuffer(chunk, longBuffer);

  const emptyPayloadBuffer = Buffer.alloc(parser.constants.CHUNK_LENGTH);
  fillChunkBuffer(emptyChunk, emptyPayloadBuffer);

  const emptyPayloadLongBuffer = Buffer.alloc(LONG_BUFFER_SIZE);
  fillChunkBuffer(emptyChunk, emptyPayloadLongBuffer);

  testData.chunk = {
    chunk, emptyChunk,
    buffer, longBuffer,
    emptyPayloadBuffer, emptyPayloadLongBuffer
  };
};

initHandshakeTestData();
initParcelTestData();
initChunkTestData();

metatests.test('parser.readStructType', test => {
  const parcel = Buffer.alloc(parser.constants.PARCEL_LENGTH);
  parcel.writeIntLE(0, 0, 1);

  const chunk = Buffer.alloc(parser.constants.CHUNK_LENGTH);
  chunk.writeIntLE(1, 0, 1);

  test.strictSame(
    parser.readStructType(parcel),
    parser.constants.STRUCT_PARCEL,
    'must return struct type of parcel'
  );

  test.strictSame(
    parser.readStructType(chunk),
    parser.constants.STRUCT_CHUNK,
    'must return struct type of chunk'
  );

  test.end();
});

metatests.test('parser.readHandshake', test => {
  const { handshake, buffer, longBuffer } = testData.handshake;

  test.strictSame(
    parser.readHandshake(buffer),
    handshake,
    'must return appropriate handshake object'
  );

  test.strictSame(
    parser.readHandshake(longBuffer),
    handshake,
    'must return appropriate handshake object'
  );

  test.end();
});

metatests.test('parser.readParcel', test => {
  const { parcel, buffer, longBuffer } = testData.parcel;

  test.strictSame(
    parser.readParcel(buffer),
    parcel,
    'must return appropriate parcel object'
  );

  test.strictSame(
    parser.readParcel(longBuffer),
    parcel,
    'must return appropriate parcel object'
  );

  test.end();
});

metatests.test('parser.readChunk', test => {
  const {
    chunk, emptyChunk,
    buffer, longBuffer,
    emptyPayloadBuffer, emptyPayloadLongBuffer
  } = testData.chunk;

  test.strictSame(
    parser.readChunk(buffer),
    chunk,
    'must return appropriate chunk object'
  );

  test.strictSame(
    parser.readChunk(longBuffer),
    chunk,
    'must return appropriate chunk object'
  );

  test.strictSame(
    parser.readChunk(emptyPayloadBuffer),
    emptyChunk,
    'must return appropriate chunk object'
  );

  test.strictSame(
    parser.readChunk(emptyPayloadLongBuffer),
    emptyChunk,
    'must return appropriate chunk object'
  );

  test.end();
});

metatests.test('parser.handshake', test => {
  const { handshake, buffer } = testData.handshake;

  test.strictSame(
    parser.handshake(handshake),
    buffer,
    'must return appropriate buffer'
  );

  test.end();
});

metatests.test('parser.parcel', test => {
  const { parcel, buffer } = testData.parcel;

  test.strictSame(
    parser.parcel(parcel),
    buffer,
    'must return appropriate buffer'
  );

  test.end();
});

metatests.test('parser.chunk', test => {
  const {
    chunk, emptyChunk,
    buffer, emptyPayloadBuffer
  } = testData.chunk;

  test.strictSame(
    parser.chunk(chunk),
    buffer,
    'must return appropriate buffer'
  );

  test.strictSame(
    parser.chunk(emptyChunk),
    emptyPayloadBuffer,
    'must return appropriate buffer'
  );

  test.end();
});

metatests.test('parser.readStruct', test => {
  const { chunk, buffer: chunkBuffer } = testData.chunk;
  const { parcel, buffer: parcelBuffer } = testData.parcel;

  test.strictSame(
    parser.readStruct(chunkBuffer),
    chunk,
    'must return appropriate struct object'
  );

  test.strictSame(
    parser.readStruct(parcelBuffer),
    parcel,
    'must return appropriate struct object'
  );

  test.end();
});

metatests.test('parser.partPayload', test => {
  const emptyPayload = '';
  const emptyPayloadChunks = [{
    chunkId: 1,
    payload: Buffer.from(emptyPayload),
    length: emptyPayload.length
  }];

  const singlePayload = '__SINGLE_CHUNK_PAYLOAD__';
  const singlePayloadChunks = [{
    chunkId: 0,
    payload: Buffer.from(singlePayload),
    length: singlePayload.length
  }];

  const longPayloadBase = '__LONG_PAYLOAD__';
  const longPayload = longPayloadBase.repeat(2048);
  const longPayloadChunks = [];

  for (let i = 0, offset = 0; i < longPayloadBase.length; ++i, offset += 2048) {
    const part = longPayload.substring(offset, offset + 2048);
    longPayloadChunks.push({
      chunkId: i,
      payload: Buffer.from(part),
      length: part.length
    });
  }

  test.strictSame(
    parser.partPayload(emptyPayload),
    emptyPayloadChunks,
    'must return appropriate chunks array'
  );

  test.strictSame(
    parser.partPayload(singlePayload),
    singlePayloadChunks,
    'must return appropriate chunks array'
  );

  test.strictSame(
    parser.partPayload(longPayload),
    longPayloadChunks,
    'must return appropriate chunks array'
  );

  test.end();
});
