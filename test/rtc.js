'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { RtcConnection } = require('../lib/rtc.js');
const helpers = require('./helpers/rtc.js');
const { RtcMockPeer, RtcMockChannel, rtcSignals, rtcOptions } = helpers;

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
  const channels = await Promise.all([openingA, openingB]);
  const channelA = channels[0];
  const channelB = channels[1];
  assert.equal(channelA.other, channelB);
  assert.equal(signaling.messages[0].media, undefined);
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

const CALL_SLOTS = [
  { slot: 'mic', kind: 'audio' },
  { slot: 'camera', kind: 'video' },
  { slot: 'screen', kind: 'video' },
  { slot: 'screenAudio', kind: 'audio' },
];

const SLOT_NAMES = ['mic', 'camera', 'screen', 'screenAudio'];
const SLOT_KINDS = ['audio', 'video', 'video', 'audio'];

const mediaOpen = (signaling, role, media, codecs) => {
  const options = rtcOptions(signaling, role);
  if (media) options.media = media;
  if (codecs) options.codecs = codecs;
  return options;
};

const slotNames = (events) => events.map((event) => event.slot);

const installCodecs = (t) => {
  globalThis.RTCRtpSender = {
    getCapabilities(kind) {
      if (kind === 'audio') {
        return {
          codecs: [{ mimeType: 'audio/PCMU' }, { mimeType: 'audio/opus' }],
        };
      }
      return {
        codecs: [
          { mimeType: 'video/VP8' },
          { mimeType: 'video/VP9' },
          { mimeType: 'video/H264' },
        ],
      };
    },
  };
  t.after(() => {
    delete globalThis.RTCRtpSender;
  });
};

test('RTC: empty media stays data-only', async (t) => {
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  const signaling = rtcSignals();
  const a = new RtcConnection();
  const b = new RtcConnection();
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([
    b.open(mediaOpen(signaling, 'answerer', [])),
    a.open(mediaOpen(signaling, 'offerer', [])),
  ]);
  assert.equal(signaling.messages[0].media, undefined);
  assert.equal(a.peerConnection.getTransceivers().length, 0);
  assert.equal(a.sender('mic'), null);
});

test('RTC: media slots, tracks and a new generation', async (t) => {
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  installCodecs(t);
  const signaling = rtcSignals();
  const codecs = {
    audio: ['audio/opus'],
    video: ['video/VP9', 'video/VP8', 'video/H264'],
  };
  const a = new RtcConnection();
  const b = new RtcConnection();
  const eventsA = [];
  const eventsB = [];
  a.on('track', (event) => eventsA.push(event));
  b.on('track', (event) => eventsB.push(event));
  let stops = 0;
  const stop = () => {
    stops += 1;
  };
  const camera = { id: 'cam', kind: 'video', stop };
  const next = { id: 'next', kind: 'video', stop };
  await a.setTrack('camera', camera);
  assert.equal(a.sender('camera'), null);
  assert.equal(a.receiver('camera'), null);
  t.after(() => {
    a.close();
    b.close();
  });
  const openA = mediaOpen(signaling, 'offerer', CALL_SLOTS, codecs);
  const openB = mediaOpen(signaling, 'answerer', CALL_SLOTS, codecs);
  await Promise.all([b.open(openB), a.open(openA)]);
  assert.deepEqual(slotNames(eventsA), SLOT_NAMES);
  assert.deepEqual(slotNames(eventsB), SLOT_NAMES);
  assert.deepEqual(
    eventsA.map((event) => event.track.kind),
    SLOT_KINDS,
  );
  assert.deepEqual(
    eventsB.map((event) => event.track.kind),
    SLOT_KINDS,
  );
  assert.equal(a.sender('camera').track, camera);
  assert.equal(a.receiver('screen').track.kind, 'video');
  assert.equal(b.receiver('screenAudio').track.kind, 'audio');
  assert.equal(b.sender('mic'), b.peerConnection.getTransceivers()[0].sender);
  const directions = b.peerConnection
    .getTransceivers()
    .map((item) => item.direction);
  assert.deepEqual(directions, [
    'sendrecv',
    'sendrecv',
    'sendrecv',
    'sendrecv',
  ]);
  const offer = signaling.messages.find(
    (message) => message.description.type === 'offer',
  );
  assert.deepEqual(offer.media, {
    0: 'mic',
    1: 'camera',
    2: 'screen',
    3: 'screenAudio',
  });
  const answer = signaling.messages.find(
    (message) => message.description.type === 'answer',
  );
  assert.equal(answer.media, undefined);
  const video = a.peerConnection.getTransceivers()[1];
  assert.deepEqual(
    video.codecPreferences.map((codec) => codec.mimeType),
    codecs.video,
  );
  const audio = b.peerConnection.getTransceivers()[0];
  assert.deepEqual(
    audio.codecPreferences.map((codec) => codec.mimeType),
    ['audio/opus'],
  );
  const sender = a.sender('camera');
  const recorded = sender.replaceTrack.bind(sender);
  let release = null;
  sender.replaceTrack = (track) =>
    new Promise((resolve) => {
      release = () => {
        recorded(track).then(resolve);
      };
    });
  let settled = false;
  const updating = a.setTrack('camera', next).then(() => {
    settled = true;
  });
  await delay(0);
  assert.equal(settled, false);
  release();
  await updating;
  assert.equal(sender.track, next);
  sender.replaceTrack = recorded;
  await a.setTrack('camera', null);
  assert.equal(sender.track, null);
  assert.deepEqual(sender.replaced, [camera, next, null]);
  a.close();
  b.close();
  assert.equal(stops, 0);
  assert.equal(a.peerConnection, null);
  assert.equal(a.sender('camera'), null);
  const mic = { id: 'mic', kind: 'audio', stop };
  await a.setTrack('mic', mic);
  await Promise.all([b.open(openB), a.open(openA)]);
  assert.equal(a.sender('mic').track, mic);
  assert.equal(a.sender('camera').track, null);
  assert.deepEqual(a.sender('camera').replaced, []);
  assert.deepEqual(slotNames(eventsA.slice(4)), SLOT_NAMES);
  assert.deepEqual(slotNames(eventsB.slice(4)), SLOT_NAMES);
  assert.equal(eventsA.length, 8);
  assert.equal(eventsB.length, 8);
});

