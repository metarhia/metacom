'use strict';

const timers = require('node:timers/promises');
const { Blob } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const metautil = require('metautil');
const { Metacom } = require('../lib/client.js');
const { chunkEncode, chunkDecode } = require('../lib/streams.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

test('Client / calls', async (t) => {
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
          await timers.setTimeout(350);
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

  t.after(() => void mockServer.close());

  t.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8000/', {
      callTimeout: 300,
      generateId: randomUUID,
    });
    await client.opening;
    await client.load('test');
  });

  t.afterEach(async () => void client.close());

  await t.test('handles simple api calls', async () => {
    const result = await client.api.test.test();
    assert.deepStrictEqual(result, { success: true });
  });

  await t.test('handles parallel api calls', async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) promises.push(client.api.test.test());
    const res = await Promise.all(promises);
    for (const r of res) assert.deepStrictEqual(r, { success: true });
  });

  await t.test('handles call timeouts', async () => {
    const promise = client.api.test.timeout();
    await assert.rejects(promise, new Error('Request timeout'));
  });

  await t.test('handles api errors', async () => {
    await assert.rejects(client.api.test.error(), new Error('Error message'));
  });
});

test('Client / events', async (t) => {
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

  t.after(() => void mockServer.close());

  t.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8001/', { generateId: randomUUID });
    await client.opening;
    await client.load('test');
  });

  t.afterEach(async () => void client.close());

  await t.test('handles events from server', async () => {
    const ping = await new Promise((resolve) =>
      client.api.test.on('ping', resolve),
    );
    assert.deepStrictEqual(ping, { ping: true });
  });
});

test('Client / stream', async (t) => {
  const storage = new Map();

  const handleBinary = (chunk) => {
    const { id, payload } = chunkDecode(chunk);
    const stream = storage.get(id);
    if (!stream) return;
    const stringChunk = Buffer.from(payload).toString('utf8');
    stream.data.push(stringChunk);
  };

  const handleOutgoingStream = async (ws, { id, name, blob }) => {
    const initPacket = { type: 'stream', id, name, size: blob.size };
    const endPacket = { type: 'stream', id, status: 'end' };
    ws.send(JSON.stringify(initPacket));
    const reader = blob.stream().getReader();
    let chunk;
    while (!(chunk = await reader.read()).done) {
      ws.send(chunkEncode(id, chunk.value));
    }
    ws.send(JSON.stringify(endPacket));
  };

  const handleIncomingStream = ({ id, name, size, status }) => {
    const stream = storage.get(id);
    if (status) {
      if (!stream) throw new Error(`Stream ${id} is not initialized`);
      if (status === 'end') stream.status = 'ended';
      if (status === 'terminate') stream.status = 'terminated';
      return;
    }
    const valid = typeof name === 'string' && Number.isSafeInteger(size);
    if (!valid) throw new Error('Stream packet structure error');
    if (stream) throw new Error(`Stream ${id} is already initialized`);
    {
      const stream = { name, size, data: [], status: 'init' };
      storage.set(id, stream);
    }
  };

  const api = {
    system: {
      introspect: { handler: async () => api },
    },
    test: {
      getStreamData: {
        handler: async ({ id }) => storage.get(id),
      },
      download: {
        handler: async ({ name }, ws) => {
          const id = randomUUID();
          const data = 'Some random data for upload to the client';
          const blob = new Blob([data]);
          handleOutgoingStream(ws, { id, name, blob });
          return { id };
        },
      },
    },
  };

  const mockServer = new WebSocketServer({ port: 8002 });
  mockServer.on('connection', (ws) => {
    const pingInterval = setInterval(() => {
      const packet = { type: 'event', name: 'test/ping', data: { ping: true } };
      ws.send(JSON.stringify(packet));
    }, 100);
    ws.on('close', () => void clearInterval(pingInterval));
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return void handleBinary(new Uint8Array(raw));
      const packet = metautil.jsonParse(raw) || {};
      if (packet.type === 'call' && packet.method === 'system/introspect') {
        const introspection = { type: 'callback', id: packet.id, result: api };
        return void ws.send(JSON.stringify(introspection));
      }
      if (packet.type === 'stream') return void handleIncomingStream(packet);
      const { type, id, method, args } = packet;
      const [unit, name] = method.split('/');
      if (type !== 'call') return;
      const result = await api[unit][name].handler(args, ws);
      ws.send(JSON.stringify({ type: 'callback', id, result }));
    });
  });

  /** @type Metacom */
  let client;

  t.after(() => void mockServer.close());

  t.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8002/', { generateId: randomUUID });
    await client.opening;
    await client.load('test');
  });

  t.afterEach(async () => void client.close());

  await t.test('handles file uploades', async () => {
    const data = 'Some random data for upload to the server';
    const name = 'upload-stream';
    const blob = new Blob([data]);
    blob.name = name;
    const stream = client.createBlobUploader(blob);
    await stream.upload();
    const uploadedFile = await client.api.test.getStreamData({ id: stream.id });
    assert.strictEqual(uploadedFile.name, name);
    assert.strictEqual(uploadedFile.size, blob.size);
    assert.strictEqual(uploadedFile.data.join(''), data);
    assert.strictEqual(uploadedFile.status, 'ended');
  });

  await t.test('handles file downloads', async () => {
    const name = 'download-stream';
    const { id } = await client.api.test.download({ name });
    const readable = client.getStream(id);
    const blob = await readable.toBlob();
    const data = await blob.text();
    assert.strictEqual(data, 'Some random data for upload to the client');
  });
});

