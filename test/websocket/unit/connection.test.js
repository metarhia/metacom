'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ws = require('#ws');
const { Connection, Frame, FrameParser } = ws;
const { OPCODES, CLOSE_TIMEOUT, CLOSE_CODES } = ws;
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

test('Connection: rejects fragmented message exceeding maxBuffer', () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0), { maxBuffer: 10 });
  conn.on('error', () => {});

  const first = Frame.text('abcde', false);
  first.maskPayload();
  socket.emit('data', first.toBuffer());

  const cont = new Frame(
    false,
    OPCODES.CONTINUATION,
    false,
    Buffer.from('abcde'),
    null,
  );
  cont.maskPayload();
  socket.emit('data', cont.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const closeFrame = FrameParser.parse(lastWrite).value.frame;
  assert.strictEqual(closeFrame.opcode, OPCODES.CLOSE);
  assert.strictEqual(
    closeFrame.payload.readUInt16BE(0),
    CLOSE_CODES.MESSAGE_TOO_BIG,
  );
});

test('Connection: ignores data frames after sending close', async () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0), { closeTimeout: 50 });
  let messages = 0;

  conn.on('message', () => {
    messages++;
  });

  conn.sendClose(1000, 'bye');

  const text = Frame.text('late');
  text.maskPayload();
  socket.emit('data', text.toBuffer());

  assert.strictEqual(messages, 0);
  conn.terminate();
});

test('Connection: responds to ping during close handshake', () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0), { closeTimeout: 50 });

  conn.sendClose(1000, 'bye');

  const ping = Frame.ping();
  ping.maskPayload();
  socket.emit('data', ping.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const frame = FrameParser.parse(lastWrite).value.frame;
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  conn.terminate();
});

test('Connection: socket error terminates connection', async () => {
  const socket = new MockSocket();
  const conn = new Connection(socket, Buffer.alloc(0));

  const error = await new Promise((resolve) => {
    conn.on('error', resolve);
    socket.emit('error', new Error('socket failure'));
  });

  assert.strictEqual(error.message, 'socket failure');
  assert.strictEqual(socket.destroyed, true);
});
