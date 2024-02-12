'use strict';

const timers = require('node:timers/promises');
const { Blob } = require('node:buffer');
const metatests = require('metatests');
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

  test.defer(() => void mockServer.close());

  test.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8000/', { callTimeout: 300 });
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => void client.close());

  test.testAsync('handles simple api calls', async (subtest) => {
    const result = await client.api.test.test();
    subtest.strictEqual(result, { success: true });
  });

  test.testAsync('handles parallel api calls', async (subtest) => {
    const promises = [];
    for (let i = 0; i < 10; i++) promises.push(client.api.test.test());
    const res = await Promise.all(promises);
    for (const r of res) subtest.strictEqual(r, { success: true });
  });

  test.testAsync('handles call timeouts', async (subtest) => {
    const promise = client.api.test.timeout();
    await subtest.rejects(promise, new Error('Request timeout'));
  });

  test.testAsync('handles api errors', async (subtest) => {
    await subtest.rejects(client.api.test.error(), new Error('Error message'));
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
    client = Metacom.create('ws://localhost:8001/');
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => void client.close());

  test.testAsync('handles events from server', async (subtest) => {
    const ping = await new Promise((resolve) =>
      client.api.test.on('ping', resolve),
    );
    subtest.strictEqual(ping, { ping: true });
  });
});

metatests.test('Client / stream', async (test) => {
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
          const id = 2;
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

  test.defer(() => void mockServer.close());

  test.beforeEach(async () => {
    client = Metacom.create('ws://localhost:8002/');
    await client.opening;
    await client.load('test');
  });

  test.afterEach(async () => void client.close());

  test.testAsync('handles file uploades', async (subtest) => {
    const data = 'Some random data for upload to the server';
    const name = 'upload-stream';
    const blob = new Blob([data]);
    blob.name = name;
    const stream = client.createBlobUploader(blob);
    await stream.upload();
    const uploadedFile = await client.api.test.getStreamData({ id: stream.id });
    subtest.strictEqual(uploadedFile.name, name);
    subtest.strictEqual(uploadedFile.size, blob.size);
    subtest.strictEqual(uploadedFile.data.join(''), data);
    subtest.strictEqual(uploadedFile.status, 'ended');
  });

  test.testAsync('handles file downloads', async (subtest) => {
    const name = 'download-stream';
    const { id } = await client.api.test.download({ name });
    const readable = client.getStream(id);
    const blob = await readable.toBlob();
    const data = await blob.text();
    subtest.strictEqual(data, 'Some random data for upload to the client');
  });
});