metatests.test('Client / different ID generation strategies', async (test) => {
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
    },
  };

  const mockServer = new WebSocketServer({ port: 8003 });
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

  test.defer(() => void mockServer.close());

  test.testAsync('works with UUID generation', async (subtest) => {
    const client = Metacom.create('ws://localhost:8003/', {
      generateId: randomUUID,
    });
    await client.opening;
    await client.load('test');
    const result = await client.api.test.test();
    subtest.strictEqual(result, { success: true });
    client.close();
  });

  test.testAsync('works with incremental IDs', async (subtest) => {
    let counter = 1;
    const client = Metacom.create('ws://localhost:8003/', {
      generateId: () => String(counter++),
    });
    await client.opening;
    await client.load('test');
    const result = await client.api.test.test();
    subtest.strictEqual(result, { success: true });
    client.close();
  });

  test.testAsync('works with timestamp-based IDs', async (subtest) => {
    const client = Metacom.create('ws://localhost:8003/', {
      generateId: () =>
        `ts_${Date.now()}_${Math.random().toString(36).substring(2)}`,
    });
    await client.opening;
    await client.load('test');
    const result = await client.api.test.test();
    subtest.strictEqual(result, { success: true });
    client.close();
  });

  test.testAsync('works with short random IDs', async (subtest) => {
    const client = Metacom.create('ws://localhost:8003/', {
      generateId: () => Math.random().toString(36).substring(2, 8),
    });
    await client.opening;
    await client.load('test');
    const result = await client.api.test.test();
    subtest.strictEqual(result, { success: true });
    client.close();
  });
});

metatests.test('Client / generateId validation', async (test) => {
  test.testAsync(
    'throws error when generateId is not provided',
    async (subtest) => {
      subtest.throws(() => {
        Metacom.create('ws://localhost:8000/');
      }, /generateId function is required/);
    },
  );

  test.testAsync('throws error when generateId is null', async (subtest) => {
    subtest.throws(() => {
      Metacom.create('ws://localhost:8000/', { generateId: null });
    }, /generateId function is required/);
  });

  test.testAsync(
    'throws error when generateId is undefined',
    async (subtest) => {
      subtest.throws(() => {
        Metacom.create('ws://localhost:8000/', { generateId: undefined });
      }, /generateId function is required/);
    },
  );
});
