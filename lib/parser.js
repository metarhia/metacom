'use strict';

const {
  writeBigIntToBuffer,
  readBigIntFromBuffer,
} = require('./bigint-buffer');

const constants = {
  PROTOCOL_VERSION: 1,
  HANDSHAKE_LENGTH: 36,
  PARCEL_LENGTH: 16,
  CHUNK_LENGTH: 12,
  STRUCT_PARCEL: 0,
  STRUCT_CHUNK: 1,
  PARCEL_PING: 0,
  PARCEL_PONG: 1,
  PARCEL_CALL: 2,
  PARCEL_CALLBACK: 3,
  PARCEL_EVENT: 4,
  PARCEL_STREAM: 5,
};

// Turn data into an array of payloads
//   string - <string>, payload
//   size - <number>, max chunk payload length
// Returns: <Buffer>
const partPayload = (string, size = 2048) => {
  if (!string.length)
    return [
      {
        chunkId: 1,
        payload: Buffer.alloc(0),
        length: 0,
      },
    ];

  const buffer = Buffer.from(string);
  const arrayOfChunks = [];

  for (let offset = 0; offset < string.length; offset += size) {
    const chunkId = offset / size;
    const payload = buffer.slice(offset, offset + size);
    const length = payload.length;
    arrayOfChunks.push({ chunkId, payload, length });
  }

  return arrayOfChunks;
};

// Read parcel from buffer
//   buffer - <Buffer>
// Returns: <Object>
const readParcel = buffer => ({
  structType: constants.STRUCT_PARCEL,
  parcelId: buffer.readIntLE(1, 4),
  parcelType: buffer.readIntLE(5, 1),
  compression: buffer.readIntLE(6, 1),
  encoding: buffer.readIntLE(7, 1),
  length: readBigIntFromBuffer(buffer, 8),
});

// Encode parcel structure to Buffer
//   parcel - <Object>
//     parcelId - <number>, id of parcel
//     parcelType - <number>, type of parcel
//     compression - <number>, compression type
//     encoding - <number>, encoding type
//     length - <bigint>, length of all parcel chunks payload
// Returns: <Buffer>
const writeParcel = parcel => {
  const buffer = Buffer.alloc(constants.PARCEL_LENGTH);
  buffer.writeIntLE(constants.STRUCT_PARCEL, 0, 1);
  buffer.writeIntLE(parcel.parcelId, 1, 4);
  buffer.writeIntLE(parcel.parcelType, 5, 1);
  buffer.writeIntLE(parcel.compression, 6, 1);
  buffer.writeIntLE(parcel.encoding, 7, 1);
  writeBigIntToBuffer(parcel.length, buffer, 8);
  return buffer;
};

// Read chunk from buffer
//   buffer - <Buffer>
// Returns: <Object>
const readChunk = buffer => {
  const length = buffer.readIntLE(10, 2);
  const chunk = {
    structType: constants.STRUCT_CHUNK,
    parcelId: buffer.readIntLE(1, 4),
    chunkId: buffer.readIntLE(5, 4),
    flag: buffer.readIntLE(9, 1),
    length,
    payload: buffer.slice(12, constants.CHUNK_LENGTH + length),
  };
  return chunk;
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
  const buffer = Buffer.alloc(constants.CHUNK_LENGTH + chunk.length);
  buffer.writeIntLE(constants.STRUCT_CHUNK, 0, 1);
  buffer.writeIntLE(chunk.parcelId, 1, 4);
  buffer.writeIntLE(chunk.chunkId, 5, 4);
  buffer.writeIntLE(chunk.flag, 9, 1);
  buffer.writeIntLE(chunk.length, 10, 2);
  chunk.payload.copy(buffer, 12);
  return buffer;
};

// Read handshake from buffer
//   buffer - <Buffer>
// Returns: <Object>
const readHandshake = buffer => ({
  version: buffer.readIntLE(0, 2),
  status: buffer.readIntLE(2, 1),
  reserved: buffer.readIntLE(3, 1),
  token: buffer.slice(4, constants.HANDSHAKE_LENGTH).toString(),
});

// Encode handshake structure to Buffer
//   handshake - <Object>
//     status - <number>, connection status
//     reserved - <number>
//     token - <string>, connection token, optional
// Returns: <Buffer>
const writeHandshake = handshake => {
  const buffer = Buffer.alloc(constants.HANDSHAKE_LENGTH);
  buffer.writeIntLE(constants.PROTOCOL_VERSION, 0, 2);
  buffer.writeIntLE(handshake.status, 2, 1);
  buffer.writeIntLE(handshake.reserved, 3, 1);
  buffer.write(handshake.token || '', 4);
  return buffer;
};

const structTypes = [/* 0 */ readParcel, /* 1 */ readChunk];

// Read length of chunk's payload
//   buffer - <Buffer>
// Returns: <number> payload length
const readPayloadLength = buffer => buffer.readIntLE(10, 2);

// Read type of structure
//   buffer - <Buffer>
// Returns: <number> type of structure
const readStructType = buffer => buffer.readIntLE(0, 1);

// Read structure from buffer
//   buffer - <Buffer>
// Returns: <Object>
const readStruct = buffer => {
  const structType = readStructType(buffer);
  const parser = structTypes[structType];
  if (parser) {
    return parser(buffer);
  } else {
    throw new Error('Parser not found');
  }
};

module.exports = {
  writeHandshake,
  readHandshake,
  writeChunk,
  readChunk,
  writeParcel,
  readParcel,
  readStruct,
  readStructType,
  partPayload,
  readPayloadLength,
  constants,
};
