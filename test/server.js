'use strict';

const timers = require('node:timers/promises');
const { WebSocket } = require('ws');
const { test } = require('node:test');
const assert = require('node:assert');
const { Server } = require('../lib/server.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
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
  };
  const application = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    static: { constructor: { name: 'Static' } },
    auth: { saveSession: async () => {} },
    getMethod: (unit, _version, method) => new ProcedureMock(api[unit][method]),
    getHook: noop,
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
    const id = 1;
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
    const id = 1;
    const args = { name: 'Max' };
    const packet = { type: 'call', id, method: 'test/hello', args };
    const socket = new WebSocket(`ws://${options.host}:${options.port}`);
    await new Promise((res) => socket.on('open', res));
    socket.send(JSON.stringify(packet));
    const resPacket = await new Promise((res) => socket.on('message', res));
    const response = JSON.parse(resPacket);
    assert.strictEqual(response.id, id);
    assert.strictEqual(response.type, 'callback');
    assert.strictEqual(response.result, `Hello, ${args.name}`);
  });
});
