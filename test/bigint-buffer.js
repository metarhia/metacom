'use strict';

const metatests = require('metatests');
const {
  writeBigIntToBuffer,
  readBigIntFromBuffer
} = require('../lib/bigint-buffer');

const BUFFER_SIZE = 8;

const bigints = [
  0x0an,
  0xf0f1n,
  0xffffffn,
  0x0a1b2c3dn,
  0xf0f1f2f3f4n,
  0xffffffffffffn,
  0x0a1b2c3d4e5f60n,
  0xffffffffffffffffn,
];

const buffers = [
  Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xf1, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x3d, 0x2c, 0x1b, 0x0a, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xf4, 0xf3, 0xf2, 0xf1, 0xf0, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]),
  Buffer.from([0x60, 0x5f, 0x4e, 0x3d, 0x2c, 0x1b, 0x0a, 0x00]),
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
];

metatests.test('write bigint to buffer', test => {
  let buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[0], buffer);

  test.strictSame(
    buffer,
    buffers[0],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[1], buffer);

  test.strictSame(
    buffer,
    buffers[1],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[2], buffer);

  test.strictSame(
    buffer,
    buffers[2],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[3], buffer);

  test.strictSame(
    buffer,
    buffers[3],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[4], buffer);

  test.strictSame(
    buffer,
    buffers[4],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[5], buffer);

  test.strictSame(
    buffer,
    buffers[5],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[6], buffer);

  test.strictSame(
    buffer,
    buffers[6],
    'must write correct bytes to buffer'
  );

  buffer = Buffer.alloc(BUFFER_SIZE);
  writeBigIntToBuffer(bigints[7], buffer);

  test.strictSame(
    buffer,
    buffers[7],
    'must write correct bytes to buffer'
  );


  test.end();
});

metatests.test('read bigint from buffer', test => {
  test.strictSame(
    readBigIntFromBuffer(buffers[0]),
    bigints[0],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[1]),
    bigints[1],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[2]),
    bigints[2],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[3]),
    bigints[3],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[4]),
    bigints[4],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[5]),
    bigints[5],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[6]),
    bigints[6],
    'must return correct bigint'
  );

  test.strictSame(
    readBigIntFromBuffer(buffers[7]),
    bigints[7],
    'must return correct bigint'
  );

  test.end();
});
