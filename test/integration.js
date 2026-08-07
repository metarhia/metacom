'use strict';

const timers = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { Blob } = require('node:buffer');
const { test } = require('node:test');
const assert = require('node:assert');

const { Server } = require('../lib/server.js');
const { Metacom } = require('../lib/metacom.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
};

class ProcedureMock {
  constructor({ access = 'public', handler }) {
    this.access = access;
    this.handler = handler;
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

const createApplication = (api) => {
  const introspect = (units = []) => {
    const result = {};
    for (const unit of units) {
      if (!api[unit]) continue;
      const methods = {};
      for (const name of Object.keys(api[unit])) methods[name] = {};
      result[unit] = methods;
    }
    return result;
  };

  return {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    static: { constructor: { name: 'Static' } },
    auth: { saveSession: async () => {} },
    getMethod: (unit, _ver, method) => {
      if (unit === 'system' && method === 'introspect') {
        return new ProcedureMock({
          handler: async (units) => introspect(units),
        });
      }
      const def = api[unit]?.[method];
      if (!def) return null;
      return new ProcedureMock(def);
    },
  };
};

const createServer = async (api) => {
  const options = {
    host: '127.0.0.1',
    port: 0,
    protocol: 'http',
    timeouts: { bind: 100 },
    queue: { concurrency: 100, size: 100, timeout: 5_000 },
    generateId: randomUUID,
  };
  const server = new Server(createApplication(api), options);
  await server.listen();
  const { port } = server.httpServer.address();
  return { server, port };
};

test('Integration / Metacom client with Server', async (t) => {
  const api = {
    test: {
      hello: {
        handler: async ({ name }) => {
          await timers.setTimeout(10);
          return `Hello, ${name}`;
        },
      },
      fail: {
        handler: async () => {
          const error = new Error('Boom');
          error.code = 400;
          throw error;
        },
      },
      secret: {
        access: 'private',
        handler: async () => 'secret',
      },
      notify: {
        handler: async (_args, context) => {
          context.client.emit('test/ping', { ping: true });
          return { ok: true };
        },
      },
      readUpload: {
        handler: async ({ id }, context) => {
          const stream = context.client.getStream(id);
          const chunks = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          return {
            name: stream.name,
            size: stream.size,
            data: Buffer.concat(chunks).toString('utf8'),
          };
        },
      },
      download: {
        handler: async ({ name }, context) => {
          const payload = Buffer.from('hello from server');
          const stream = context.client.createStream(name, payload.length);
          queueMicrotask(() => {
            stream.write(payload);
            stream.end();
          });
          return { id: stream.id };
        },
      },
    },
  };

  const { server, port } = await createServer(api);
  t.after(async () => {
    await server.close();
  });

  await t.test('WS RPC: load and call public method', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    const result = await client.api.test.hello({ name: 'Max' });
    assert.strictEqual(result, 'Hello, Max');
  });

  await t.test('HTTP RPC: load and call public method', async () => {
    const client = await Metacom.connect(`http://127.0.0.1:${port}/api`);
    t.after(() => void client.close());
    await client.load('test');
    const result = await client.api.test.hello({ name: 'Ada' });
    assert.strictEqual(result, 'Hello, Ada');
  });

  await t.test('WS RPC: propagates method errors', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    await assert.rejects(
      client.api.test.fail(),
      (error) => error.message === 'Boom' && error.code === 400,
    );
  });

  await t.test('WS RPC: rejects private method without session', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    await assert.rejects(
      client.api.test.secret(),
      (error) => error.code === 403,
    );
  });

  await t.test('WS events: server emit reaches client unit', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    const ping = new Promise((resolve) => client.api.test.on('ping', resolve));
    const result = await client.api.test.notify();
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(await ping, { ping: true });
  });

  await t.test('WS streams: client upload is readable on server', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    const data = 'Some random data for upload to the server';
    const blob = new Blob([data]);
    blob.name = 'upload-stream';
    const uploader = client.createBlobUploader(blob);
    const resultPromise = client.api.test.readUpload({ id: uploader.id });
    await uploader.upload();
    const uploaded = await resultPromise;
    assert.strictEqual(uploaded.name, 'upload-stream');
    assert.strictEqual(uploaded.size, blob.size);
    assert.strictEqual(uploaded.data, data);
  });

  await t.test('WS streams: server download readable on client', async () => {
    const client = await Metacom.connect(`ws://127.0.0.1:${port}/`);
    t.after(() => void client.close());
    await client.load('test');
    const { id } = await client.api.test.download({ name: 'download-stream' });
    const readable = client.getStream(id);
    const blob = await readable.toBlob();
    assert.strictEqual(await blob.text(), 'hello from server');
  });
});
