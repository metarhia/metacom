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
