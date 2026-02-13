'use strict';

const { MessageChannel } = require('node:worker_threads');
const { test } = require('node:test');
const assert = require('node:assert');
const { Metacom, MetacomProxy } = require('../lib/metacom.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
};

const createSwEnv = () => {
  const listeners = [];
  return {
    _listeners: listeners,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    location: { protocol: 'http:', host: 'localhost:8020' },
    dispatch(event) {
      for (const { type, fn } of listeners) {
        if (type === 'message') fn(event);
      }
    },
  };
};

test('MetacomProxy', async (t) => {
  let savedSelf;

  t.after(() => {
    delete globalThis.self;
  });

  t.afterEach(() => {
    if (savedSelf !== undefined) {
      globalThis.self = savedSelf;
    } else {
      delete globalThis.self;
    }
  });

  await t.test('Throws when not in Service Worker context', () => {
    savedSelf = globalThis.self;
    delete globalThis.self;
    assert.throws(
      () => new MetacomProxy(),
      /MetacomProxy must run in ServiceWorker context/,
    );
  });

  await t.test('Constructs when self is defined', () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    assert.doesNotThrow(() => new MetacomProxy());
  });

  await t.test('Handle event: metacom:connect', () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    const proxy = new MetacomProxy();
    const { port1, port2 } = new MessageChannel();
    globalThis.self.dispatch({
      data: { type: 'metacom:connect' },
      ports: [port2],
    });
    assert.strictEqual(proxy.ports.size, 1);
    assert(proxy.ports.has(port2));
    proxy.close();
    port1.close();
    port2.close();
  });

  await t.test('Broadcast to all ports', async () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    const proxy = new MetacomProxy();
    const ch1 = new MessageChannel();
    const ch2 = new MessageChannel();
    globalThis.self.dispatch({
      data: { type: 'metacom:connect' },
      ports: [ch1.port2],
    });
    globalThis.self.dispatch({
      data: { type: 'metacom:connect' },
      ports: [ch2.port2],
    });
    const received = [];
    ch1.port1.onmessage = (e) => received.push({ port: 1, data: e.data });
    ch2.port1.onmessage = (e) => received.push({ port: 2, data: e.data });
    ch1.port1.start();
    ch2.port1.start();
    proxy.broadcast('payload');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].data, 'payload');
    assert.strictEqual(received[1].data, 'payload');
    proxy.close();
    ch1.port1.close();
    ch1.port2.close();
    ch2.port1.close();
    ch2.port2.close();
  });

  await t.test('Handle event: metacom:online', () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    const proxy = new MetacomProxy();
    let called = false;
    const original = Metacom.online;
    Metacom.online = () => {
      called = true;
    };
    globalThis.self.dispatch({ data: { type: 'metacom:online' } });
    Metacom.online = original;
    assert(called);
    proxy.close();
  });

  await t.test('Handle event: metacom:offline', () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    const proxy = new MetacomProxy();
    let called = false;
    const original = Metacom.offline;
    Metacom.offline = () => {
      called = true;
    };
    globalThis.self.dispatch({ data: { type: 'metacom:offline' } });
    Metacom.offline = original;
    assert(called);
    proxy.close();
  });
});
