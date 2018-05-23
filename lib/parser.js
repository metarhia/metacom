'use strict';

const HANDSHAKE_LENGTH = 36;
const PARCEL_LENGTH = 16;
const CHUNK_LENGTH = 12;

const parcel = (buffer) => {
  // Read parcel from buffer
  // Return parcel object
  const rest = Buffer.from(buffer, 1, PARCEL_LENGTH);
  return rest;
};

const chunk = (buffer) => {
  // Read chunkk from buffer
  // Return chunk object
  const rest = Buffer.from(buffer, 1, CHUNK_LENGTH);
  return rest;
};

const handshake = (buffer) => {
  // Read handshake from buffer
  // Return handshake object
  const rest = Buffer.from(buffer, 0, HANDSHAKE_LENGTH);
  return rest;
};

const structTypes = [
  /* 0 */ parcel,
  /* 1 */ chunk
];

const structure = (buffer) => {
  // Read structure from buffer
  // Return parcel or chunk object
  const structType = buffer.readInt8(0, true);
  const parser = structTypes[structType];
  if (parser) return parser(buffer);
};

module.exports = { structure, handshake, chunk, parcel };
