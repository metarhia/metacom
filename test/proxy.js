'use strict';

const timers = require('node:timers/promises');
const { test } = require('node:test');
const assert = require('node:assert');

class MockWebSocket {
  static last = null;
  static autoOpen = true;
  static respond = null;

  constructor() {
    MockWebSocket.last = this;
    this.sent = [];
    this.listeners = new Map();
    if (MockWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) listeners.push(listener);
    else this.listeners.set(type, [listener]);
  }

  emit(type, payload) {
    const listeners = this.listeners.get(type) || [];
    for (const listener of listeners) listener(payload);
  }

  open() {
    this.emit('open');
  }

  dispatchMessage(data) {
    this.emit('message', { data });
  }

  send(data) {
    this.sent.push(data);
    const { respond } = MockWebSocket;
    if (respond) queueMicrotask(() => respond(this, data));
  }

  close() {
    this.emit('close');
  }
}

globalThis.WebSocket = MockWebSocket;

const { Metacom } = require('../lib/metacom.js');
const { MetacomProxy } = require('../lib/proxy.js');
const { ClientEventTransport } = require('../lib/client-event.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
};

const URL = 'ws://localhost:8020';
const DELIVERY_MS = 30;
const RECONNECT_MS = 40;

const createEnvironment = () => {
  const listeners = [];
  return {
    location: { protocol: 'http:', host: 'localhost:8020' },
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    dispatch(event) {
      for (const { type, listener } of listeners) {
        if (type === 'message') listener(event);
      }
    },
  };
};

const createWorker = (environment, id) => ({
  postMessage(data, ports = []) {
    environment.dispatch({ data, ports, source: { id } });
  },
});

const createTab = (environment, id, options = {}) => {
  const worker = createWorker(environment, id);
  const transport = new ClientEventTransport(URL);
  const tabOptions = { worker, callTimeout: 300, ...options };
  return new Metacom(URL, transport, tabOptions);
};

const echoServer = (socket, data) => {
  const packet = JSON.parse(data);
  if (typeof packet !== 'object') return;
  const { id, method, args } = packet;
  const isIntrospect = method === 'system/introspect';
  const result = isIntrospect ? { test: { echo: {} } } : args;
  socket.dispatchMessage(JSON.stringify({ type: 'callback', id, result }));
};

const setup = async (t, options = {}) => {
  const environment = createEnvironment();
  globalThis.self = environment;
  MockWebSocket.autoOpen = true;
  MockWebSocket.respond = echoServer;
  const proxyOptions = { reconnectTimeout: RECONNECT_MS, ...options };
  const proxy = new MetacomProxy(proxyOptions);
  const tabs = [];
  const connect = async (id, tabOptions) => {
    const tab = createTab(environment, id, tabOptions);
    tabs.push(tab);
    await tab.open();
    return tab;
  };
  t.after(() => {
    for (const tab of tabs) tab.close();
    proxy.close();
    MockWebSocket.autoOpen = true;
    MockWebSocket.respond = null;
    delete globalThis.self;
  });
  await proxy.open();
  return { environment, proxy, connect };
};

const goOffline = async () => {
  MockWebSocket.autoOpen = false;
  const previous = MockWebSocket.last;
  previous.close();
  await timers.setTimeout(RECONNECT_MS * 2);
  assert.notStrictEqual(MockWebSocket.last, previous);
  return MockWebSocket.last;
};

test('MetacomProxy: throws when not in Service Worker context', () => {
  delete globalThis.self;
  assert.throws(
    () => new MetacomProxy(),
    /MetacomProxy must run in ServiceWorker context/,
  );
});

test('MetacomProxy: control messages online and offline', async (t) => {
  const { environment } = await setup(t);
  const calls = [];
  const { online, offline } = Metacom;
  Metacom.online = () => calls.push('online');
  Metacom.offline = () => calls.push('offline');
  environment.dispatch({ data: { type: 'metacom:online' } });
  environment.dispatch({ data: { type: 'metacom:offline' } });
  environment.dispatch({ data: { type: 'updateCache' } });
  environment.dispatch({ data: 'text' });
  Metacom.online = online;
  Metacom.offline = offline;
  assert.deepStrictEqual(calls, ['online', 'offline']);
});

test('MetacomProxy: routes callbacks to calling tab', async (t) => {
  const { connect } = await setup(t);
  const tab1 = await connect('tab1');
  const tab2 = await connect('tab2');
  await tab1.load('test');
  await tab2.load('test');
  const results = await Promise.all([
    tab1.api.test.echo({ from: 1 }),
    tab2.api.test.echo({ from: 2 }),
    tab1.api.test.echo({ from: 3 }),
  ]);
  assert.deepStrictEqual(results, [{ from: 1 }, { from: 2 }, { from: 3 }]);
});

test('MetacomProxy: uses custom id generator of the tab', async (t) => {
  const { connect } = await setup(t);
  let counter = 0;
  const generateId = () => `tab1-${++counter}`;
  const tab = await connect('tab1', { generateId });
  await tab.load('test');
  await tab.api.test.echo({});
  const packets = MockWebSocket.last.sent.map((data) => JSON.parse(data));
  const ids = packets.map((packet) => packet.id);
  assert.deepStrictEqual(ids, ['tab1-1', 'tab1-2']);
});

