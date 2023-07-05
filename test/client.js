'use strict';

const timers = require('node:timers/promises');
const metatests = require('metatests');
const { WebSocketServer } = require('ws');
const metautil = require('metautil');
const { Metacom } = require('../lib/client.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

metatests.test('Client / call', async (test) => {
  const api = {
    system: {
      introspect: { handler: async () => api },
    },
    test: {
      test: {
        handler: async () => {
          await timers.setTimeout(10);
          return { success: true };
        },
      },
      timeout: {
        handler: async () => {
          await timers.setTimeout(200);
          return { success: true };
        },
      },
      error: {
        handler: async () => {
          throw new Error('Error message');
        },
      },
    },
  };

  const mockServer = new WebSocketServer({ port: 8000 });
  mockServer.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      const packet = metautil.jsonParse(raw) || {};
      const { type, id, method } = packet;
      const [unit, name] = method.split('/');
      if (type !== 'call') return;
      try {
        const result = await api[unit][name].handler();
        ws.send(JSON.stringify({ type: 'callback', id, result }));
      } catch (/** @type any */ { message }) {
        const packet = { type: 'callback', id, error: { code: 400, message } };
        ws.send(JSON.stringify(packet));
      }
    });
  });

  /** @type Metacom */
  let client;

  test.defer(() => {
    mockServer.close();
  });

  test.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8000/', { callTimeout: 150 });
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => {
    client.close();
  });

  test.testAsync('handles simple api calls', async (t) => {
    const result = await client.api.test.test();
    t.strictEqual(result, { success: true });
  });

  test.testAsync('handles parallel api calls', async (t) => {
    const promises = [];
    for (let i = 0; i < 10; i++) promises.push(client.api.test.test());
    const res = await Promise.all(promises);
    for (const r of res) t.strictEqual(r, { success: true });
  });

  test.testAsync('handles call timeouts', async (t) => {
    await t.rejects(client.api.test.timeout(), new Error('Request timeout'));
  });

  test.testAsync('handles api errors', async (t) => {
    await t.rejects(client.api.test.error(), new Error('Error message'));
  });
});
