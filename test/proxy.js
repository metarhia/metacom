'use strict';

const { MessageChannel } = require('node:worker_threads');
const { test } = require('node:test');
const assert = require('node:assert');

class MockWebSocket {
  static last = null;

  constructor() {
    MockWebSocket.last = this;
    this._listeners = new Map();
    queueMicrotask(() => this._emit('open'));
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  _emit(type, payload) {
    for (const listener of this._listeners.get(type) || []) {
      if (type === 'message') listener({ data: payload });
      else listener(payload);
    }
  }

  dispatchMessage(data) {
    this._emit('message', data);
  }

  send() {
    this._emit('send');
  }

  close() {
    this._emit('close');
  }
}

globalThis.WebSocket = MockWebSocket;

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
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    location: { protocol: 'http:', host: 'localhost:8020' },
    dispatch(event) {
      for (const { type, listener } of listeners) {
        if (type === 'message') listener(event);
      }
    },
  };
};

test('MetacomProxy', async (t) => {
  let savedSelf = null;

  t.after(() => {
    delete globalThis.self;
  });

  t.afterEach(() => {
    if (savedSelf) {
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

  await t.test('Broadcast to all ports', async () => {
    savedSelf = globalThis.self;
    globalThis.self = createSwEnv();
    const proxy = new MetacomProxy();
    const channel1 = new MessageChannel();
    const channel2 = new MessageChannel();
    globalThis.self.dispatch({
      data: { type: 'metacom:connect' },
      ports: [channel1.port2],
    });
    globalThis.self.dispatch({
      data: { type: 'metacom:connect' },
      ports: [channel2.port2],
    });
    const received = [];
    channel1.port1.onmessage = (event) =>
      received.push({ port: 1, data: event.data });
    channel2.port1.onmessage = (event) =>
      received.push({ port: 2, data: event.data });
    channel1.port1.start();
    channel2.port1.start();
    await proxy.open();
    MockWebSocket.last.dispatchMessage('payload');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].data, 'payload');
    assert.strictEqual(received[1].data, 'payload');
    proxy.close();
    channel1.port1.close();
    channel1.port2.close();
    channel2.port1.close();
    channel2.port2.close();
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
