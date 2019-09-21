'use strict';

// Convert bigint to array of UInt32
//   bn - <bigint>
// Returns: <number[]>
const bigintToUInt32 = bn => {
  const b1 = Number(bn & BigInt(0xffffffff));
  const b2 = Number((bn >> BigInt(32)) & BigInt(0xffffffff));
  return [b1, b2];
};

// Convert array of UInt32 to bigint
//   b1 - <number>, first part of bigint
//   b2 - <number>, second part of bigint
// Returns: <bigint>
const bigintFromUInt32 = ([b1, b2]) => {
  b1 = BigInt(b1);
  b2 = BigInt(b2);
  return (b2 << BigInt(32)) | b1;
};

/* eslint-enable no-undef, new-cap */

// Write bigint to buffer
//   bn - <bigint>
//   buffer - <Buffer>
//   offset - <number>
const writeBigIntToBuffer = (bn, buffer, offset = 0) => {
  const [b1, b2] = bigintToUInt32(bn);
  buffer.writeUInt32LE(b1, offset);
  buffer.writeUInt32LE(b2, offset + 4);
};

// Read bigint from buffer
//   buffer - <Buffer>
//   offset - <number>
// Returns: <bigint>
const readBigIntFromBuffer = (buffer, offset = 0) => {
  const b1 = buffer.readUInt32LE(offset);
  const b2 = buffer.readUInt32LE(offset + 4);
  return bigintFromUInt32([b1, b2]);
};

module.exports = {
  writeBigIntToBuffer,
  readBigIntFromBuffer,
};
