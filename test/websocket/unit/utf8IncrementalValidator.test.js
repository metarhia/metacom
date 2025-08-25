'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  Utf8IncrementalValidator,
} = require('../../../lib/websocket/utils/utf8IncrementalValidator.js');

test('validator accepts ASCII bytes', () => {
  const v = new Utf8IncrementalValidator();
  assert.strictEqual(v.push(Buffer.from('hello')), true);
});

test('validator accepts multi-byte sequence in one chunk (euro sign)', () => {
  const v = new Utf8IncrementalValidator();
  // U+20AC -> E2 82 AC
  assert.strictEqual(v.push(Buffer.from([0xe2, 0x82, 0xac])), true);
});

test('validator accepts fragmented multi-byte sequence across pushes', () => {
  const v = new Utf8IncrementalValidator();
  // U+1F600 😀 -> F0 9F 98 80
  const part1 = Buffer.from([0xf0, 0x9f]); // first two bytes
  const part2 = Buffer.from([0x98, 0x80]); // remainder
  assert.strictEqual(v.push(part1), true, 'first fragment should be ok so far');
  assert.strictEqual(
    v.push(part2, true),
    true,
    'second fragment with fin should complete valid sequence',
  );
});

test('overlong encoding is rejected (C0 80)', () => {
  const v = new Utf8IncrementalValidator();
  assert.strictEqual(v.push(Buffer.from([0xc0, 0x80])), false);
  // validator becomes sticky-invalid
  assert.strictEqual(v.push(Buffer.from('a')), false);
});

test('surrogate half (ED A0 80) is rejected', () => {
  const v = new Utf8IncrementalValidator();
  assert.strictEqual(v.push(Buffer.from([0xed, 0xa0, 0x80])), false);
});

test('invalid continuation byte after lead is rejected', () => {
  const v = new Utf8IncrementalValidator();
  // 0xE2 expects continuation 0x80..0xBF; 0x41 is invalid
  assert.strictEqual(v.push(Buffer.from([0xe2, 0x41])), false);
});

test('4-byte sequence exceeding U+10FFFF is rejected (F4 90 ..)', () => {
  const v = new Utf8IncrementalValidator();
  // F4 second byte must be 0x80..0x8F; 0x90 is invalid
  assert.strictEqual(v.push(Buffer.from([0xf4, 0x90, 0x80, 0x80])), false);
});

test('dangling sequence at fin is rejected', () => {
  const v = new Utf8IncrementalValidator();
  // start a 3-byte sequence but mark fin=true immediately
  assert.strictEqual(v.push(Buffer.from([0xe2]), true), false);
});

test('reset allows reuse after error', () => {
  const v = new Utf8IncrementalValidator();
  assert.strictEqual(v.push(Buffer.from([0xc0, 0x80])), false);
  v.reset();
  // now valid ASCII should be accepted
  assert.strictEqual(v.push(Buffer.from('ok')), true);
});

test('validator accepts a 4-byte sequence split across three pushes', () => {
  const v = new Utf8IncrementalValidator();
  // 😀 U+1F600 -> F0 9F 98 80
  assert.strictEqual(v.push(Buffer.from([0xf0])), true);
  assert.strictEqual(v.push(Buffer.from([0x9f])), true);
  assert.strictEqual(v.push(Buffer.from([0x98, 0x80]), true), true);
});

// eslint-disable-next-line max-len
test('validator rejects when continuation byte in later chunk is invalid', () => {
  const v = new Utf8IncrementalValidator();
  // start a 3-byte seq (E2) but provide invalid continuation in next chunk
  assert.strictEqual(v.push(Buffer.from([0xe2])), true);
  assert.strictEqual(v.push(Buffer.from([0x41])), false); // 0x41 not 0x80..0xBF
});

// eslint-disable-next-line max-len
test('validator becomes sticky-invalid when error occurs in middle of sequence', () => {
  const v = new Utf8IncrementalValidator();

  // start a 3-byte sequence (E2) in first chunk
  assert.strictEqual(v.push(Buffer.from([0xe2])), true);
  // next (non-final) chunk contains invalid continuation -> should fail
  assert.strictEqual(v.push(Buffer.from([0x41])), false);
  // subsequent correct bytes must still return false (sticky)
  assert.strictEqual(v.push(Buffer.from([0x80])), false);
});

// eslint-disable-next-line max-len
test('validator accepts valid 4-byte sequence split across multiple pushes', () => {
  const v = new Utf8IncrementalValidator();
  // U+1F600 😀 -> F0 9F 98 80
  assert.strictEqual(v.push(Buffer.from([0xf0])), true);
  assert.strictEqual(v.push(Buffer.from([0x9f])), true);
  assert.strictEqual(v.push(Buffer.from([0x98])), true);
  assert.strictEqual(v.push(Buffer.from([0x80]), true), true);
});

// eslint-disable-next-line max-len
test('validator rejects invalid 4-byte sequence split across multiple pushes', () => {
  const v = new Utf8IncrementalValidator();
  // U+1F600 😀 -> F0 9F 98 80
  assert.strictEqual(v.push(Buffer.from([0xf0])), true);
  assert.strictEqual(v.push(Buffer.from([0x9f])), true);
  assert.strictEqual(v.push(Buffer.from([0x98])), true);
  assert.strictEqual(v.push(Buffer.from([0x41]), true), false);
});
