'use strict';

// Converts bigint to array of UInt32
//   bn - <bigint>
// Returns: <number[]>
const bigUInt64LEToUInt32 = bn => {
  const b1 = Number(bn & BigInt(0xffffffff));
  const b2 = Number((bn >> BigInt(32)) & BigInt(0xffffffff));
  return [b1, b2];
};

// Converts array of UInt32 to bigint
//   b1 - <number>, first part of bigint
//   b2 - <number>, second part of bigint
// Returns: <bigint>
const bigUInt64LEFromUInt32 = ([b1, b2]) => {
  b1 = BigInt(b1);
  b2 = BigInt(b2);
  return (b2 << BigInt(32)) | b1;
};

// Writes bigint to buffer
//   bn - <bigint>
//   buffer - <Buffer>
//   offset - <number>
const writeBigUInt64LEToBuffer = (bn, buffer, offset = 0) => {
  const [b1, b2] = bigUInt64LEToUInt32(bn);
  buffer.writeUInt32LE(b1, offset);
  buffer.writeUInt32LE(b2, offset + 4);
};

// Reads bigint from buffer
//   buffer - <Buffer>
//   offset - <number>
// Returns: <bigint>
const readBigUInt64LEFromBuffer = (buffer, offset = 0) => {
  const b1 = buffer.readUInt32LE(offset);
  const b2 = buffer.readUInt32LE(offset + 4);
  return bigUInt64LEFromUInt32([b1, b2]);
};

module.exports = {
  writeBigUInt64LEToBuffer,
  readBigUInt64LEFromBuffer,
};
