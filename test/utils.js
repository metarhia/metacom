'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Emitter } = require('metautil');
const metacom = require('../metacom.js');

const { parseMethod, isStreamMeta, emitError } = metacom;
const { retireRtcGeneration } = metacom;

test('parseMethod: unit, version, and name', () => {
  assert.deepEqual(parseMethod('chat/send'), {
    unit: 'chat',
    version: '*',
    name: 'send',
  });
  assert.deepEqual(parseMethod('chat.2/send'), {
    unit: 'chat',
    version: '2',
    name: 'send',
  });
});

test('isStreamMeta: string name and non-negative integer size', () => {
  assert.equal(isStreamMeta('file', 0), true);
  assert.equal(isStreamMeta('file', -1), false);
  assert.equal(isStreamMeta('file', 1.5), false);
  assert.equal(isStreamMeta(1, 10), false);
});

test('emitError: reports only to listeners', () => {
  const emitter = new Emitter();
  const error = new Error('boom');
  assert.doesNotThrow(() => emitError(emitter, error));
  const errors = [];
  emitter.on('error', (reported) => errors.push(reported));
  emitError(emitter, error);
  assert.deepEqual(errors, [error]);
});

test('retireRtcGeneration: oldest generation is forgotten', () => {
  const retired = new Set();
  for (let i = 0; i <= 256; i++) retireRtcGeneration(retired, `g${i}`);
  assert.equal(retired.size, 256);
  assert.equal(retired.has('g0'), false);
  assert.equal(retired.has('g256'), true);
});
