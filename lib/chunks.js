'use strict';

const ID_LENGTH_BYTES = 1;

const chunkEncode = (id, payload) => {
  const idLength = Buffer.byteLength(id, 'utf8');
  if (idLength > 255) {
    throw new Error(`ID length ${idLength} exceeds maximum of 255 characters`);
  }
  const chunk = new Uint8Array(ID_LENGTH_BYTES + idLength + payload.length);
  const view = Buffer.from(chunk.buffer);
  chunk[0] = idLength;
  view.write(id, ID_LENGTH_BYTES, 'utf8');
  chunk.set(payload, ID_LENGTH_BYTES + idLength);
  return chunk;
};

const chunkDecode = (chunk) => {
  const idLength = chunk[0];
  const view = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  const idEnd = ID_LENGTH_BYTES + idLength;
  const id = view.toString('utf8', ID_LENGTH_BYTES, idEnd);
  const payload = chunk.subarray(idEnd);
  return { id, payload };
};

module.exports = { chunkEncode, chunkDecode };
