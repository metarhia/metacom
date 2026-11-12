'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ws = require('#ws');
const { Connection, Frame, parse } = ws;
const { OPCODES, CLOSE_TIMEOUT, CLOSE_CODES } = ws;
const { MockSocket } = require('./mockSocket.js');

test('Connection: should emit message on text frame', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));

  await new Promise((resolve) => {
    connection.on('message', (message, isBinary) => {
      assert.ok(Buffer.isBuffer(message));
      assert.ok(message.equals(Buffer.from('hello')));
      assert.strictEqual(isBinary, false);
      resolve();
    });

    connection.on('error', (error) => {
      assert.fail(`Unexpected error: ${error.message}`);
    });

    const frame = Frame.text('hello');
    frame.maskPayload();
    socket.emit('data', frame.toBuffer());
  });

  connection.terminate();
});

test('Connection: should send pong when ping received', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), {});

  const ping = Frame.ping();
  ping.maskPayload();
  socket.emit('data', ping.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const frame = parse(lastWrite).value.frame;
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  connection.terminate();
});

test('Connection: should close on close frame', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), {});

  return new Promise((resolve) => {
    connection.on('close', () => {
      assert.strictEqual(socket.ended, true);
      resolve();
    });
    const close = Frame.close();
    close.maskPayload();
    socket.emit('data', close.toBuffer());
  });
});

test('Connection: server ends socket right after close echo', () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));
  const close = Frame.close(1000, 'bye');
  close.maskPayload();
  socket.emit('data', close.toBuffer());
  assert.strictEqual(socket.ended, true);
  const echo = parse(socket.writtenData[0]).value.frame;
  assert.strictEqual(echo.opcode, OPCODES.CLOSE);
  connection.terminate();
});

test('Connection: sendClose triggers socket end after CLOSE_TIMEOUT', () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), {
    closeTimeout: 100,
  });

  connection.sendClose('bye', 1000);

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(socket.destroyed, true);
      resolve();
    }, CLOSE_TIMEOUT + 100);
  });
});

test('Connection: rejects fragmented message exceeding maxBuffer', () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), { maxBuffer: 10 });
  connection.on('error', () => {});

  const first = Frame.text('abcde', false);
  first.maskPayload();
  socket.emit('data', first.toBuffer());

  const continuation = new Frame(
    false,
    OPCODES.CONTINUATION,
    false,
    Buffer.from('abcde'),
    null,
  );
  continuation.maskPayload();
  socket.emit('data', continuation.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const closeFrame = parse(lastWrite).value.frame;
  assert.strictEqual(closeFrame.opcode, OPCODES.CLOSE);
  assert.strictEqual(
    closeFrame.payload.readUInt16BE(0),
    CLOSE_CODES['Message too big'],
  );
});

test('Connection: ignores data frames after sending close', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), {
    closeTimeout: 50,
  });
  let messages = 0;

  connection.on('message', () => {
    messages++;
  });

  connection.sendClose('bye', 1000);

  const text = Frame.text('late');
  text.maskPayload();
  socket.emit('data', text.toBuffer());

  assert.strictEqual(messages, 0);
  connection.terminate();
});

test('Connection: responds to ping during close handshake', () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0), {
    closeTimeout: 50,
  });

  connection.sendClose('bye', 1000);

  const ping = Frame.ping();
  ping.maskPayload();
  socket.emit('data', ping.toBuffer());

  const lastWrite = socket.writtenData[socket.writtenData.length - 1];
  const frame = parse(lastWrite).value.frame;
  assert.strictEqual(frame.opcode, OPCODES.PONG);
  connection.terminate();
});

test('Connection: socket error terminates connection', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));

  const error = await new Promise((resolve) => {
    connection.on('error', resolve);
    socket.emit('error', new Error('socket failure'));
  });

  assert.strictEqual(error.message, 'socket failure');
  assert.strictEqual(socket.destroyed, true);
});

test('Connection: reassembles frame delivered byte by byte', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));
  const frame = Frame.binary(Buffer.alloc(300, 7));
  frame.maskPayload();
  const buffer = frame.toBuffer();

  const received = new Promise((resolve) => {
    connection.on('message', (message, isBinary) => {
      resolve({ message, isBinary });
    });
  });
  for (let i = 0; i < buffer.length; i++) {
    socket.emit('data', buffer.subarray(i, i + 1));
  }

  const { message, isBinary } = await received;
  assert.strictEqual(isBinary, true);
  assert.ok(message.equals(Buffer.alloc(300, 7)));
  connection.terminate();
});

test('Connection: handles frames split across chunk boundaries', () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));
  const messages = [];
  connection.on('message', (message) => messages.push(message.toString()));

  const frames = ['first', 'second', 'third'].map((text) => {
    const frame = Frame.text(text);
    frame.maskPayload();
    return frame.toBuffer();
  });
  const stream = Buffer.concat(frames);
  const firstCut = frames[0].length - 2;
  const secondCut = frames[0].length + frames[1].length + 1;
  socket.emit('data', stream.subarray(0, firstCut));
  assert.deepStrictEqual(messages, []);
  socket.emit('data', stream.subarray(firstCut, secondCut));
  assert.deepStrictEqual(messages, ['first', 'second']);
  socket.emit('data', stream.subarray(secondCut));
  assert.deepStrictEqual(messages, ['first', 'second', 'third']);
  connection.terminate();
});

test('Connection: send reports full buffer, drain waits for it', async () => {
  const socket = new MockSocket();
  const connection = new Connection(socket, Buffer.alloc(0));
  socket.writableNeedDrain = true;
  assert.strictEqual(connection.sendBinary(Buffer.from('data')), false);
  let isDrained = false;
  const drained = connection.drain().then(() => {
    isDrained = true;
  });
  await new Promise(setImmediate);
  assert.strictEqual(isDrained, false);
  socket.writableNeedDrain = false;
  socket.emit('drain');
  await drained;
  assert.strictEqual(connection.sendBinary(Buffer.from('data')), true);
});
