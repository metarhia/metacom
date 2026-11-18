'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: setTimeoutPromise } = require('node:timers/promises');
const { MessageChannel, Worker } = require('node:worker_threads');
const { DomainError } = require('metautil');
const { MetacomPeer } = require('../lib/peer.js');

const createPair = (options = {}) => {
  const { port1, port2 } = new MessageChannel();
  const left = new MetacomPeer({ port: port1, ...options });
  const right = new MetacomPeer({ port: port2, ...options });
  return { left, right };
};

const openPair = async (options) => {
  const pair = createPair(options);
  await pair.left.open();
  await pair.right.open();
  return pair;
};

const wait = (ms) => setTimeoutPromise(ms);

test('Port: calls both ways at the same time', async () => {
  const { left, right } = await openPair();
  left.register('a', { twice: async (n) => n * 2 });
  right.register('b', { inc: async (n) => n + 1 });
  const results = await Promise.all([
    left.call('b', 'inc', 1),
    right.call('a', 'twice', 5),
  ]);
  assert.deepEqual(results, [2, 10]);
  await left.close();
  await right.close();
});

test('Port: events both ways, subscribe and unsubscribe', async () => {
  const { left, right } = await openPair();
  const got = [];
  const onReady = (data) => got.push(['right', data]);
  right.subscribe('thread', 'ready', onReady);
  left.subscribe('thread', 'ready', (data) => got.push(['left', data]));
  left.send('thread', 'ready', 1);
  right.send('thread', 'ready', 2);
  await wait(20);
  assert.deepEqual(got.sort(), [
    ['left', 2],
    ['right', 1],
  ]);
  right.unsubscribe('thread', 'ready', onReady);
  left.send('thread', 'ready', 3);
  await wait(20);
  assert.equal(got.length, 2);
  await left.close();
  await right.close();
});

test('Port: context.peer.send from a served method', async () => {
  const { left, right } = await openPair();
  right.register('svc', {
    start: async (args, context) => {
      context.peer.send('svc', 'started', args);
      return true;
    },
  });
  const events = [];
  left.subscribe('svc', 'started', (data) => events.push(data));
  assert.equal(await left.call('svc', 'start', { n: 1 }), true);
  await wait(20);
  assert.deepEqual(events, [{ n: 1 }]);
  await left.close();
  await right.close();
});

test('Port: structured types survive a call and a result', async () => {
  const { left, right } = await openPair();
  right.register('echo', { run: async (args) => args });
  const value = {
    date: new Date(1700000000000),
    map: new Map([['k', { x: 1 }]]),
    set: new Set([1, 2]),
    missing: undefined,
    bytes: new Uint8Array([1, 2, 3]),
    nested: { list: [{ deep: new Date(0) }] },
  };
  const result = await left.call('echo', 'run', value);
  assert.deepEqual(result, value);
  assert.ok(result.date instanceof Date);
  assert.ok(result.map instanceof Map);
  assert.ok(result.set instanceof Set);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.ok(Object.hasOwn(result, 'missing'));
  await left.close();
  await right.close();
});

test('Port: error code survives', async () => {
  const { left, right } = await openPair();
  right.register('svc', {
    thrown: async () => {
      throw new DomainError('E_LIMIT');
    },
    coded: async () => {
      throw Object.assign(new Error('Denied'), { code: 403 });
    },
    returned: async () => new Error('Returned', { cause: 1 }),
  });
  await assert.rejects(left.call('svc', 'thrown'), { code: 'E_LIMIT' });
  await assert.rejects(left.call('svc', 'coded'), {
    message: 'Denied',
    code: 403,
  });
  await assert.rejects(left.call('svc', 'returned'), {
    message: 'Returned',
    code: 500,
  });
  await left.close();
  await right.close();
});

test('Port: unknown unit and method', async () => {
  const { left, right } = await openPair();
  right.register('svc', {});
  const notFound = { message: 'Not Found', code: 404 };
  await assert.rejects(left.call('svc', 'nope'), notFound);
  await assert.rejects(left.call('nope', 'run'), notFound);
  await left.close();
  await right.close();
});

test('Port: timeout ignores a late reply', async () => {
  const { left, right } = await openPair({ callTimeout: 1000 });
  right.register('slow', {
    run: async (ms) => {
      await wait(ms);
      return ms;
    },
  });
  await assert.rejects(
    left.call('slow', 'run', 80, { timeout: 20 }),
    /Request timeout/,
  );
  await wait(120);
  assert.equal(await left.call('slow', 'run', 1), 1);
  await left.close();
  await right.close();
});

test('Port: callTimeout is the default', async () => {
  const { left, right } = await openPair({ callTimeout: 20 });
  right.register('slow', { run: () => wait(100) });
  await assert.rejects(left.call('slow', 'run'), /Request timeout/);
  await left.close();
  await right.close();
});

test('Port: close rejects pending calls from either end', async () => {
  for (const closer of ['left', 'right']) {
    const pair = await openPair();
    const { left, right } = pair;
    left.register('slow', { run: () => wait(200) });
    right.register('slow', { run: () => wait(200) });
    const closed = [];
    left.on('close', () => closed.push('left'));
    right.on('close', () => closed.push('right'));
    const pending = [left.call('slow', 'run'), right.call('slow', 'run')];
    const rejections = pending.map((promise) =>
      assert.rejects(promise, { message: 'Link closed' }),
    );
    await wait(10);
    await pair[closer].close();
    await Promise.all(rejections);
    await wait(20);
    assert.deepEqual(closed.sort(), ['left', 'right']);
    assert.equal(left.active, false);
    assert.equal(right.active, false);
  }
});

test('Port: double close is harmless', async () => {
  const { left, right } = await openPair();
  let count = 0;
  left.on('close', () => count++);
  await left.close();
  await left.close();
  await right.close();
  assert.equal(count, 1);
  await assert.rejects(left.call('a', 'b'), { message: 'Link closed' });
});

test('Port: 1000 concurrent calls', async () => {
  const { left, right } = await openPair();
  right.register('math', { square: async (n) => n * n });
  const calls = [];
  for (let i = 0; i < 1000; i++) calls.push(left.call('math', 'square', i));
  const results = await Promise.all(calls);
  for (let i = 0; i < 1000; i++) assert.equal(results[i], i * i);
  await left.close();
  await right.close();
});

test('Port: worker_threads Worker as the other end', async () => {
  const { port1, port2 } = new MessageChannel();
  const file = path.join(__dirname, 'fixtures', 'peer-worker.js');
  const worker = new Worker(file, {
    workerData: { port: port2 },
    transferList: [port2],
  });
  const peer = new MetacomPeer({ port: port1 });
  peer.register('main', { double: async (n) => n * 2 });
  const ready = new Promise((resolve) => {
    peer.subscribe('worker', 'ready', resolve);
  });
  await peer.open();
  assert.deepEqual(await ready, { at: new Date(0) });
  const input = { when: new Date(5), tags: new Set(['a']) };
  assert.deepEqual(await peer.call('echo', 'run', input), input);
  assert.deepEqual(
    await peer.call('echo', 'reverse', { list: [1, 2] }),
    [2, 1],
  );
  assert.equal(await peer.call('echo', 'ask', { value: 21 }), 42);
  await assert.rejects(peer.call('echo', 'fail'), { code: 403 });
  const exited = once(worker, 'exit');
  await peer.close();
  await worker.terminate();
  await exited;
});
