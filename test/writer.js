'use strict';

const metatests = require('metatests');
const writer = require('../lib/writer');
const { readBigUInt64LEFromBuffer } = require('../lib/utils');
const {
  PROTOCOL_VERSION,
  STRUCT_PARCEL_HEADER,
  STRUCT_CHUNK_HEADER,
  STRUCT_PING,
  STRUCT_PONG,
} = require('../lib/constants');

metatests.testSync('writer.writeHandshake', test => {
  const status = 1;
  const reserved = 0;
  const token = Buffer.from('A'.repeat(32));

  const handshakeBuffer = writer.writeHandshake({ status, reserved, token });

  test.strictSame(handshakeBuffer.readIntLE(0, 2), PROTOCOL_VERSION);
  test.strictSame(handshakeBuffer.readIntLE(2, 1), status);
  test.strictSame(handshakeBuffer.readIntLE(3, 1), reserved);
  test.strictSame(handshakeBuffer.slice(4), token);
});

metatests.testSync('writer.writeHandshake with empty token', test => {
  const status = 1;
  const reserved = 0;

  const handshakeBuffer = writer.writeHandshake({ status, reserved });

  test.strictSame(handshakeBuffer.readIntLE(0, 2), PROTOCOL_VERSION);
  test.strictSame(handshakeBuffer.readIntLE(2, 1), status);
  test.strictSame(handshakeBuffer.readIntLE(3, 1), reserved);
  test.strictSame(handshakeBuffer.slice(4), Buffer.alloc(32));
});

metatests.testSync('writer.writeParcelHeader', test => {
  const parcelId = 1;
  const parcelType = 3;
  const compression = 1;
  const encoding = 1;
  const length = BigInt(10);

  const parcelHeaderBuffer = writer.writeParcelHeader({
    parcelId,
    parcelType,
    compression,
    encoding,
    length,
  });

  test.strictSame(parcelHeaderBuffer.readIntLE(0, 1), STRUCT_PARCEL_HEADER);
  test.strictSame(parcelHeaderBuffer.readIntLE(1, 4), parcelId);
  test.strictSame(parcelHeaderBuffer.readIntLE(5, 1), parcelType);
  test.strictSame(parcelHeaderBuffer.readIntLE(6, 1), compression);
  test.strictSame(parcelHeaderBuffer.readIntLE(7, 1), encoding);
  test.strictSame(readBigUInt64LEFromBuffer(parcelHeaderBuffer, 8), length);
});

metatests.testSync('writer.writeChunk', test => {
  const parcelId = 1;
  const chunkId = 1;
  const flag = 1;
  const length = 10;
  const payload = Buffer.from('A'.repeat(10));

  const chunkBuffer = writer.writeChunk({
    parcelId,
    chunkId,
    flag,
    length,
    payload,
  });

  test.strictSame(chunkBuffer.readIntLE(0, 1), STRUCT_CHUNK_HEADER);
  test.strictSame(chunkBuffer.readIntLE(1, 4), parcelId);
  test.strictSame(chunkBuffer.readIntLE(5, 4), chunkId);
  test.strictSame(chunkBuffer.readIntLE(9, 1), flag);
  test.strictSame(chunkBuffer.readIntLE(10, 2), length);
  test.strictSame(chunkBuffer.slice(12), payload);
});

metatests.testSync('writer.writeChunk with empty payload', test => {
  const parcelId = 1;
  const chunkId = 1;
  const flag = 1;
  const length = 0;
  const payload = Buffer.alloc(0);

  const chunkBuffer = writer.writeChunk({
    parcelId,
    chunkId,
    flag,
    length,
    payload,
  });

  test.strictSame(chunkBuffer.readIntLE(0, 1), STRUCT_CHUNK_HEADER);
  test.strictSame(chunkBuffer.readIntLE(1, 4), parcelId);
  test.strictSame(chunkBuffer.readIntLE(5, 4), chunkId);
  test.strictSame(chunkBuffer.readIntLE(9, 1), flag);
  test.strictSame(chunkBuffer.readIntLE(10, 2), length);
  test.strictSame(chunkBuffer.slice(12), payload);
});

metatests.testSync('writer.writePing', test => {
  const pingBuffer = writer.writePing();
  test.strictSame(pingBuffer.readIntLE(0, 1), STRUCT_PING);
});

metatests.testSync('writer.writePong', test => {
  const pongBuffer = writer.writePong();
  test.strictSame(pongBuffer.readIntLE(0, 1), STRUCT_PONG);
});
