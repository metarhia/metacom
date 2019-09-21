'use strict';

const metatests = require('metatests');
const { readStructType, readPayloadLength } = require('../lib/parser-utils');
const {
  STRUCT_PARCEL_HEADER,
  STRUCT_CHUNK_HEADER,
} = require('../lib/constants');

metatests.test('readStructType', test => {
  const parcel = Buffer.alloc(10);
  parcel.writeIntLE(0, 0, 1);

  const chunk = Buffer.alloc(10);
  chunk.writeIntLE(1, 0, 1);

  test.strictSame(readStructType(parcel), STRUCT_PARCEL_HEADER);
  test.strictSame(readStructType(chunk), STRUCT_CHUNK_HEADER);

  test.end();
});

metatests.test('readPayloadLength', test => {
  const payloadLength = 123;
  const buffer = Buffer.alloc(12);
  buffer.writeIntLE(payloadLength, 10, 2);

  test.strictSame(readPayloadLength(buffer), payloadLength);

  test.end();
});
