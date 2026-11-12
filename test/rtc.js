'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { RtcConnection } = require('../lib/rtc.js');
const {
  RtcMockPeer,
  RtcMockChannel,
  rtcSignals,
  rtcOptions,
} = require('./helpers/rtc.js');

globalThis.RTCPeerConnection = RtcMockPeer;

test('RTC: both roles, shared open and fresh generations', async (t) => {
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  const signaling = rtcSignals();
  const a = new RtcConnection();
  const b = new RtcConnection();
  t.after(() => {
    a.close();
    b.close();
  });
  const openingB = b.open(rtcOptions(signaling, 'answerer'));
  const openingA = a.open(rtcOptions(signaling));
  assert.equal(a.open(rtcOptions(signaling)), openingA);
  const [channelA, channelB] = await Promise.all([openingA, openingB]);
  assert.equal(channelA.other, channelB);
  const old = signaling.messages[0].generation;
  a.close();
  a.close();
  b.close();
  assert.equal(signaling.listeners.size, 0);
  const nextB = b.open(rtcOptions(signaling, 'answerer'));
  signaling.send(signaling.messages[0]);
  const nextA = a.open(rtcOptions(signaling));
  await Promise.all([nextA, nextB]);
  assert.notEqual(signaling.messages.at(-1).generation, old);
});

test('RTC: early candidates and wrong-peer signaling', async (t) => {
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  const signaling = rtcSignals();
  const b = new RtcConnection();
  const pending = b.open(rtcOptions(signaling, 'answerer'));
  const pc = b.peerConnection;
  const base = {
    protocol: 'metacom:rtc',
    version: 1,
    source: 'caller',
    target: 'host',
    generation: 'g',
  };
  signaling.send({ ...base, source: 'foreign', version: 9 });
  signaling.send({ ...base, candidate: { candidate: 'early' } });
  await delay(0);
  assert.equal(pc.candidates.length, 0);
  const offerer = new RtcMockPeer();
  offerer.createDataChannel();
  signaling.send({ ...base, description: { type: 'offer', sdp: offerer.id } });
  await delay(0);
  pc.channel.open();
  await pending;
  assert.deepEqual(pc.candidates, [{ candidate: 'early' }]);
  b.close();
  offerer.close();
});

test('RTC: validation, timeout, cancellation and failures', async (t) => {
  const original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  await assert.rejects(new RtcConnection().open({}), /unavailable/);
  globalThis.RTCPeerConnection = original;
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  const signaling = rtcSignals();
  const c = new RtcConnection();
  await assert.rejects(c.open({}), /identity/);
  await assert.rejects(
    c.open({ ...rtcOptions(signaling), signaling: {} }),
    /adapter/,
  );
  await assert.rejects(
    c.open({ ...rtcOptions(signaling), handshakeTimeout: 5 }),
    /timeout/,
  );
  const pending = c.open(rtcOptions(signaling));
  c.close();
  await assert.rejects(pending, /closed/);
  const failure = c.open(rtcOptions(signaling));
  c.peerConnection.iceConnectionState = 'failed';
  c.peerConnection.dispatch('iceconnectionstatechange');
  await assert.rejects(failure, /failed/);
  const invalid = c.open(rtcOptions(signaling, 'answerer'));
  signaling.send({
    protocol: 'metacom:rtc',
    version: 2,
    source: 'caller',
    target: 'host',
    generation: 'g',
  });
  await assert.rejects(invalid, /envelope/);
  const unreliable = c.open(rtcOptions(signaling, 'answerer'));
  const channel = new RtcMockChannel();
  channel.ordered = false;
  c.peerConnection.dispatch('datachannel', { channel });
  await assert.rejects(unreliable, /Reliable/);
  const error = c.open(rtcOptions(signaling));
  c.peerConnection.channel.dispatch('error');
  await assert.rejects(error, /channel error/);
  assert.equal(signaling.listeners.size, 0);
});
