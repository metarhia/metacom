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
const { ClientEventTransport } = require('../lib/client.js');

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

const createContainer = () => {
  const listeners = new Map();
  return {
    controller: null,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event) {
      const listener = listeners.get(type);
      if (listener) listener(event);
    },
  };
};

const createWorker = (environment, id, container = null) => {
  const postMessage = (data) => {
    if (container) container.dispatch('message', { data });
  };
  const source = { id, postMessage };
  return {
    environment,
    types: [],
    postMessage(data, ports = []) {
      this.types.push(data.type);
      this.environment.dispatch({ data, ports, source });
    },
  };
};

const createTab = (environment, id, options = {}) => {
  const worker = createWorker(environment, id);
  const transport = new ClientEventTransport(URL);
  const tabOptions = { worker, callTimeout: 300, ...options };
  return new Metacom(URL, transport, tabOptions);
};

const restartWorker = async (t, worker) => {
  const environment = createEnvironment();
  globalThis.self = environment;
  const proxy = new MetacomProxy({ reconnectTimeout: RECONNECT_MS });
  t.after(() => void proxy.close());
  await proxy.open();
  worker.environment = environment;
  return proxy;
};

const INTROSPECT = 'system/introspect';

const introspect = (units) => {
  if (!units.includes('test')) return {};
  return { test: { echo: {} } };
};

const echoServer = (socket, data) => {
  const packet = JSON.parse(data);
  if (packet.type !== 'call') return;
  const { id, method, args } = packet;
  const result = method === INTROSPECT ? introspect(args) : args;
  socket.dispatchMessage(JSON.stringify({ type: 'callback', id, result }));
};

const getCalls = (socket) => {
  const packets = socket.sent.filter((data) => data.startsWith('{'));
  const calls = packets.map((data) => JSON.parse(data));
  return calls.filter((packet) => packet.method !== INTROSPECT);
};

const setup = async (t, options = {}) => {
  const environment = createEnvironment();
  globalThis.self = environment;
  MockWebSocket.autoOpen = true;
  MockWebSocket.respond = echoServer;
  const proxyOptions = { reconnectTimeout: RECONNECT_MS, ...options };
  const { offline = false } = options;
  if (offline) MockWebSocket.autoOpen = false;
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
  if (!offline) await proxy.open();
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
  const socket = await goOffline();
  socket.open();
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(statuses, [false, true]);
  assert.strictEqual(tab.active, true);
});

