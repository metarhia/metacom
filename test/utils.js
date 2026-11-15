'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Emitter } = require('metautil');
const metacom = require('../metacom.js');

const { parseMethod, isStreamMeta, emitError, encodeEvent } = metacom;
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

// Data with a getter that counts how many times it was serialized
const countReads = () => {
  const counter = { reads: 0 };
  const data = {};
  const get = () => ++counter.reads;
  Object.defineProperty(data, 'value', { enumerable: true, get });
  return { data, counter };
};

test('encodeEvent: frozen data is serialized once per event name', () => {
  const plain = countReads();
  encodeEvent('chat/log', plain.data);
  encodeEvent('chat/log', plain.data);
  assert.equal(plain.counter.reads, 2);
  const frozen = countReads();
  Object.freeze(frozen.data);
  const packet = encodeEvent('chat/log', frozen.data);
  assert.equal(encodeEvent('chat/log', frozen.data), packet);
  assert.equal(frozen.counter.reads, 1);
  encodeEvent('chat/other', frozen.data);
  assert.equal(frozen.counter.reads, 2);
  const event = { type: 'event', name: 'chat/log', data: { value: 1 } };
  assert.deepEqual(JSON.parse(packet), event);
});
