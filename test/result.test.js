'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Result } = require('../lib/websocket/result.js');

test('Result.ok: creates success result with given value', () => {
  const r = Result.ok(42);
  assert.equal(r.value, 42);
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
});

test('Result.ok: defaults to null value', () => {
  const r = Result.ok();
  assert.equal(r.value, null);
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
});

test('Result.fail: creates error result', () => {
  const err = new Error('boom');
  const r = Result.fail(err);
  assert.equal(r.value, null);
  assert.strictEqual(r.error, err);
  assert.equal(r.ok, false);
});

test('Result.from: wraps a function return value', () => {
  const r = Result.from(() => ({ code: 1000, reason: 'ok' }));
  assert.deepEqual(r.value, { code: 1000, reason: 'ok' });
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
});

test('Result.from: catches thrown errors', () => {
  const err = new Error('boom');
  const r = Result.from(() => {
    throw err;
  });
  assert.equal(r.value, null);
  assert.strictEqual(r.error, err);
  assert.equal(r.ok, false);
});

test('Result.fromAsync: wraps an async return value', async () => {
  const r = await Result.fromAsync(async () => 99);
  assert.equal(r.value, 99);
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
});

test('Result.fromAsync: catches rejected promises', async () => {
  const err = new Error('async boom');
  const r = await Result.fromAsync(async () => {
    throw err;
  });
  assert.equal(r.value, null);
  assert.strictEqual(r.error, err);
  assert.equal(r.ok, false);
});

test('Result.unwrap: returns value when ok', () => {
  assert.equal(Result.ok(7).unwrap(), 7);
});

test('Result.unwrap: throws error when failed', () => {
  const err = new Error('fail');
  assert.throws(
    () => Result.fail(err).unwrap(),
    (e) => e === err,
  );
});

test('Result.unwrap: returns defaultValue when failed', () => {
  const r = Result.fail(new Error('fail'));
  assert.equal(r.unwrap('default'), 'default');
});

test('Result.map: transforms value when ok', () => {
  const r = Result.ok(3).map((v) => v * 2);
  assert.equal(r.value, 6);
  assert.equal(r.ok, true);
});

test('Result.map: passes error through unchanged', () => {
  const err = new Error('fail');
  const r = Result.fail(err).map((v) => v * 2);
  assert.strictEqual(r.error, err);
  assert.equal(r.ok, false);
});

test('Result.map: catches error thrown inside mapper', () => {
  const mapErr = new Error('map fail');
  const r = Result.ok(1).map(() => {
    throw mapErr;
  });
  assert.strictEqual(r.error, mapErr);
  assert.equal(r.ok, false);
});

test('Result: value and error getters are read-only', () => {
  const r = Result.ok(42);
  assert.equal(r.value, 42);
  assert.throws(() => {
    r.value = 99;
  });
});

test('Result.fail: defaults to an Error instance', () => {
  const r = Result.fail();
  assert.ok(r.error instanceof Error);
  assert.equal(r.value, null);
  assert.equal(r.ok, false);
});

test('Result.fromAsync: wraps resolved value', async () => {
  const r = await Result.fromAsync(async () => 42);
  assert.equal(r.value, 42);
  assert.equal(r.ok, true);
});

test('Result.fromAsync: catches rejection', async () => {
  const err = new Error('boom');
  const r = await Result.fromAsync(async () => {
    throw err;
  });
  assert.strictEqual(r.error, err);
  assert.equal(r.ok, false);
});