test('MetacomProxy: reports status change once', async (t) => {
  const { connect } = await setup(t);
  const tab = await connect('tab1');
  const statuses = [];
  tab.on('status', ({ connected }) => statuses.push(connected));
  const socket = await goOffline();
  socket.emit('error');
  socket.emit('close');
  await timers.setTimeout(RECONNECT_MS * 2);
  assert.notStrictEqual(MockWebSocket.last, socket);
  MockWebSocket.last.open();
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(statuses, [false, true]);
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
  const orders = getCalls(socket).map((packet) => packet.args.order);
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
  const orders = getCalls(socket).map((packet) => packet.args.order);
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
  const orders = getCalls(socket).map((packet) => packet.args.order);
  assert.deepStrictEqual(orders, [2]);
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

test('MetacomProxy: local unit is handled in the worker', async (t) => {
  const { proxy, connect } = await setup(t);
  proxy.register('local', {
    sum: async ({ a, b }) => a + b,
    deny: async () => {
      const error = new Error('Denied');
      error.code = 403;
      throw error;
    },
    crash: async () => {
      throw new Error('Crashed');
    },
  });
  const tab = await connect('tab1');
  await tab.load('local');
  const socket = MockWebSocket.last;
  assert.strictEqual(await tab.api.local.sum({ a: 2, b: 3 }), 5);
  const { deny, crash } = tab.api.local;
  await assert.rejects(deny(), { message: 'Denied', code: 403 });
  await assert.rejects(crash(), { message: 'Crashed', code: 500 });
  assert.deepStrictEqual(getCalls(socket), []);
});

test('MetacomProxy: local method shadows server method', async (t) => {
  const { proxy, connect } = await setup(t);
  proxy.register('test', { echo: async () => 'local' });
  proxy.register('test', { extra: async () => 'extra' });
  const tab = await connect('tab1');
  await tab.load('test');
  assert.strictEqual(await tab.api.test.echo({ a: 1 }), 'local');
  assert.strictEqual(await tab.api.test.extra(), 'extra');
  assert.deepStrictEqual(getCalls(MockWebSocket.last), []);
});

test('MetacomProxy: merges local and server methods', async (t) => {
  const { proxy, connect } = await setup(t);
  proxy.register('test', { extra: async () => 'extra' });
  const tab = await connect('tab1');
  await tab.load('test', 'missing');
  assert.deepStrictEqual(await tab.api.test.echo({ a: 1 }), { a: 1 });
  assert.strictEqual(await tab.api.test.extra(), 'extra');
  assert.strictEqual(tab.api.missing, undefined);
});

test('MetacomProxy: local handler context', async (t) => {
  const { proxy, connect } = await setup(t);
  proxy.register('local', {
    reply: async (args, context) => void context.emit('local/own', args),
    share: async (args, context) => void context.broadcast('local/other', args),
    notify: async (args) => void proxy.broadcast('local/all', args),
    relay: async (args, context) => context.server.api.test.echo(args),
  });
  await proxy.server.load('test');
  const tab1 = await connect('tab1');
  const tab2 = await connect('tab2');
  await tab1.load('local');
  await tab2.load('local');
  const received = [];
  const listen = (tab, name) => {
    const events = ['own', 'other', 'all'];
    for (const event of events) {
      tab.api.local.on(event, () => received.push(`${name}:${event}`));
    }
  };
  listen(tab1, 'tab1');
  listen(tab2, 'tab2');
  await tab1.api.local.reply({});
  await tab1.api.local.share({});
  await tab1.api.local.notify({});
  assert.deepStrictEqual(await tab1.api.local.relay({ a: 1 }), { a: 1 });
  await timers.setTimeout(DELIVERY_MS);
  const expected = ['tab1:all', 'tab1:own', 'tab2:all', 'tab2:other'];
  assert.deepStrictEqual(received.toSorted(), expected);
});

test('MetacomProxy: offline load is extended when online', async (t) => {
  const { proxy, connect } = await setup(t, { offline: true });
  proxy.register('local', { sum: async ({ a, b }) => a + b });
  const tab = await connect('tab1');
  const loading = tab.load('local', 'test');
  await timers.setTimeout(DELIVERY_MS);
  assert.strictEqual(tab.api.local, undefined);
  MockWebSocket.last.close();
  await loading;
  assert.strictEqual(await tab.api.local.sum({ a: 1, b: 1 }), 2);
  assert.strictEqual(tab.api.test, undefined);
  const events = [];
  const unit = tab.api.local;
  unit.on('changed', (data) => events.push(data));
  await timers.setTimeout(RECONNECT_MS * 2);
  MockWebSocket.last.open();
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(await tab.api.test.echo({ a: 1 }), { a: 1 });
  assert.strictEqual(tab.api.local, unit);
  proxy.broadcast('local/changed', { ok: true });
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(events, [{ ok: true }]);
});

test('MetacomProxy: offline load uses cached interface', async (t) => {
  const { connect } = await setup(t);
  const tab1 = await connect('tab1');
  await tab1.load('test');
  await goOffline();
  const tab2 = await connect('tab2');
  await tab2.load('test');
  assert.strictEqual(typeof tab2.api.test.echo, 'function');
});

test('ClientEventTransport: open fails without worker answer', async () => {
  const worker = { postMessage() {} };
  const transport = new ClientEventTransport(URL);
  const opening = transport.open({ worker, handshakeTimeout: 30 });
  await assert.rejects(opening, /handshake timeout/);
  assert.strictEqual(transport.active, false);
  transport.close();
  transport.close();
});

test('ClientEventTransport: close during handshake', async () => {
  const worker = { postMessage() {} };
  const transport = new ClientEventTransport(URL);
  const opening = transport.open({ worker });
  transport.close();
  await assert.rejects(opening, /Connection closed/);
});

test('MetacomProxy: heartbeat keeps tab connected', async (t) => {
  const { environment, connect } = await setup(t);
  const worker = createWorker(environment, 'tab1');
  const timing = { pingInterval: 20, pongTimeout: 40 };
  const tab = await connect('tab1', { worker, ...timing });
  let closed = false;
  tab.on('close', () => {
    closed = true;
  });
  await timers.setTimeout(150);
  const pings = worker.types.filter((type) => type === 'metacom:ping');
  assert.ok(pings.length >= 3);
  assert.strictEqual(closed, false);
  assert.strictEqual(tab.active, true);
});

test('MetacomProxy: tab reconnects after worker restart', async (t) => {
  const { environment, connect } = await setup(t);
  const worker = createWorker(environment, 'tab1');
  const timing = { pingInterval: 20, pongTimeout: 40, reconnectTimeout: 30 };
  const tab = await connect('tab1', { worker, ...timing });
  await tab.load('test');
  const events = [];
  tab.on('close', () => events.push('close'));
  tab.on('open', () => events.push('open'));
  const restarted = await restartWorker(t, worker);
  const connected = new Promise((resolve) => {
    restarted.once('connect', resolve);
  });
  await connected;
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(events, ['close', 'open']);
  assert.deepStrictEqual(await tab.api.test.echo({ a: 1 }), { a: 1 });
});

test('MetacomProxy: restarted worker resets tab at once', async (t) => {
  const { environment, connect } = await setup(t);
  const container = createContainer();
  const worker = createWorker(environment, 'tab1', container);
  const timing = { pingInterval: 20, pongTimeout: 5000, reconnectTimeout: 30 };
  const tab = await connect('tab1', { worker, container, ...timing });
  const events = [];
  tab.on('close', () => events.push('close'));
  tab.on('open', () => events.push('open'));
  await restartWorker(t, worker);
  await timers.setTimeout(150);
  assert.deepStrictEqual(events, ['close', 'open']);
});

test('MetacomProxy: tab follows new controller', async (t) => {
  const { environment, connect } = await setup(t);
  const container = createContainer();
  const worker = createWorker(environment, 'tab1', container);
  const tab = await connect('tab1', {
    worker,
    container,
    reconnectTimeout: 30,
  });
  const controller = createWorker(environment, 'tab1', container);
  const restarted = await restartWorker(t, controller);
  const connected = new Promise((resolve) => {
    restarted.once('connect', resolve);
  });
  container.controller = controller;
  container.dispatch('controllerchange', {});
  await connected;
  await timers.setTimeout(DELIVERY_MS);
  assert.strictEqual(tab.active, true);
  assert.ok(controller.types.includes('metacom:connect'));
});

test('MetacomProxy: tab keeps port when claimed by its worker', async (t) => {
  const { environment, connect } = await setup(t);
  const container = createContainer();
  const worker = createWorker(environment, 'tab1', container);
  const tab = await connect('tab1', { worker, container });
  let closed = false;
  tab.on('close', () => {
    closed = true;
  });
  container.controller = worker;
  container.dispatch('controllerchange', {});
  container.controller = null;
  container.dispatch('controllerchange', {});
  assert.strictEqual(closed, false);
  assert.strictEqual(tab.active, true);
});

test('MetacomProxy: emits connect and disconnect', async (t) => {
  const { proxy, connect } = await setup(t);
  const events = [];
  proxy.on('connect', (id) => events.push(`connect:${typeof id}`));
  proxy.on('disconnect', (id) => events.push(`disconnect:${typeof id}`));
  const tab = await connect('tab1');
  tab.close();
  tab.close();
  assert.deepStrictEqual(events, ['connect:string', 'disconnect:string']);
});

test('MetacomProxy: reconnected tab replaces its port', async (t) => {
  const { environment, proxy, connect } = await setup(t);
  const container = createContainer();
  const worker = createWorker(environment, 'tab1', container);
  const tab = await connect('tab1', {
    worker,
    container,
    reconnectTimeout: 30,
  });
  await tab.load('test');
  const events = [];
  proxy.on('connect', () => events.push('connect'));
  proxy.on('disconnect', () => events.push('disconnect'));
  container.dispatch('message', { data: { type: 'metacom:reset' } });
  await timers.setTimeout(100);
  assert.deepStrictEqual(events, ['disconnect', 'connect']);
  const received = [];
  tab.api.test.on('ping', (data) => received.push(data));
  proxy.broadcast('test/ping', { ping: true });
  await timers.setTimeout(DELIVERY_MS);
  assert.deepStrictEqual(received, [{ ping: true }]);
});

test('MetacomProxy: removes closed tab and its routes', async (t) => {
  const { environment, proxy, connect } = await setup(t, { sweepInterval: 30 });
  environment.clients = { matchAll: async () => [{ id: 'tab2' }] };
  const tab1 = await connect('tab1');
  const tab2 = await connect('tab2');
  await tab2.load('test');
  const stream = tab1.createStream('file', 8);
  const disconnected = [];
  proxy.on('disconnect', (id) => disconnected.push(id));
  await timers.setTimeout(100);
  assert.strictEqual(disconnected.length, 1);
  const terminate = { type: 'stream', id: stream.id, status: 'terminate' };
  const sent = MockWebSocket.last.sent.at(-1);
  assert.deepStrictEqual(JSON.parse(sent), terminate);
  assert.deepStrictEqual(await tab2.api.test.echo({ a: 1 }), { a: 1 });
});

test('MetacomProxy: load waits for the first connection', async (t) => {
  const { connect } = await setup(t, { offline: true });
  const tab = await connect('tab1');
  const loading = tab.load('test');
  await timers.setTimeout(DELIVERY_MS);
  MockWebSocket.last.open();
  await loading;
  assert.deepStrictEqual(await tab.api.test.echo({ a: 1 }), { a: 1 });
});
