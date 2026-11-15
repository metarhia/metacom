'use strict';

const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Server } = require('../lib/server.js');
const { Metacom } = require('../lib/metacom.js');

const noop = () => {};
const logger = { log: noop, info: noop, warn: noop, error: noop, debug: noop };

const start = async (t, application = { console: logger }) => {
  const options = {
    host: '127.0.0.1',
    port: 0,
    protocol: 'http',
    timeouts: { bind: 100 },
    generateId: randomUUID,
  };
  const server = new Server(application, options);
  await server.listen();
  t.after(() => server.close());
  const { port } = server.httpServer.address();
  return { server, port };
};

const connect = async (t, port) => {
  const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
  t.after(() => client.close());
  return client;
};

test('Server.register: plain handlers and introspection', async (t) => {
  const { server, port } = await start(t);
  server.register('chat', {
    send: async ({ text }, context) => {
      context.client.emit('chat/message', { text });
      return { sent: text };
    },
  });
  server.register('admin', { stats: () => 1 }, { access: 'session' });
  const client = await connect(t, port);
  await client.load('chat', 'admin', 'missing');
  assert.deepEqual(Object.keys(client.api).toSorted(), ['admin', 'chat']);
  const message = client.api.chat.toPromise('message');
  assert.deepEqual(await client.api.chat.send({ text: 'hi' }), { sent: 'hi' });
  assert.deepEqual(await message, { text: 'hi' });
  await assert.rejects(client.api.admin.stats(), { code: 403 });
});

test('Server.register: registered method shadows application', async (t) => {
  const procedure = (handler) => ({
    access: 'public',
    enter: async () => {},
    leave: noop,
    invoke: (context, args) => handler(args),
  });
  const methods = {
    'system/introspect': procedure(() => ({ app: { name: {}, own: {} } })),
    'app/name': procedure(() => 'application'),
    'app/own': procedure(() => 'own'),
  };
  const getMethod = (unit, version, name) => methods[`${unit}/${name}`];
  const { server, port } = await start(t, { console: logger, getMethod });
  server.register('app', { name: () => 'registered' });
  const client = await connect(t, port);
  await client.load('app');
  assert.equal(await client.api.app.name(), 'registered');
  assert.equal(await client.api.app.own(), 'own');
});

test('Server: requests outside API go to request event', async (t) => {
  const { server, port } = await start(t);
  server.on('request', ({ req, res }) => {
    res.end(`static ${req.url}`);
  });
  const page = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(await page.text(), 'static /index.html');
  const api = await fetch(`http://127.0.0.1:${port}/api`, { method: 'GET' });
  assert.equal(api.status, 403);
});

test('Server: frozen event data is serialized once for clients', async (t) => {
  const { server, port } = await start(t);
  const subscribers = [];
  server.register('feed', {
    subscribe: (args, context) => {
      subscribers.push(context.client);
      return subscribers.length;
    },
  });
  const clients = [await connect(t, port), await connect(t, port)];
  const received = [];
  for (const client of clients) {
    await client.load('feed');
    received.push(client.api.feed.toPromise('item'));
    await client.api.feed.subscribe();
  }
  let reads = 0;
  const data = {};
  const get = () => ++reads;
  Object.defineProperty(data, 'value', { enumerable: true, get });
  Object.freeze(data);
  for (const client of subscribers) client.emit('feed/item', data);
  assert.deepEqual(await Promise.all(received), [{ value: 1 }, { value: 1 }]);
  assert.equal(reads, 1);
});
