'use strict';

// Read length of chunk's payload
//   buffer - <Buffer>
// Returns: <number> payload length
const readPayloadLength = buffer => buffer.readIntLE(10, 2);

// Read type of structure
//   buffer - <Buffer>
// Returns: <number> type of structure
const readStructType = buffer => buffer.readIntLE(0, 1);

module.exports = {
  readPayloadLength,
  readStructType,
};
