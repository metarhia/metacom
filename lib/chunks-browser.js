'use strict';

const ID_LENGTH_BYTES = 1;
const MAX_ID_LENGTH = 255;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const chunkEncode = (id, payload) => {
  const idBuffer = TEXT_ENCODER.encode(id);
  const idLength = idBuffer.length;
  if (idLength > MAX_ID_LENGTH) {
    const limit = `maximum of ${MAX_ID_LENGTH} characters`;
    throw new Error(`ID length ${idLength} exceeds ${limit}`);
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
  const id = TEXT_DECODER.decode(idBuffer);
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};

module.exports = { chunkEncode, chunkDecode };
