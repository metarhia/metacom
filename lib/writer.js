'use strict';

const constants = require('./constants');
const { writeBigIntToBuffer } = require('./utils');

// Encode handshake structure to Buffer
//   handshake - <Object>
//     status - <number>, connection status
//     reserved - <number>
//     token - <Buffer>, connection token, optional
// Returns: <Buffer>
const writeHandshake = handshake => {
  const buffer = Buffer.alloc(constants.HANDSHAKE_SIZE);
  buffer.writeIntLE(constants.PROTOCOL_VERSION, 0, 2);
  buffer.writeIntLE(handshake.status, 2, 1);
  buffer.writeIntLE(handshake.reserved, 3, 1);
  if (handshake.token) {
    handshake.token.copy(buffer, 4);
  }
  return buffer;
};

// Encode parcel header structure to Buffer
//   parcelHeader - <Object>
//     parcelId - <number>, id of parcel
//     parcelType - <number>, type of parcel
//     compression - <number>, compression type
//     encoding - <number>, encoding type
//     length - <bigint>, length of all parcel chunks payload
// Returns: <Buffer>
const writeParcelHeader = parcelHeader => {
  const buffer = Buffer.alloc(constants.PARCEL_HEADER_SIZE);
  buffer.writeIntLE(constants.STRUCT_PARCEL_HEADER, 0, 1);
  buffer.writeIntLE(parcelHeader.parcelId, 1, 4);
  buffer.writeIntLE(parcelHeader.parcelType, 5, 1);
  buffer.writeIntLE(parcelHeader.compression, 6, 1);
  buffer.writeIntLE(parcelHeader.encoding, 7, 1);
  writeBigIntToBuffer(parcelHeader.length, buffer, 8);
  return buffer;
};

// Encode chunk structure to Buffer
//   chunk - <Object>
//     parcelId - <number>, id of parcel
//     chunkId - <number>, id of chunk
//     flag - <number>, type of flag
//     length - <number>, payload length
//     payload - <Buffer>, chunk payload
// Returns: <Buffer>
const writeChunk = chunk => {
  const buffer = Buffer.alloc(constants.CHUNK_HEADER_SIZE + chunk.length);
  buffer.writeIntLE(constants.STRUCT_CHUNK_HEADER, 0, 1);
  buffer.writeIntLE(chunk.parcelId, 1, 4);
  buffer.writeIntLE(chunk.chunkId, 5, 4);
  buffer.writeIntLE(chunk.flag, 9, 1);
  buffer.writeIntLE(chunk.length, 10, 2);
  chunk.payload.copy(buffer, 12);
  return buffer;
};

module.exports = {
  writeHandshake,
  writeChunk,
  writeParcelHeader,
};
