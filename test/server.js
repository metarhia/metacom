'use strict';

const http = require('node:http');
const timers = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert');

const { Server } = require('../lib/server.js');
const { ProtocolClient } = require('./websocket/protocolClient.js');

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

  let server = null;

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
    const res = await fetch(`http://${options.host}:${options.port}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    });
    const response = await res.json();

    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });

  await t.test('handles HTTP REST call from URL', async () => {
    const url = `http://${options.host}:${options.port}/api/test/hello`;
    const res = await fetch(`${url}?name=Max`);
    const response = await res.json();
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, 'Hello, Max');
  });

  await t.test('rejects HTTP RPC with GET method', async () => {
    const res = await fetch(`http://${options.host}:${options.port}/api`);
    assert.strictEqual(res.status, 403);
  });

  await t.test('WS RPC handles', async () => {
    const id = randomUUID();
    const args = { name: 'Max' };
    const packet = { type: 'call', id, method: 'test/hello', args };
    const socket = new ProtocolClient(`ws://${options.host}:${options.port}`);
    await new Promise((resolve) => {
      socket.once('open', resolve);
    });
    socket.send(JSON.stringify(packet));
    const responsePacket = await new Promise((resolve) => {
      socket.once('message', resolve);
    });
    const response = JSON.parse(responsePacket.toString());
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
    await new Promise((resolve) => {
      socket.once('open', resolve);
    });
    socket.send(JSON.stringify(packet));
    const responsePacket = await new Promise((resolve) => {
      socket.once('message', resolve);
    });
    const response = JSON.parse(responsePacket.toString());
    socket.close();
    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });

  await t.test('rejects call packet with non-string method', async () => {
    const packet = { type: 'call', id: randomUUID(), method: 1 };
    const socket = new ProtocolClient(`ws://${options.host}:${options.port}`);
    await new Promise((resolve) => {
      socket.once('open', resolve);
    });
    socket.send(JSON.stringify(packet));
    const responsePacket = await new Promise((resolve) => {
      socket.once('message', resolve);
    });
    const response = JSON.parse(responsePacket.toString());
    socket.close();
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.error.message, 'Packet structure error');
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

test('Server / listen retries busy port without timeouts', async () => {
  const noop = () => {};
  const console = { log: noop, info: noop, warn: noop, error: noop };
  const application = { console, auth: {}, getMethod: () => null };
  const options = { host: 'localhost', port: 8005, protocol: 'http' };
  const blocker = http.createServer();
  await new Promise((resolve) => {
    blocker.listen(options.port, options.host, resolve);
  });
  const server = new Server(application, { ...options, retry: 2 });
  await assert.rejects(server.listen(), { code: 'EADDRINUSE' });
  server.httpServer.close();
  blocker.close();
});

test('Server / rejects oversized requests', async (t) => {
  const noop = () => {};
  const console = { log: noop, info: noop, warn: noop, error: noop };
  const application = { console, auth: {}, getMethod: () => null };
  const limits = { maxBodySize: 64, maxMessageSize: 64 };
  const options = { host: 'localhost', port: 8006, protocol: 'http' };
  const server = new Server(application, { ...options, ...limits });
  await server.listen();
  t.after(() => server.close());
  const args = { name: 'x'.repeat(100) };
  const packet = { type: 'call', id: randomUUID(), method: 'test/hello', args };
  const body = JSON.stringify(packet);
  const res = await fetch(`http://${options.host}:${options.port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.strictEqual(res.status, 413);
  const socket = new ProtocolClient(`ws://${options.host}:${options.port}`);
  await new Promise((resolve) => {
    socket.once('open', resolve);
  });
  const closed = new Promise((resolve) => {
    socket.once('close', resolve);
  });
  socket.send(body);
  assert.strictEqual(await closed, 1009);
});