const expectInvalidMedia = async (offererMedia, answererMedia) => {
  const signaling = rtcSignals();
  const a = new RtcConnection();
  const b = new RtcConnection();
  try {
    const openingB = b.open(mediaOpen(signaling, 'answerer', answererMedia));
    const openingA = a.open(mediaOpen(signaling, 'offerer', offererMedia));
    await assert.rejects(openingB, { message: 'Invalid RTC media' });
    a.close();
    await assert.rejects(openingA, /closed/);
  } finally {
    a.close();
    b.close();
  }
};

test('RTC: invalid media offers', async (t) => {
  t.mock.method(globalThis, 'RTCPeerConnection', RtcMockPeer);
  const shorter = CALL_SLOTS.slice(0, 3);
  const renamed = [
    { slot: 'mic', kind: 'audio' },
    { slot: 'camera', kind: 'video' },
    { slot: 'screen', kind: 'video' },
    { slot: 'extra', kind: 'audio' },
  ];
  await expectInvalidMedia(shorter, CALL_SLOTS);
  await expectInvalidMedia(renamed, CALL_SLOTS);
  await expectInvalidMedia(undefined, CALL_SLOTS);
  await expectInvalidMedia(CALL_SLOTS, undefined);
  const signaling = rtcSignals();
  const b = new RtcConnection();
  const pending = b.open(mediaOpen(signaling, 'answerer', CALL_SLOTS));
  const lines = [
    'peer',
    'm=video 9 UDP/TLS/RTP/SAVPF',
    'a=mid:0',
    'm=video 9 UDP/TLS/RTP/SAVPF',
    'a=mid:1',
    'm=video 9 UDP/TLS/RTP/SAVPF',
    'a=mid:2',
    'm=audio 9 UDP/TLS/RTP/SAVPF',
    'a=mid:3',
  ];
  signaling.send({
    protocol: 'metacom:rtc',
    version: 1,
    source: 'caller',
    target: 'host',
    generation: 'kind',
    description: { type: 'offer', sdp: lines.join('\n') },
    media: { 0: 'mic', 1: 'camera', 2: 'screen', 3: 'screenAudio' },
  });
  await assert.rejects(pending, { message: 'Invalid RTC media' });
  b.close();
  const duplicate = new RtcConnection();
  const again = duplicate.open(mediaOpen(signaling, 'answerer', CALL_SLOTS));
  const duplicateSdp = [
    'peer',
    'm=audio 9 UDP/TLS/RTP/SAVPF',
    'a=mid:0',
    'm=video 9 UDP/TLS/RTP/SAVPF',
    'a=mid:1',
    'm=video 9 UDP/TLS/RTP/SAVPF',
    'a=mid:2',
    'm=audio 9 UDP/TLS/RTP/SAVPF',
    'a=mid:3',
  ];
  signaling.send({
    protocol: 'metacom:rtc',
    version: 1,
    source: 'caller',
    target: 'host',
    generation: 'duplicate',
    description: { type: 'offer', sdp: duplicateSdp.join('\n') },
    media: { 0: 'mic', 1: 'camera', 2: 'screen', 3: 'mic' },
  });
  await assert.rejects(again, { message: 'Invalid RTC media' });
  duplicate.close();
});
