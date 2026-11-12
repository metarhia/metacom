'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const {
  Metacom,
  MetacomPeer,
  MetacomProxy,
  MetacomRtcBridge,
  ClientRtcBridgeTransport,
  ClientEventTransport,
} = require('../metacom.js');
const {
  RtcTarget,
  RtcMockPeer,
  rtcSignals,
  rtcOptions,
} = require('./helpers/rtc.js');

globalThis.RTCPeerConnection = RtcMockPeer;

const bridgeWorker = (t) => {
  const old = globalThis.self;
  const scope = new RtcTarget();
  const container = new RtcTarget();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: container },
  });
  t.after(() =>
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor),
  );
  const source = {
    id: 'owner',
    url: 'https://example.test/owner',
    postMessage(data) {
      container.dispatch('message', { data });
    },
  };
  scope.location = {
    origin: 'https://example.test',
    host: 'example.test',
    protocol: 'https:',
  };
  scope.clients = { matchAll: async () => [source] };
  globalThis.self = scope;
  t.after(() => {
    globalThis.self = old;
  });
  const worker = {
    postMessage: (data, ports = []) => {
      scope.dispatch('message', {
        data,
        ports,
        source,
        origin: scope.location.origin,
      });
    },
  };
  container.controller = worker;
  return { scope, worker, source, container };
};

test('RTC bridge: proxy RPC, events, streams and owner loss', async (t) => {
  const { worker, scope } = bridgeWorker(t);
  const signaling = rtcSignals();
  const host = new MetacomPeer({ rtc: rtcOptions(signaling, 'answerer') });
  host.register('test', {
    echo: (args) => args,
    event: (_args, context) => {
      context.emit('test/changed', 9);
    },
    upload: async ({ id }, context) => [
      ...new Uint8Array(
        await (await context.getStream(id).toBlob()).arrayBuffer(),
      ),
    ],
    download: ({ id }, context) => {
      const stream = context.createStream('file', 3, id);
      stream.write(new Uint8Array([7, 8, 9]));
      stream.end();
    },
  });
  const proxy = new MetacomProxy({
    url: 'host',
    transport: 'rtc-bridge',
    bridge: { peerId: 'host', authorize: (client) => client.id === 'owner' },
  });
  proxy.register('local', { sum: ({ a, b }) => a + b });
  const opening = proxy.open();
  const accepting = host.open();
  const bridge = MetacomRtcBridge.attach(worker, rtcOptions(signaling));
  const tabs = [];
  t.after(() => {
    for (const tab of tabs) tab.close();
    proxy.close();
    bridge.close();
    host.close();
  });
  await Promise.all([opening, accepting, bridge.ready]);
  for (let index = 0; index < 2; index++) {
    const transport = new ClientEventTransport('host');
    const tab = new Metacom('host', transport, { worker });
    tabs.push(tab);
    await tab.open();
    await tab.load('test', 'local');
  }
  const replies = await Promise.all(
    tabs.map((tab, index) => tab.api.test.echo({ index })),
  );
  assert.deepEqual(replies, [{ index: 0 }, { index: 1 }]);
  assert.equal(await tabs[0].api.local.sum({ a: 2, b: 3 }), 5);
  const event = tabs[0].api.test.toPromise('changed');
  await tabs[0].api.test.event();
  assert.equal(await event, 9);
  const uploader = tabs[0].createBlobUploader(new Blob(['hello']));
  const upload = tabs[0].api.test.upload({ id: uploader.id });
  await uploader.upload();
  assert.deepEqual(await upload, [...new TextEncoder().encode('hello')]);
  const readable = tabs[1].createReadable();
  await tabs[1].api.test.download({ id: readable.id });
  assert.deepEqual(
    [...new Uint8Array(await (await readable.toBlob()).arrayBuffer())],
    [7, 8, 9],
  );
  bridge.close();
  await delay(10);
  assert.equal(proxy.active, false);
  assert.equal(bridge.closed, true);
  assert.ok(scope.listeners.get('message').size > 0);
});

test('RTC bridge: authorization, cancellation and timeout', async (t) => {
  const { worker } = bridgeWorker(t);
  const signaling = rtcSignals();
  const transport = new ClientRtcBridgeTransport('host');
  await assert.rejects(transport.open(), /authorization/);
  const pending = transport.open({
    bridge: {
      peerId: 'host',
      authorize: () => false,
      handshakeTimeout: 100,
    },
  });
  const rejected = MetacomRtcBridge.attach(worker, rtcOptions(signaling));
  await assert.rejects(rejected.ready, /rejected/);
  transport.close();
  await assert.rejects(pending, /closed/);
  rejected.close();
  const timeout = transport.open({
    bridge: {
      peerId: 'host',
      authorize: () => true,
      handshakeTimeout: 5,
    },
  });
  await assert.rejects(timeout, /timeout/);
  transport.close();
});

test('RTC bridge: controller change, reattach and bounded drain', async (t) => {
  const { worker, container } = bridgeWorker(t);
  const signaling = rtcSignals();
  const host = new MetacomPeer({ rtc: rtcOptions(signaling, 'answerer') });
  const transport = new ClientRtcBridgeTransport('host');
  const options = { bridge: { peerId: 'host', authorize: () => true } };
  const owners = [];
  const attach = async () => {
    const opening = transport.open(options);
    const accepting = host.open();
    const owner = MetacomRtcBridge.attach(worker, rtcOptions(signaling));
    owners.push(owner);
    await Promise.all([opening, accepting, owner.ready]);
    return owner;
  };
  t.after(() => {
    transport.close();
    for (const owner of owners) owner.close();
    host.close();
  });
  const first = await attach();
  assert.throws(
    () => transport.write('x'.repeat(17 * 1024 * 1024)),
    /queue limit/,
  );
  transport.write(
    JSON.stringify({
      type: 'call',
      id: 'drain',
      method: 'system/introspect',
      args: [],
    }),
  );
  await transport.drain();
  container.controller = {};
  container.dispatch('controllerchange');
  await delay(10);
  assert.equal(first.closed, true);
  assert.equal(transport.active, false);
  transport.close();
  host.close();
  container.controller = worker;
  const second = await attach();
  assert.equal(second.closed, false);
  transport.write(
    JSON.stringify({
      type: 'call',
      id: 'closing',
      method: 'system/introspect',
      args: [],
    }),
  );
  const draining = transport.drain();
  transport.close();
  await draining;
  await delay(10);
  assert.equal(second.closed, true);
});
