'use strict';

const PROTOCOL_VERSION = 1;
const HANDSHAKE_LENGTH = 36;
const PARCEL_LENGTH = 16;
const CHUNK_LENGTH = 12;

const readParcel = (buffer) => {
  // Read parcel from buffer
  // Return parcel object
  const rest = Buffer.from(buffer, 1, PARCEL_LENGTH);
  return rest;
};

const parcel = (
  // Encode handshake structure to Buffer
  // id, // parcelId: 4b
  // type, // parcelType: 4b
  // compression, // 1b: no = 0, gzip = 1
  // encoding, // 1b: binary = 0, jstp = 1, json = 2, bson = 3, v8 = 4
  // length // 8b
) => {
  const parcel = Buffer.alloc(PARCEL_LENGTH);
  parcel.writeInt8(0, 0);
  // Write parcel fields to buffer
  return parcel;
};

const readChunk = (buffer) => {
  // Read chunkk from buffer
  // Return chunk object
  const rest = Buffer.from(buffer, 1, CHUNK_LENGTH);
  return rest;
};

const chunk = (
  // Encode chunk structure to Buffer
  // id, // parcelId: 4b
  // flags, // 1b: more = 1, stop = 2, pause = 4, resume = 8
  // length, // 2b
  // payload // Buffer
) => {
  const chunk = Buffer.alloc(CHUNK_LENGTH);
  chunk.writeInt8(1, 0);
  // Write chunk fields to buffer
  return chunk;
};

const readHandshake = (buffer) => {
  // Read handshake from buffer
  // Return handshake object
  const rest = Buffer.from(buffer, 0, HANDSHAKE_LENGTH);
  return rest;
};

const handshake = (
  // Encode handshake structure to Buffer
  // status // 1b: 0 = new, 1 = restore
  // reserved // 1b
  // token // 32b (optional)
) => {
  const handshake = Buffer.alloc(HANDSHAKE_LENGTH);
  handshake.writeInt16LE(PROTOCOL_VERSION, 0);
  // Write handshake to buffer
  return handshake;
};

const structTypes = [
  /* 0 */ readParcel,
  /* 1 */ readChunk
];

const readStruct = (buffer) => {
  // Read structure from buffer
  // Return parcel or chunk object
  const structType = buffer.readInt8(0, true);
  const parser = structTypes[structType];
  if (parser) return parser(buffer);
};

module.exports = {
  handshake, readHandshake,
  chunk, readChunk,
  parcel, readParcel,
  readStruct
};
