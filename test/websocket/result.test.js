'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Result } = require('../../lib/websocket/result.js');

test('Result.ok: creates success result with given value', () => {
  const result = Result.ok(42);
  assert.equal(result.value, 42);
  assert.equal(result.error, null);
  assert.equal(result.ok, true);
});

test('Result.ok: defaults to null value', () => {
  const result = Result.ok();
  assert.equal(result.value, null);
  assert.equal(result.error, null);
  assert.equal(result.ok, true);
});

test('Result.fail: creates error result', () => {
  const error = new Error('boom');
  const result = Result.fail(error);
  assert.equal(result.value, null);
  assert.strictEqual(result.error, error);
  assert.equal(result.ok, false);
});

test('Result: value and error getters are read-only', () => {
  const result = Result.ok(42);
  assert.equal(result.value, 42);
  assert.throws(() => {
    result.value = 99;
  });
});

test('Result.fail: defaults to an Error instance', () => {
  const result = Result.fail();
  assert.ok(result.error instanceof Error);
  assert.equal(result.value, null);
  assert.equal(result.ok, false);
});
