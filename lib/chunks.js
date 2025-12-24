'use strict';

const ID_LENGTH_BYTES = 1;

const chunkEncode = (id, payload) => {
  const idBuffer = Buffer.from(id, 'utf8');
  const idLength = idBuffer.length;
  if (idLength > 255) {
    throw new Error(`ID length ${idLength} exceeds maximum of 255 characters`);
  }
  const chunk = new Uint8Array(ID_LENGTH_BYTES + idLength + payload.length);
  chunk[0] = idLength;
  chunk.set(idBuffer, ID_LENGTH_BYTES);
  chunk.set(payload, ID_LENGTH_BYTES + idLength);
  return chunk;
};

const chunkDecode = (chunk) => {
  const idLength = chunk[0];
  const idBuffer = chunk.subarray(ID_LENGTH_BYTES, ID_LENGTH_BYTES + idLength);
  const id = Buffer.from(idBuffer).toString('utf8');
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};

module.exports = { chunkEncode, chunkDecode };
