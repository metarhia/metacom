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

test('Result.from: wraps a function return value', () => {
  const result = Result.from(() => ({ code: 1000, reason: 'ok' }));
  assert.deepEqual(result.value, { code: 1000, reason: 'ok' });
  assert.equal(result.error, null);
  assert.equal(result.ok, true);
});

test('Result.from: catches thrown errors', () => {
  const error = new Error('boom');
  const result = Result.from(() => {
    throw error;
  });
  assert.equal(result.value, null);
  assert.strictEqual(result.error, error);
  assert.equal(result.ok, false);
});

test('Result.fromAsync: wraps an async return value', async () => {
  const result = await Result.fromAsync(async () => 99);
  assert.equal(result.value, 99);
  assert.equal(result.error, null);
  assert.equal(result.ok, true);
});

test('Result.fromAsync: catches rejected promises', async () => {
  const error = new Error('async boom');
  const result = await Result.fromAsync(async () => {
    throw error;
  });
  assert.equal(result.value, null);
  assert.strictEqual(result.error, error);
  assert.equal(result.ok, false);
});

test('Result.unwrap: returns value when ok', () => {
  assert.equal(Result.ok(7).unwrap(), 7);
});

test('Result.unwrap: throws error when failed', () => {
  const error = new Error('fail');
  assert.throws(
    () => Result.fail(error).unwrap(),
    (thrown) => thrown === error,
  );
});

test('Result.unwrap: returns defaultValue when failed', () => {
  const result = Result.fail(new Error('fail'));
  assert.equal(result.unwrap('default'), 'default');
});

test('Result.map: transforms value when ok', () => {
  const result = Result.ok(3).map((value) => value * 2);
  assert.equal(result.value, 6);
  assert.equal(result.ok, true);
});

test('Result.map: passes error through unchanged', () => {
  const error = new Error('fail');
  const result = Result.fail(error).map((value) => value * 2);
  assert.strictEqual(result.error, error);
  assert.equal(result.ok, false);
});

test('Result.map: catches error thrown inside mapper', () => {
  const mappedError = new Error('map fail');
  const result = Result.ok(1).map(() => {
    throw mappedError;
  });
  assert.strictEqual(result.error, mappedError);
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

test('Result.fromAsync: wraps resolved value', async () => {
  const result = await Result.fromAsync(async () => 42);
  assert.equal(result.value, 42);
  assert.equal(result.ok, true);
});

test('Result.fromAsync: catches rejection', async () => {
  const error = new Error('boom');
  const result = await Result.fromAsync(async () => {
    throw error;
  });
  assert.strictEqual(result.error, error);
  assert.equal(result.ok, false);
});
