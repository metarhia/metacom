'use strict';

const metatests = require('metatests');
const protocol = require('../lib/protocol.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

const packets = {
  call: {
    normal: {
      input: {
        id: 1,
        unit: 'auth',
        version: 1,
        name: 'signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
        meta: { some: 'data' },
      },
      output: {
        type: 'call',
        id: 1,
        method: 'auth.1/signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
        meta: { some: 'data' },
      },
    },
    withoutVersion: {
      input: {
        id: 1,
        unit: 'auth',
        version: undefined,
        name: 'signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
        meta: { some: 'data' },
      },
      output: {
        type: 'call',
        id: 1,
        method: 'auth/signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
        meta: { some: 'data' },
      },
    },
  },
  callback: {
    normal: {
      input: {
        id: 1,
        result: { token: 'random-string' },
        meta: { some: 'data' },
      },
      output: {
        type: 'callback',
        id: 1,
        result: { token: 'random-string' },
        meta: { some: 'data' },
      },
    },
  },
  event: {
    normal: {
      input: {
        unit: 'account',
        eventName: 'created',
        data: { accountId: 'random-string' },
        meta: { some: 'data' },
      },
      output: {
        type: 'event',
        name: 'account/created',
        data: { accountId: 'random-string' },
        meta: { some: 'data' },
      },
    },
  },
  stream: {
    initializing: {
      input: { id: 1, name: 'some-name', size: 1e9, status: undefined },
      output: {
        type: 'stream',
        id: 1,
        name: 'some-name',
        size: 1e9,
        status: undefined,
      },
    },
    finalizing: {
      input: { id: 1, status: 'end', name: undefined, size: undefined },
      output: {
        type: 'stream',
        id: 1,
        status: 'end',
        name: undefined,
        size: undefined,
      },
    },
    terminating: {
      input: {
        id: 1,
        status: 'terminate',
        name: undefined,
        size: undefined,
      },
      output: {
        type: 'stream',
        id: 1,
        status: 'terminate',
        name: undefined,
        size: undefined,
      },
    },
  },
  error: {
    normal: {
      input: { id: 1, message: 'Invalid data', code: 400 },
      output: {
        type: 'callback',
        id: 1,
        error: { message: 'Invalid data', code: 400 },
      },
    },
    withoutCode: {
      input: { id: 1, message: 'Invalid data', code: undefined },
      output: {
        type: 'callback',
        id: 1,
        error: { message: 'Invalid data', code: undefined },
      },
    },
  },
};

metatests.test(
  `Protocol / handles unknown packet type serialization`,
  (test) => {
    const unknownTypePacket = protocol.serialize('unknown', {});
    test.ok(!unknownTypePacket);
    test.end();
  },
);

metatests.test(`Protocol / handles empty packet deserialization`, (test) => {
  const emptyPacketData = protocol.deserialize({});
  test.strictEqual(emptyPacketData, null);
  test.end();
});

const supportedCallTypes = Object.keys(packets);
for (const type of supportedCallTypes) {
  metatests.test(
    `Protocol / handles empty ${type} packet serialization`,
    (test) => {
      test.ok(protocol.serialize(type, {}));
      test.end();
    },
  );
  const testCases = packets[type];
  for (const [caseName, packet] of Object.entries(testCases)) {
    metatests.test(
      `Protocol / serializes ${type} packet (${caseName})`,
      (test) => {
        test.strictEqual(protocol.serialize(type, packet.input), packet.output);
        test.end();
      },
    );
    metatests.test(
      `Protocol / deserializes ${type} packet (${caseName})`,
      (test) => {
        metatests.strictEqual(protocol.deserialize(packet.output), {
          type,
          data: packet.input,
        });
        test.end();
      },
    );
  }
}
