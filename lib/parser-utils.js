'use strict';

// Read type of structure
//   buffer - <Buffer>
// Returns: <number> type of structure
const readStructType = buffer => buffer.readIntLE(0, 1);

// Read length of chunk's payload
//   buffer - <Buffer>
// Returns: <number> payload length
const readPayloadLength = buffer => buffer.readIntLE(10, 2);

module.exports = {
  readStructType,
  readPayloadLength,
};
