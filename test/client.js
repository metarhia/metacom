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

metatests.test('Client / calls', async (test) => {
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

  test.defer(() => void mockServer.close());

  test.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8000/', { callTimeout: 150 });
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => void client.close());

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

metatests.test('Client / events', async (test) => {
  const api = {
    system: {
      introspect: { handler: async () => api },
    },
    test: {
      echo: {
        handler: async () => {
          await timers.setTimeout(10);
          return { success: true };
        },
      },
    },
  };

  const mockServer = new WebSocketServer({ port: 8001 });
  mockServer.on('connection', (ws) => {
    const pingInterval = setInterval(() => {
      const packet = { type: 'event', name: 'test/ping', data: { ping: true } };
      ws.send(JSON.stringify(packet));
    }, 100);
    ws.on('close', () => void clearInterval(pingInterval));
    ws.on('message', async (raw) => {
      const packet = metautil.jsonParse(raw) || {};
      if (packet.type === 'call' && packet.method === 'system/introspect') {
        const introspection = { type: 'callback', id: packet.id, result: api };
        ws.send(JSON.stringify(introspection));
        return;
      }
      const { type, name, data } = packet;
      if (type !== 'event') return;
      const [unit, event] = name.split('/');
      const result = await api[unit][event].handler(data);
      ws.send(JSON.stringify({ type: 'event', name, data: result }));
    });
  });

  /** @type Metacom */
  let client;

  test.defer(() => void mockServer.close());

  test.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8001/', { callTimeout: 150 });
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => void client.close());

  test.testAsync('handles event emitting', async (t) => {
    client.api.test.emit('echo', { test: true });
    client.api.test.on('*', console.log);
    const echoResult = await new Promise((resolve) =>
      client.api.test.once('echo', resolve),
    );
    t.strictEqual(echoResult, { success: true });
  });

  test.testAsync('handles events from server', async (t) => {
    const ping = await new Promise((resolve) =>
      client.api.test.on('ping', resolve),
    );
    t.strictEqual(ping, { ping: true });
  });
});
