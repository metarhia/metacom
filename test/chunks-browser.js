'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { chunkEncode, chunkDecode } = require('../lib/chunks-browser.js');

test('chunkEncode: encodes string ID and payload', () => {
  const id = 'test-id';
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const chunk = chunkEncode(id, payload);

  assert.ok(chunk instanceof Uint8Array);
  assert.strictEqual(chunk[0], 7); // ID length
  assert.strictEqual(chunk.length, 1 + 7 + 5); // length byte + ID + payload
});

test('chunkEncode: handles empty payload', () => {
  const id = 'test';
  const payload = new Uint8Array([]);
  const chunk = chunkEncode(id, payload);

  assert.strictEqual(chunk[0], 4); // ID length
  assert.strictEqual(chunk.length, 1 + 4); // length byte + ID only
});

test('chunkEncode: handles single character ID', () => {
  const id = 'a';
  const payload = new Uint8Array([42]);
  const chunk = chunkEncode(id, payload);

  assert.strictEqual(chunk[0], 1); // ID length
  assert.strictEqual(chunk.length, 1 + 1 + 1); // length byte + ID + payload
});

test('chunkEncode: handles UTF-8 characters', () => {
  const id = 'тест'; // Cyrillic characters
  const payload = new Uint8Array([1, 2, 3]);
  const chunk = chunkEncode(id, payload);

  // UTF-8 encoded length is longer than character count
  assert.ok(chunk[0] > 4);
  assert.ok(chunk instanceof Uint8Array);
});

test('chunkEncode: throws error for ID exceeding 255 bytes', () => {
  const id = 'a'.repeat(256);
  const payload = new Uint8Array([1]);

  assert.throws(
    () => chunkEncode(id, payload),
    /ID length \d+ exceeds maximum of 255 characters/,
  );
});

test('chunkEncode: accepts maximum ID length of 255 bytes', () => {
  const id = 'a'.repeat(255);
  const payload = new Uint8Array([1]);
  const chunk = chunkEncode(id, payload);

  assert.strictEqual(chunk[0], 255);
  assert.strictEqual(chunk.length, 1 + 255 + 1);
});

test('chunkDecode: decodes chunk back to ID and payload', () => {
  const originalId = 'test-id';
  const originalPayload = new Uint8Array([1, 2, 3, 4, 5]);
  const chunk = chunkEncode(originalId, originalPayload);

  const { id, payload } = chunkDecode(chunk);

  assert.strictEqual(id, originalId);
  assert.deepStrictEqual(payload, originalPayload);
});

test('chunkDecode: handles empty payload', () => {
  const originalId = 'test';
  const originalPayload = new Uint8Array([]);
  const chunk = chunkEncode(originalId, originalPayload);

  const { id, payload } = chunkDecode(chunk);

  assert.strictEqual(id, originalId);
  assert.strictEqual(payload.length, 0);
});

test('chunkDecode: handles UTF-8 characters', () => {
  const originalId = '测试'; // Chinese characters
  const originalPayload = new Uint8Array([10, 20, 30]);
  const chunk = chunkEncode(originalId, originalPayload);

  const { id, payload } = chunkDecode(chunk);

  assert.strictEqual(id, originalId);
  assert.deepStrictEqual(payload, originalPayload);
});

test('chunkDecode: handles maximum ID length', () => {
  const originalId = 'x'.repeat(255);
  const originalPayload = new Uint8Array([99]);
  const chunk = chunkEncode(originalId, originalPayload);

  const { id, payload } = chunkDecode(chunk);

  assert.strictEqual(id, originalId);
  assert.deepStrictEqual(payload, originalPayload);
});

test('encode/decode: round-trip with various payloads', () => {
  const testCases = [
    { id: 'short', payload: new Uint8Array([1]) },
    {
      id: 'medium-id-name',
      payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    },
    { id: 'emoji-🚀', payload: new Uint8Array(Array(100).fill(42)) },
    { id: 'special!@#$%', payload: new Uint8Array([255, 0, 128, 64, 32]) },
  ];

  for (const { id: originalId, payload: originalPayload } of testCases) {
    const chunk = chunkEncode(originalId, originalPayload);
    const { id, payload } = chunkDecode(chunk);
    assert.strictEqual(id, originalId);
    assert.deepStrictEqual(payload, originalPayload);
  }
});

test('encode/decode: preserves binary data integrity', () => {
  const id = 'binary-test';
  const originalPayload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    originalPayload[i] = i;
  }

  const chunk = chunkEncode(id, originalPayload);
  const { id: decodedId, payload } = chunkDecode(chunk);

  assert.strictEqual(decodedId, id);
  assert.strictEqual(payload.length, 256);
  for (let i = 0; i < 256; i++) {
    assert.strictEqual(payload[i], i);
  }
});

test('browser/node compatibility: produces identical output', () => {
  const nodeEncoders = require('../lib/chunks.js');
  const id = 'compat-test';
  const payload = new Uint8Array([10, 20, 30, 40, 50]);

  const browserChunk = chunkEncode(id, payload);
  const nodeChunk = nodeEncoders.chunkEncode(id, payload);

  assert.deepStrictEqual(browserChunk, nodeChunk);
});

test('browser/node compatibility: can decode each others output', () => {
  const nodeEncoders = require('../lib/chunks.js');
  const id = 'cross-decode';
  const payload = new Uint8Array([100, 200]);

  const browserChunk = chunkEncode(id, payload);
  const nodeDecoded = nodeEncoders.chunkDecode(browserChunk);

  assert.strictEqual(nodeDecoded.id, id);
  assert.deepStrictEqual(nodeDecoded.payload, payload);

  const nodeChunk = nodeEncoders.chunkEncode(id, payload);
  const browserDecoded = chunkDecode(nodeChunk);

  assert.strictEqual(browserDecoded.id, id);
  assert.deepStrictEqual(browserDecoded.payload, payload);
});
