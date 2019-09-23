'use strict';

const metatests = require('metatests');
const {
  writeBigUInt64LEToBuffer,
  readBigUInt64LEFromBuffer,
} = require('../lib/utils');

metatests.testSync('writeBigUInt64LEToBuffer', test => {
  const buffer = Buffer.alloc(8);

  writeBigUInt64LEToBuffer(BigInt(0x0a), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0xf0f1), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0xf1, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0xffffff), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0x0a1b2c3d), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0x3d, 0x2c, 0x1b, 0x0a, 0x00, 0x00, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0xf0f1f2f3f4), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0xf4, 0xf3, 0xf2, 0xf1, 0xf0, 0x00, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0xffffffffffff), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00])
  );

  buffer.fill(0);

  writeBigUInt64LEToBuffer(BigInt(0x0a1b2c3d4e5f60), buffer);
  test.strictSame(
    buffer,
    Buffer.from([0x60, 0x5f, 0x4e, 0x3d, 0x2c, 0x1b, 0x0a, 0x00])
  );

  buffer.fill(0);

  const largestUInt64 = (BigInt(0xffffffff) << BigInt(32)) | BigInt(0xffffffff);
  writeBigUInt64LEToBuffer(largestUInt64, buffer);
  test.strictSame(
    buffer,
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  );
});

metatests.testSync('readBigUInt64LEFromBuffer', test => {
  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    ),
    BigInt(0x0a)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0xf1, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    ),
    BigInt(0xf0f1)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00])
    ),
    BigInt(0xffffff)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0x3d, 0x2c, 0x1b, 0x0a, 0x00, 0x00, 0x00, 0x00])
    ),
    BigInt(0x0a1b2c3d)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0xf4, 0xf3, 0xf2, 0xf1, 0xf0, 0x00, 0x00, 0x00])
    ),
    BigInt(0xf0f1f2f3f4)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00])
    ),
    BigInt(0xffffffffffff)
  );

  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0x60, 0x5f, 0x4e, 0x3d, 0x2c, 0x1b, 0x0a, 0x00])
    ),
    BigInt(0x0a1b2c3d4e5f60)
  );

  const largestUInt64 = (BigInt(0xffffffff) << BigInt(32)) | BigInt(0xffffffff);
  test.strictSame(
    readBigUInt64LEFromBuffer(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    ),
    largestUInt64
  );
});
