'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Metacom, MetacomPeer } = require('../metacom.js');
const { RtcMockPeer, rtcSignals, rtcOptions } = require('./helpers/rtc.js');

globalThis.RTCPeerConnection = RtcMockPeer;

test('Peer: local RPC, errors, events and bidirectional streams', async (t) => {
  const signaling = rtcSignals();
  const host = new MetacomPeer({ rtc: rtcOptions(signaling, 'answerer') });
  host.register('test', {
    echo: (args) => args,
    fail: () => {
      throw new Error('local failure');
    },
    event: (_args, context) => {
      context.emit('test/changed', 7);
    },
    upload: async ({ id }, context) => {
      const blob = await context.getStream(id).toBlob();
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    download: ({ id }, context) => {
      const stream = context.createStream('download', 3, id);
      stream.write(new Uint8Array([4, 5, 6]));
      stream.end();
      return id;
    },
  });
  const client = Metacom.create('host', {
    transport: 'webrtc',
    rtc: rtcOptions(signaling),
  });
  t.after(() => {
    client.close();
    host.close();
  });
  await Promise.all([host.open(), client.open()]);
  await client.load('test');
  assert.deepEqual(await client.api.test.echo({ a: 1 }), { a: 1 });
  await assert.rejects(client.api.test.fail(), /local failure/);
  const event = client.api.test.toPromise('changed');
  await client.api.test.event();
  assert.equal(await event, 7);
  const uploader = client.createBlobUploader(
    new Blob([new Uint8Array([1, 2, 3])]),
  );
  const uploaded = client.api.test.upload({ id: uploader.id });
  await uploader.upload();
  assert.deepEqual(await uploaded, [1, 2, 3]);
  const readable = client.createReadable();
  await client.api.test.download({ id: readable.id });
  assert.deepEqual(
    [...new Uint8Array(await (await readable.toBlob()).arrayBuffer())],
    [4, 5, 6],
  );
});

test('Peer: isolated clients and upstream forwarding', async (t) => {
  const signaling = rtcSignals();
  const upstreamHost = new MetacomPeer({
    rtc: {
      ...rtcOptions(signaling, 'answerer'),
      localId: 'upstream',
      peerId: 'relay',
    },
  });
  upstreamHost.register('remote', { echo: (args) => args });
  const upstream = Metacom.create('upstream', {
    transport: 'webrtc',
    rtc: {
      ...rtcOptions(signaling),
      localId: 'relay',
      peerId: 'upstream',
    },
  });
  await Promise.all([upstreamHost.open(), upstream.open()]);
  const host = new MetacomPeer({
    upstream,
    rtc: ['one', 'two'].map((peerId) => ({
      ...rtcOptions(signaling, 'answerer'),
      peerId,
    })),
  });
  host.register('local', { who: (_args, context) => context.peerId });
  const clients = ['one', 'two'].map((localId) =>
    Metacom.create('host', {
      transport: 'webrtc',
      rtc: { ...rtcOptions(signaling), localId },
    }),
  );
  t.after(() => {
    for (const client of clients) client.close();
    host.close();
    upstreamHost.close();
  });
  await Promise.all([host.open(), ...clients.map((client) => client.open())]);
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index];
    await client.load('remote', 'local');
    assert.equal(await client.api.local.who(), index === 0 ? 'one' : 'two');
    assert.deepEqual(await client.api.remote.echo({ index }), { index });
  }
  clients[0].close();
  assert.equal(await clients[1].api.local.who(), 'two');
});
