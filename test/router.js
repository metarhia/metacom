'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MetacomRouter, Metacom, ClientTransport } = require('../metacom.js');
const { RtcTarget } = require('./helpers/rtc.js');
const { chunkEncode } = require('../lib/chunks-browser.js');

class RouterTransport extends ClientTransport {
  static last;
  sent = [];
  constructor(url) {
    super(url);
    RouterTransport.last = this;
  }
  async open() {
    this.active = true;
    this.emit('open');
  }
  close() {
    this.active = false;
    this.emit('close');
  }
  write(data) {
    this.sent.push(data);
  }
}

class RouterPort extends RtcTarget {
  packets = [];
  postMessage(data) {
    this.packets.push(data);
  }
  start() {
    this.started = true;
  }
  close() {
    this.closed = true;
  }
}

test('Router: colliding call IDs cannot steal callbacks', async (t) => {
  Metacom.transport.routertest = RouterTransport;
  const router = new MetacomRouter({ url: 'peer', transport: 'routertest' });
  t.after(() => {
    router.close();
    delete Metacom.transport.routertest;
  });
  await router.open();
  const a = new RouterPort();
  const b = new RouterPort();
  router.attach(a, { id: 'a' });
  router.attach(b, { id: 'b' });
  const packet = JSON.stringify({
    type: 'call',
    id: 'same',
    method: 'test/echo',
  });
  router.receive(a, packet);
  router.receive(b, packet);
  assert.equal(JSON.parse(b.packets.at(-1)).error.code, 409);
  const callback = { type: 'callback', id: 'same', result: 'first' };
  RouterTransport.last.emit('message', JSON.stringify(callback));
  assert.deepEqual(JSON.parse(a.packets.at(-1)), callback);
  router.detach('a');
  assert.equal(router.port('a'), undefined);
});

test('Router: reject foreign chunks and announcements', async (t) => {
  Metacom.transport.routertest = RouterTransport;
  const router = new MetacomRouter({ url: 'peer', transport: 'routertest' });
  t.after(() => {
    router.close();
    delete Metacom.transport.routertest;
  });
  await router.open();
  const a = new RouterPort();
  const b = new RouterPort();
  router.attach(a, { id: 'a' });
  router.attach(b, { id: 'b' });
  router.receive(
    a,
    JSON.stringify({ type: 'stream', id: 's', name: 'data', size: 1 }),
  );
  router.receive(b, { type: 'metacom:stream', id: 's' });
  const chunk = chunkEncode('s', new Uint8Array([7]));
  const count = RouterTransport.last.sent.length;
  router.receive(b, chunk);
  assert.equal(RouterTransport.last.sent.length, count);
  router.receive(a, chunk);
  assert.equal(RouterTransport.last.sent.length, count + 1);
  RouterTransport.last.emit(
    'message',
    JSON.stringify({ type: 'stream', id: 's', status: 'terminate' }),
  );
  assert.equal(JSON.parse(a.packets.at(-1)).status, 'terminate');
  router.detach('a');
  router.detach('b');
});

test('Router: announcement sent as text routes the download', async (t) => {
  Metacom.transport.routertest = RouterTransport;
  const router = new MetacomRouter({ url: 'peer', transport: 'routertest' });
  t.after(() => {
    router.close();
    delete Metacom.transport.routertest;
  });
  await router.open();
  const port = new RouterPort();
  router.attach(port, { id: 'tab' });
  const announce = { type: 'metacom:stream', id: 'download' };
  router.receive(port, JSON.stringify(announce));
  const init = { type: 'stream', id: 'download', name: 'file', size: 1 };
  RouterTransport.last.emit('message', JSON.stringify(init));
  assert.deepEqual(JSON.parse(port.packets.at(-1)), init);
});

test('Router: handlers get a client of the calling port', async (t) => {
  const router = new MetacomRouter();
  t.after(() => router.close());
  let client = null;
  let closed = 0;
  router.register('chat', {
    subscribe: (args, context) => {
      client = context.client;
      client.on('close', () => closed++);
      return client.id;
    },
  });
  const port = new RouterPort();
  router.attach(port, { id: 'tab' });
  const call = { type: 'call', id: 'c1', method: 'chat/subscribe', args: {} };
  router.receive(port, JSON.stringify(call));
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(JSON.parse(port.packets.at(-1)).result, 'tab');
  client.emit('chat/log', { position: 1 });
  const event = { type: 'event', name: 'chat/log', data: { position: 1 } };
  assert.deepEqual(JSON.parse(port.packets.at(-1)), event);
  router.detach('tab');
  assert.equal(closed, 1);
  const count = port.packets.length;
  client.emit('chat/log', { position: 2 });
  assert.equal(port.packets.length, count);
});

test('Router: upstream events reach ports that loaded the unit', async (t) => {
  Metacom.transport.routertest = RouterTransport;
  const router = new MetacomRouter({ url: 'peer', transport: 'routertest' });
  t.after(() => {
    router.close();
    delete Metacom.transport.routertest;
  });
  await router.open();
  const chat = new RouterPort();
  const cache = new RouterPort();
  router.attach(chat, { id: 'chat' });
  router.attach(cache, { id: 'cache' });
  const load = (port, unit) => {
    const method = 'system/introspect';
    const call = { type: 'call', id: `load-${unit}`, method, args: [unit] };
    router.receive(port, JSON.stringify(call));
  };
  load(chat, 'chat');
  load(cache, 'cache');
  const count = cache.packets.length;
  const event = JSON.stringify({ type: 'event', name: 'chat/log', data: {} });
  RouterTransport.last.emit('message', event);
  assert.equal(chat.packets.at(-1), event);
  assert.equal(cache.packets.length, count);
});