test('MetacomProxy: broadcasts server events to all tabs', async (t) => {
  const { connect } = await setup(t);
  const tab1 = await connect('tab1');
  const tab2 = await connect('tab2');
  await tab1.load('test');
  await tab2.load('test');
  const received = [];
  tab1.api.test.on('ping', (data) => received.push({ tab: 1, data }));
  tab2.api.test.on('ping', (data) => received.push({ tab: 2, data }));
  const event = { type: 'event', name: 'test/ping', data: { ping: true } };
  MockWebSocket.last.dispatchMessage(JSON.stringify(event));
  await timers.setTimeout(DELIVERY_MS);
  const ordered = received.toSorted((a, b) => a.tab - b.tab);
  assert.deepStrictEqual(ordered, [
    { tab: 1, data: { ping: true } },
    { tab: 2, data: { ping: true } },
  ]);
});

test('MetacomProxy: drops callback with unknown id', async (t) => {
  const { proxy, connect } = await setup(t);
  const tab = await connect('tab1');
  const errors = [];
  tab.on('error', (error) => errors.push(error));
  proxy.on('error', (error) => errors.push(error));
  const callback = { type: 'callback', id: 'unknown', result: {} };
  MockWebSocket.last.dispatchMessage(JSON.stringify(callback));
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(errors, []);
});

test('MetacomProxy: rejects invalid packet from tab', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1');
  const errors = [];
  tab.on('error', (error) => errors.push(error.message));
  const sentBefore = MockWebSocket.last.sent.length;
  tab.write('not json');
  tab.send({ type: 'unknown', id: 'id1' });
  await timers.setTimeout(DELIVERY_MS);
  assert.strictEqual(MockWebSocket.last.sent.length, sentBefore);
  assert.deepStrictEqual(errors, [
    'Packet structure error',
    'Callback id1 not found',
  ]);
});

test('MetacomProxy: reports connection status to tabs', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1');
  const statuses = [];
  tab.on('status', ({ connected }) => statuses.push(connected));
  await timers.setTimeout(DELIVERY_MS);
  const socket = await goOffline();
  socket.open();
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(statuses, [true, false, true]);
  assert.strictEqual(tab.active, true);
});

test('MetacomProxy: queues calls while offline', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1');
  await tab.load('test');
  const socket = await goOffline();
  const first = tab.api.test.echo({ order: 1 });
  const second = tab.api.test.echo({ order: 2 });
  await timers.setTimeout(DELIVERY_MS);
  assert.strictEqual(socket.sent.length, 0);
  socket.open();
  assert.deepStrictEqual(await first, { order: 1 });
  assert.deepStrictEqual(await second, { order: 2 });
  const packets = socket.sent.map((data) => JSON.parse(data));
  const orders = packets.map((packet) => packet.args.order);
  assert.deepStrictEqual(orders, [1, 2]);
});

test('MetacomProxy: restores session before queue flush', async (t) => {
  const restore = async (server) => {
    await timers.setTimeout(DELIVERY_MS);
    server.write('"restore"');
  };
  const { connect } = await setup(t, { restore });
  const tab = await connect('tab1');
  await tab.load('test');
  const socket = await goOffline();
  const queued = tab.api.test.echo({ order: 1 });
  await timers.setTimeout(DELIVERY_MS);
  socket.open();
  const during = tab.api.test.echo({ order: 2 });
  await Promise.all([queued, during]);
  assert.strictEqual(socket.sent[0], '"restore"');
  const calls = socket.sent.slice(1).map((data) => JSON.parse(data));
  const orders = calls.map((packet) => packet.args.order);
  assert.deepStrictEqual(orders, [1, 2]);
});

test('MetacomProxy: rejects new call when queue is full', async (t) => {
  const { connect } = await setup(t, { queueSize: 1 });
  const tab = await connect('tab1');
  await tab.load('test');
  const socket = await goOffline();
  const first = tab.api.test.echo({ order: 1 });
  const second = tab.api.test.echo({ order: 2 });
  await assert.rejects(second, (error) => error.code === 503);
  socket.open();
  assert.deepStrictEqual(await first, { order: 1 });
});

test('MetacomProxy: drops expired calls on flush', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1', { callTimeout: 50 });
  await tab.load('test');
  const socket = await goOffline();
  const expired = tab.api.test.echo({ order: 1 });
  await assert.rejects(expired, new Error('Request timeout'));
  const fresh = tab.api.test.echo({ order: 2 });
  socket.open();
  assert.deepStrictEqual(await fresh, { order: 2 });
  assert.strictEqual(socket.sent.length, 1);
});

test('MetacomProxy: answers stream packets with 503 offline', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1');
  const errors = [];
  tab.on('error', (error) => errors.push(error.message));
  const socket = await goOffline();
  const stream = tab.createStream('file', 4);
  stream.write(new Uint8Array([1, 2, 3, 4]));
  await timers.setTimeout(DELIVERY_MS);
  assert.strictEqual(socket.sent.length, 0);
  assert.deepStrictEqual(errors, [`Callback ${stream.id} not found`]);
});
