'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Connection } = require('../../../lib/websocket/connection.js');
const { Frame } = require('../../../lib/websocket/frame.js');
const {
  OPCODES,
  CLOSE_TIMEOUT,
} = require('../../../lib/websocket/constants.js');
const { FrameParser } = require('../../../lib/websocket/frameParser.js');
const { MockSocket } = require('../utils/mockSocket.js');

test('Connection: should emit message on text frame', async () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0));

  await new Promise((resolve) => {
    conn.on('message', (msg, isBinary) => {
      assert.ok(Buffer.isBuffer(msg));
      assert.ok(msg.equals(Buffer.from('hello')));
      assert.strictEqual(isBinary, false);
      resolve();
    });

    conn.on('error', (err) => {
      assert.fail(`Unexpected error: ${err.message}`);
    });

    const frame = Frame.text('hello');
    frame.maskPayload();
    socket.emit('data', frame.toBuffer());
  });

  conn.terminate();
});

test('Connection: should send pong when ping received', async () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0), {});

  const ping = Frame.ping();
  ping.maskPayload();
  socket.emit('data', ping.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const frame = FrameParser.parse(lastWrite).value.frame;
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  conn.terminate();
});

test('Connection: should close on close frame', async () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0), {});

  return new Promise((resolve) => {
    conn.on('close', () => {
      assert.strictEqual(socket.ended, true);
      resolve();
    });
    const close = Frame.close();
    close.maskPayload();
    socket.emit('data', close.toBuffer());
  });
});

test('Connection: sendClose triggers socket end after CLOSE_TIMEOUT', () => {
  const sock = new MockSocket();
  const conn = new Connection(sock, Buffer.alloc(0), { closeTimeout: 100 });

  conn.sendClose(1000, 'bye');

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(sock.destroyed, true);
      resolve();
    }, CLOSE_TIMEOUT + 100);
  });
});
