'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Metacom, ClientRtcTransport, TRANSPORTS } = require('../metacom.js');
const { RtcMockPeer, rtcSignals, rtcOptions } = require('./helpers/rtc.js');

globalThis.RTCPeerConnection = RtcMockPeer;

test('RTC transport: registry, RPC, events and streams', async (t) => {
  const signaling = rtcSignals();
  const host = new ClientRtcTransport('logical-host');
  const client = Metacom.create('logical-host', {
    transport: 'webrtc',
    rtc: rtcOptions(signaling),
  });
  t.after(() => {
    client.close();
    host.close();
  });
  assert.equal(TRANSPORTS.webrtc, ClientRtcTransport);
  const other = Metacom.create('logical-host', {
    transport: 'webrtc',
    rtc: rtcOptions(signaling),
  });
  assert.notEqual(client, other);
  other.close();
  await Promise.all([
    host.open({ rtc: rtcOptions(signaling, 'answerer') }),
    client.open(),
  ]);
  host.on('message', (data) => {
    const packet = JSON.parse(data);
    if (packet.type !== 'call') return;
    const result =
      packet.method === 'system/introspect'
        ? { test: { echo: {} } }
        : packet.args;
    host.send({ type: 'callback', id: packet.id, result });
  });
  await client.load('test');
  assert.deepEqual(await client.api.test.echo({ value: 7 }), { value: 7 });
  const event = client.api.test.toPromise('changed');
  host.send({ type: 'event', name: 'test/changed', data: 9 });
  assert.equal(await event, 9);
  const { MetaWritable } = require('../lib/streams.js');
  const readable = client.createReadable();
  const writable = new MetaWritable(readable.id, 'data', 3, host);
  writable.write(new Uint8Array([1, 2, 3]));
  writable.end();
  assert.deepEqual(
    new Uint8Array(await (await readable.toBlob()).arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
});

test('RTC transport: cancellation, reconnect and Node import', async () => {
  const signaling = rtcSignals();
  const a = new ClientRtcTransport('peer');
  const pending = a.open({ rtc: rtcOptions(signaling) });
  assert.equal(a.open({ rtc: rtcOptions(signaling) }), pending);
  a.close();
  await assert.rejects(pending, /closed/);
  const b = new ClientRtcTransport('peer');
  await Promise.all([
    b.open({ rtc: rtcOptions(signaling, 'answerer') }),
    a.open({ rtc: rtcOptions(signaling) }),
  ]);
  a.close();
  b.close();
  const original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  assert.doesNotThrow(() => require('../metacom.js'));
  await assert.rejects(a.open({ rtc: rtcOptions(signaling) }), /unavailable/);
  globalThis.RTCPeerConnection = original;
  a.close();
});
