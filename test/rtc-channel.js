'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { RtcChannelEndpoint } = require('../lib/rtc-channel.js');
const { RtcMockChannel } = require('./helpers/rtc.js');
const { chunkEncode, chunkDecode } = require('../lib/chunks-browser.js');

const channelPair = (options = {}) => {
  const a = new RtcMockChannel();
  const b = new RtcMockChannel();
  a.other = b;
  b.other = a;
  a.open();
  b.open();
  return {
    a,
    b,
    sender: new RtcChannelEndpoint(a, options),
    receiver: new RtcChannelEndpoint(b, options),
  };
};

test('RTC framing: large JSON, stream packets and offset views', async () => {
  const { sender, receiver, a } = channelPair({ maxMessageSize: 100 });
  const received = [];
  receiver.on('message', (data) => received.push(data));
  const text = JSON.stringify({ hello: '😀'.repeat(1000) });
  sender.write(text);
  sender.write('');
  const payload = new Uint8Array([9, 1, 2, 3, 9]);
  const stream = chunkEncode('stream', payload.subarray(1, 4));
  sender.write(stream);
  sender.write(new DataView(payload.buffer, 1, 3));
  await delay(0);
  assert.equal(received[0], text);
  assert.equal(received[1], '');
  assert.deepEqual(chunkDecode(received[2]), {
    id: 'stream',
    payload: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(received[3], new Uint8Array([1, 2, 3]));
  assert.ok(a.sent.every((frame) => frame.length <= 100));
  sender.close();
});

test('RTC buffering: overflow, resume and close during drain', async () => {
  const options = {
    maxMessageSize: 40,
    highWaterBytes: 80,
    maxQueueBytes: 200,
  };
  const { a, sender } = channelPair(options);
  a.bufferedAmount = 80;
  assert.equal(sender.write('hello'), false);
  assert.throws(() => sender.write('x'.repeat(300)), /overflow/);
  const drains = [sender.drain(), sender.drain()];
  a.bufferedAmount = 0;
  a.dispatch('bufferedamountlow');
  await Promise.all(drains);
  a.bufferedAmount = 80;
  sender.write('pending');
  const closing = sender.drain();
  sender.close();
  sender.close();
  await closing;
  assert.throws(() => sender.write('after close'), /not connected/);
  for (const set of a.listeners.values()) assert.equal(set.size, 0);
});

test('RTC framing: invalid fragments, limits and timeout', async () => {
  const { a, sender } = channelPair({ maxMessageSize: 40 });
  sender.write('x'.repeat(40));
  const first = a.sent[0];
  sender.close();
  for (const modify of [
    (frame) => {
      frame[2] = 9;
    },
    (frame) => {
      new DataView(frame.buffer).setUint32(8, 100000000);
    },
    (frame) => {
      new DataView(frame.buffer).setUint32(12, 2);
    },
  ]) {
    const channel = new RtcMockChannel();
    channel.open();
    const endpoint = new RtcChannelEndpoint(channel, { maxMessageSize: 40 });
    const frame = first.slice();
    modify(frame);
    channel.dispatch('message', { data: frame });
    assert.equal(endpoint.closed, true);
  }
  const {
    b,
    receiver,
    sender: source,
  } = channelPair({
    maxMessageSize: 40,
    assemblyTimeout: 5,
  });
  b.dispatch('message', { data: first });
  await delay(15);
  assert.equal(receiver.closed, true);
  source.close();
  const { sender: limited } = channelPair({ maxMessageBytes: 10 });
  assert.throws(() => limited.write('x'.repeat(11)), /message limit/);
  limited.close();
  const { a: failed, sender: failing } = channelPair();
  failed.send = () => {
    throw new Error('send failure');
  };
  assert.throws(() => failing.write('x'), /send failed/);
  assert.equal(failing.closed, true);
});
