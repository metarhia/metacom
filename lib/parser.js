'use strict';

const constants = require('./constants');
const { readBigUInt64LEFromBuffer } = require('./utils');

// Parses handshake from buffer
//   buffer - <Buffer>
// Returns: <Object>
const parseHandshake = buffer => ({
  version: buffer.readIntLE(0, 2),
  status: buffer.readIntLE(2, 1),
  reserved: buffer.readIntLE(3, 1),
  token: buffer.slice(4, constants.HANDSHAKE_SIZE),
});

// Parses parcel header from buffer
//   buffer - <Buffer>
// Returns: <Object>
const parseParcelHeader = buffer => ({
  structType: constants.STRUCT_PARCEL_HEADER,
  parcelId: buffer.readIntLE(1, 4),
  parcelType: buffer.readIntLE(5, 1),
  compression: buffer.readIntLE(6, 1),
  encoding: buffer.readIntLE(7, 1),
  length: readBigUInt64LEFromBuffer(buffer, 8),
});

// Parses chunk from buffer
//   buffer - <Buffer>
// Returns: <Object>
const parseChunk = buffer => {
  const length = buffer.readIntLE(10, 2);
  return {
    structType: constants.STRUCT_CHUNK_HEADER,
    parcelId: buffer.readIntLE(1, 4),
    chunkId: buffer.readIntLE(5, 4),
    flag: buffer.readIntLE(9, 1),
    length,
    payload: buffer.slice(12, constants.CHUNK_HEADER_SIZE + length),
  };
};
module.exports = {
  parseHandshake,
  parseParcelHeader,
  parseChunk,
};
