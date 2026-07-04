'use strict';

const timers = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert');
const { Server } = require('../lib/server.js');
const { ProtocolClient } = require('./websocket/utils/protocolClient.js');

const parseStatusCode = (statusLine) => {
  if (!statusLine) return null;
  const parts = statusLine.split(' ');
  const code = parseInt(parts[1], 10);
  return Number.isFinite(code) ? code : null;
};

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
};

class ProcedureMock {
  constructor({ access, ...options }) {
    this.options = options;
    this.access = access;
  }

  // eslint-disable-next-line class-methods-use-this
  async enter() {}
  // eslint-disable-next-line class-methods-use-this
  leave() {}
  invoke(_context, args) {
    return this.options.handler(args);
  }
}

test('Server / calls', async (t) => {
  const api = {
    test: {
      hello: {
        access: 'public',
        handler: async ({ name }) => {
          await timers.setTimeout(10);
          return `Hello, ${name}`;
        },
      },
    },
  };
  const noop = () => {};
  const options = {
    host: 'localhost',
    port: 8003,
    protocol: 'http',
    timeouts: { bind: 100 },
    queue: { concurrency: 100, size: 100, timeout: 5_000 },
    generateId: randomUUID,
  };
  const application = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    static: { constructor: { name: 'Static' } },
    auth: { saveSession: async () => {} },
    getMethod: (unit, _version, method) => new ProcedureMock(api[unit][method]),
  };

  let server;

  t.beforeEach(async () => {
    server = new Server(application, options);
    await server.listen();
  });

  t.afterEach(async () => {
    await server.close();
  });

  await t.test('handles HTTP RPC', async () => {
    const id = randomUUID();
    const args = { name: 'Max' };
    const packet = { type: 'call', id, method: 'test/hello', args };
    const response = await fetch(`http://${options.host}:${options.port}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    }).then((res) => res.json());

    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });

  await t.test('WS RPC handles', async () => {
    const id = randomUUID();
    const args = { name: 'Max' };
    const packet = { type: 'call', id, method: 'test/hello', args };
    const socket = new ProtocolClient(`ws://${options.host}:${options.port}`);
    await new Promise((res) => socket.once('open', res));
    socket.send(JSON.stringify(packet));
    const resPacket = await new Promise((res) => socket.once('message', res));
    const response = JSON.parse(resPacket.toString());
    socket.close();
    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });

  await t.test('WS RPC handles on /api path', async () => {
    const id = randomUUID();
    const args = { name: 'Max' };
    const packet = { type: 'call', id, method: 'test/hello', args };
    const socket = new ProtocolClient(
      `ws://${options.host}:${options.port}/api`,
    );
    await new Promise((res) => socket.once('open', res));
    socket.send(JSON.stringify(packet));
    const resPacket = await new Promise((res) => socket.once('message', res));
    const response = JSON.parse(resPacket.toString());
    socket.close();
    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });

  await t.test('rejects websocket upgrade on invalid path', async () => {
    const res = await ProtocolClient.attemptHandshake({
      host: options.host,
      port: options.port,
      path: '/invalid',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
      timeoutMs: 600,
    });
    assert.strictEqual(parseStatusCode(res.statusLine), 403);
  });
});
