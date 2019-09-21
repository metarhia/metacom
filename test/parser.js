'use strict';

const metatests = require('metatests');
const parser = require('../lib/parser');
const { writeBigIntToBuffer } = require('../lib/utils');
const {
  HANDSHAKE_SIZE,
  PARCEL_HEADER_SIZE,
  CHUNK_HEADER_SIZE,
} = require('../lib/constants');

metatests.test('parser.parseHandshake', test => {
  const status = 1;
  const reserved = 0;
  const token = Buffer.from('A'.repeat(32));

  const buffer = Buffer.alloc(HANDSHAKE_SIZE);

  buffer.writeIntLE(status, 2, 1);
  buffer.writeIntLE(reserved, 3, 1);
  token.copy(buffer, 4);

  const handshake = parser.parseHandshake(buffer);

  test.strictSame(handshake.status, status);
  test.strictSame(handshake.reserved, reserved);
  test.strictSame(handshake.token, token);

  test.end();
});

metatests.test('parser.parseHandshake with longer buffer', test => {
  const status = 1;
  const reserved = 0;
  const token = Buffer.from('A'.repeat(32));

  const buffer = Buffer.alloc(HANDSHAKE_SIZE + 10);

  buffer.writeIntLE(status, 2, 1);
  buffer.writeIntLE(reserved, 3, 1);
  token.copy(buffer, 4);

  const handshake = parser.parseHandshake(buffer);

  test.strictSame(handshake.status, status);
  test.strictSame(handshake.reserved, reserved);
  test.strictSame(handshake.token, token);

  test.end();
});

metatests.test('parser.parseParcelHeader', test => {
  const parcelId = 1;
  const parcelType = 3;
  const compression = 1;
  const encoding = 1;
  const length = BigInt(10);

  const buffer = Buffer.alloc(PARCEL_HEADER_SIZE);

  buffer.writeIntLE(parcelId, 1, 4);
  buffer.writeIntLE(parcelType, 5, 1);
  buffer.writeIntLE(compression, 6, 1);
  buffer.writeIntLE(encoding, 7, 1);
  writeBigIntToBuffer(length, buffer, 8);

  const parcel = parser.parseParcelHeader(buffer);

  test.strictSame(parcel.parcelId, parcelId);
  test.strictSame(parcel.parcelType, parcelType);
  test.strictSame(parcel.compression, compression);
  test.strictSame(parcel.encoding, encoding);
  test.strictSame(parcel.length, length);

  test.end();
});

metatests.test('parser.parseParcelHeader with longer buffer', test => {
  const parcelId = 1;
  const parcelType = 3;
  const compression = 1;
  const encoding = 1;
  const length = BigInt(10);

  const buffer = Buffer.alloc(PARCEL_HEADER_SIZE + 10);

  buffer.writeIntLE(parcelId, 1, 4);
  buffer.writeIntLE(parcelType, 5, 1);
  buffer.writeIntLE(compression, 6, 1);
  buffer.writeIntLE(encoding, 7, 1);
  writeBigIntToBuffer(length, buffer, 8);

  const parcel = parser.parseParcelHeader(buffer);

  test.strictSame(parcel.parcelId, parcelId);
  test.strictSame(parcel.parcelType, parcelType);
  test.strictSame(parcel.compression, compression);
  test.strictSame(parcel.encoding, encoding);
  test.strictSame(parcel.length, length);

  test.end();
});

metatests.test('parser.parseChunk', test => {
  const parcelId = 1;
  const chunkId = 1;
  const flag = 1;
  const length = 10;
  const payload = Buffer.from('A'.repeat(10));

  const buffer = Buffer.alloc(CHUNK_HEADER_SIZE + length);

  buffer.writeIntLE(parcelId, 1, 4);
  buffer.writeIntLE(chunkId, 5, 4);
  buffer.writeIntLE(flag, 9, 1);
  buffer.writeIntLE(length, 10, 2);
  payload.copy(buffer, 12);

  const chunk = parser.parseChunk(buffer);

  test.strictSame(chunk.parcelId, parcelId);
  test.strictSame(chunk.chunkId, chunkId);
  test.strictSame(chunk.flag, flag);
  test.strictSame(chunk.length, length);
  test.strictSame(chunk.payload, payload);

  test.end();
});

metatests.test('parser.parseChunk with longer buffer', test => {
  const parcelId = 1;
  const chunkId = 1;
  const flag = 1;
  const length = 10;
  const payload = Buffer.from('A'.repeat(10));

  const buffer = Buffer.alloc(CHUNK_HEADER_SIZE + length + 10);

  buffer.writeIntLE(parcelId, 1, 4);
  buffer.writeIntLE(chunkId, 5, 4);
  buffer.writeIntLE(flag, 9, 1);
  buffer.writeIntLE(length, 10, 2);
  payload.copy(buffer, 12);

  const chunk = parser.parseChunk(buffer);

  test.strictSame(chunk.parcelId, parcelId);
  test.strictSame(chunk.chunkId, chunkId);
  test.strictSame(chunk.flag, flag);
  test.strictSame(chunk.length, length);
  test.strictSame(chunk.payload, payload);

  test.end();
});

metatests.test('parser.parseChunk with empty payload', test => {
  const parcelId = 1;
  const chunkId = 1;
  const flag = 1;
  const length = 0;
  const payload = Buffer.alloc(0);

  const buffer = Buffer.alloc(CHUNK_HEADER_SIZE);

  buffer.writeIntLE(parcelId, 1, 4);
  buffer.writeIntLE(chunkId, 5, 4);
  buffer.writeIntLE(flag, 9, 1);
  buffer.writeIntLE(length, 10, 2);
  payload.copy(buffer, 12);

  const chunk = parser.parseChunk(buffer);

  test.strictSame(chunk.parcelId, parcelId);
  test.strictSame(chunk.chunkId, chunkId);
  test.strictSame(chunk.flag, flag);
  test.strictSame(chunk.length, length);
  test.strictSame(chunk.payload, payload);

  test.end();
});
