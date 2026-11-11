'use strict';

const timers = require('node:timers/promises');
const { Blob } = require('node:buffer');
const { test } = require('node:test');
const assert = require('node:assert');

const { Server } = require('../lib/server.js');
const { Metacom } = require('../lib/metacom.js');
const { MetacomProxy } = require('../lib/proxy.js');
const { ClientEventTransport } = require('../lib/client-event.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
};

const DELIVERY_MS = 50;
const PAYLOAD = 'hello from server';

class ProcedureMock {
  constructor({ handler, access = 'public' }) {
    this.handler = handler;
    this.access = access;
  }

  // eslint-disable-next-line class-methods-use-this
  async enter() {}

  // eslint-disable-next-line class-methods-use-this
  leave() {}

  invoke(context, args) {
    return this.handler(args, context);
  }
}

const noop = () => {};

const api = {
  hello: async ({ name }) => `Hello, ${name}`,
  notify: async (args, context) => {
    context.client.emit('test/ping', { ping: true });
    return { ok: true };
  },
  readUpload: async ({ id }, context) => {
    const stream = context.client.getStream(id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks).toString('utf8');
    return { name: stream.name, size: stream.size, data };
  },
  download: async ({ name, id }, context) => {
    const payload = Buffer.from(PAYLOAD);
    const stream = context.client.createStream(name, payload.length, id);
    queueMicrotask(() => {
      stream.write(payload);
      stream.end();
    });
    return { id: stream.id };
  },
};

const introspect = async () => {
  const methods = {};
  for (const name of Object.keys(api)) methods[name] = {};
  return { test: methods };
};

const application = {
  clients: new Set(),
  console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
  auth: { saveSession: async () => {} },
  getMethod: (unit, version, name) => {
    const isIntrospect = unit === 'system' && name === 'introspect';
    if (isIntrospect) return new ProcedureMock({ handler: introspect });
    const handler = unit === 'test' ? api[name] : null;
    if (!handler) return null;
    const counted = async (args, context) => {
      application.clients.add(context.client);
      return handler(args, context);
    };
    return new ProcedureMock({ handler: counted });
  },
};

const createEnvironment = (port) => {
  const listeners = [];
  return {
    location: { protocol: 'http:', host: `127.0.0.1:${port}` },
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    dispatch(event) {
      for (const { type, listener } of listeners) {
        if (type === 'message') listener(event);
      }
    },
  };
};

test('MetacomProxy with Server', async (t) => {
  const options = { host: '127.0.0.1', port: 0, protocol: 'http' };
  const server = new Server(application, { ...options, timeouts: {} });
  await server.listen();
  const { port } = server.httpServer.address();
  const environment = createEnvironment(port);
  globalThis.self = environment;
  const proxy = new MetacomProxy();
  await proxy.open();
  const tabs = [];

  const connect = async (id) => {
    const postMessage = (data, ports = []) => {
      environment.dispatch({ data, ports, source: { id } });
    };
    const worker = { postMessage };
    const url = `ws://127.0.0.1:${port}`;
    const transport = new ClientEventTransport(url);
    const tab = new Metacom(url, transport, { worker });
    tab.errors = [];
    tab.on('error', (error) => tab.errors.push(error.message));
    tabs.push(tab);
    await tab.open();
    await tab.load('test');
    return tab;
  };

  t.after(async () => {
    for (const tab of tabs) tab.close();
    proxy.close();
    delete globalThis.self;
    await server.close();
  });

  const tab1 = await connect('tab1');
  const tab2 = await connect('tab2');

  await t.test('calls from tabs share one server client', async () => {
    const results = await Promise.all([
      tab1.api.test.hello({ name: 'one' }),
      tab2.api.test.hello({ name: 'two' }),
    ]);
    assert.deepStrictEqual(results, ['Hello, one', 'Hello, two']);
    assert.strictEqual(application.clients.size, 1);
  });

  await t.test('server event reaches every tab', async () => {
    const received = [];
    tab1.api.test.once('ping', (data) => received.push(data));
    tab2.api.test.once('ping', (data) => received.push(data));
    await tab1.api.test.notify();
    await timers.setTimeout(DELIVERY_MS);
    assert.deepStrictEqual(received, [{ ping: true }, { ping: true }]);
  });

  await t.test('upload from tab is readable on server', async () => {
    const data = 'Some random data for upload to the server';
    const blob = new Blob([data]);
    blob.name = 'upload-stream';
    const uploader = tab1.createBlobUploader(blob);
    const result = tab1.api.test.readUpload({ id: uploader.id });
    await uploader.upload();
    const expected = { name: 'upload-stream', size: blob.size, data };
    assert.deepStrictEqual(await result, expected);
  });

  await t.test(
    'download reaches only the tab that created stream',
    async () => {
      const readable = tab1.createReadable();
      const { id } = readable;
      const result = await tab1.api.test.download({ name: 'file', id });
      assert.strictEqual(result.id, id);
      const blob = await readable.toBlob();
      assert.strictEqual(await blob.text(), PAYLOAD);
      await timers.setTimeout(DELIVERY_MS);
      assert.throws(() => tab2.getStream(id), /is not initialized/);
      assert.deepStrictEqual(tab2.errors, []);
    },
  );

  await t.test('stream with server created id is not delivered', async () => {
    const { id } = await tab1.api.test.download({ name: 'file' });
    await timers.setTimeout(DELIVERY_MS);
    assert.throws(() => tab1.getStream(id), /is not initialized/);
    assert.throws(() => tab2.getStream(id), /is not initialized/);
    assert.deepStrictEqual(tab1.errors, []);
    assert.deepStrictEqual(tab2.errors, []);
  });
});
