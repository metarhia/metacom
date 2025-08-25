'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { MAGIC } = require('../../../../lib/websocket/constants.js');
const { ProtocolClient } = require('../../utils/protocolClient.js');
const { WebsocketServer } = require('../../../../lib/websocket/server.js');

function parseStatusCode(statusLine) {
  if (!statusLine) return null;
  const parts = statusLine.split(' ');
  const code = parseInt(parts[1], 10);
  return Number.isFinite(code) ? code : null;
}

test('handshake: successful upgrade', async () => {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer(httpServer);
  tinyWsServer.on('connection', () => {
    // no-op: we only assert that handshake upgraded successfully
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const client = new ProtocolClient(`ws://localhost:${port}`);

  const opened = await new Promise((resolve) => {
    client.on('open', () => resolve(true));
    client.on('close', () => resolve(false));
  });

  assert.strictEqual(opened, true);

  // Close client and wait for its socket to finish before closing the server
  await new Promise((resolve) => {
    client.on('close', () => resolve());
    client.close();
  });

  await new Promise((resolve) => httpServer.close(resolve));
});

test('handshake: negative cases', async (t) => {
  await t.test('missing Upgrade header -> should not upgrade', async () => {
    const httpServer = http.createServer();
    const tinyWsServer = new WebsocketServer(httpServer);
    tinyWsServer.on('connection', () => {});

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const res = await ProtocolClient.attemptHandshake({
      host: 'localhost',
      port,
      headers: {
        // 'Upgrade' missing on purpose
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGVzdC1rZXk=',
      },
      timeoutMs: 250,
    });

    // Accept either an explicit non-101 response or immediate
    // socket close without headers
    const code = parseStatusCode(res.statusLine);
    assert.ok(
      res.statusLine === '' || code !== 101,
      `expected no upgrade, got: ${res.statusLine}`,
    );

    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test('missing Connection header -> should not upgrade', async () => {
    const httpServer = http.createServer();
    const tinyWsServer = new WebsocketServer(httpServer);
    tinyWsServer.on('connection', () => {});

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const res = await ProtocolClient.attemptHandshake({
      host: 'localhost',
      port,
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGVzdC1rZXk=',
      },
      timeoutMs: 250,
    });

    const code = parseStatusCode(res.statusLine);
    assert.ok(
      res.statusLine === '' || code !== 101,
      `expected no upgrade, got: ${res.statusLine}`,
    );

    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test(
    'unsupported Sec-WebSocket-Version -> should not upgrade',
    async () => {
      const httpServer = http.createServer();
      const tinyWsServer = new WebsocketServer(httpServer);
      tinyWsServer.on('connection', () => {});

      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await ProtocolClient.attemptHandshake({
        host: 'localhost',
        port,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '12',
          'Sec-WebSocket-Key': 'dGVzdC1rZXk=',
        },
        timeoutMs: 250,
      });

      const code = parseStatusCode(res.statusLine);
      assert.ok(
        res.statusLine === '' || code !== 101,
        `expected no upgrade, got: ${res.statusLine}`,
      );

      await new Promise((resolve) => httpServer.close(resolve));
    },
  );

  await t.test(
    'invalid Sec-WebSocket-Key (not base64) -> should not upgrade',
    async () => {
      const httpServer = http.createServer();
      const tinyWsServer = new WebsocketServer(httpServer);
      tinyWsServer.on('connection', () => {});

      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await ProtocolClient.attemptHandshake({
        host: 'localhost',
        port,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': '%%%not-base64%%%',
        },
        timeoutMs: 250,
      });

      const code = parseStatusCode(res.statusLine);
      assert.ok(
        res.statusLine === '' || code !== 101,
        `expected no upgrade, got: ${res.statusLine}`,
      );

      await new Promise((resolve) => httpServer.close(resolve));
    },
  );

  await t.test(
    'invalid Sec-WebSocket-Key length -> should not upgrade',
    async () => {
      const httpServer = http.createServer();
      const tinyWsServer = new WebsocketServer(httpServer);
      tinyWsServer.on('connection', () => {});

      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await ProtocolClient.attemptHandshake({
        host: 'localhost',
        port,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          // base64 is valid, but lower than 16 bytes after decoding
          'Sec-WebSocket-Key': Buffer.from('short').toString('base64'),
        },
        timeoutMs: 250,
      });

      const code = parseStatusCode(res.statusLine);
      assert.ok(
        res.statusLine === '' || code !== 101,
        `expected no upgrade, got: ${res.statusLine}`,
      );

      await new Promise((resolve) => httpServer.close(resolve));
    },
  );

  await t.test('wrong Upgrade token value -> should not upgrade', async () => {
    const httpServer = http.createServer();
    const tinyWsServer = new WebsocketServer(httpServer);
    tinyWsServer.on('connection', () => {});

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const res = await ProtocolClient.attemptHandshake({
      host: 'localhost',
      port,
      headers: {
        Upgrade: 'notwebsocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
      timeoutMs: 250,
    });

    const code = parseStatusCode(res.statusLine);
    assert.ok(
      res.statusLine === '' || code !== 101,
      `expected no upgrade, got: ${res.statusLine}`,
    );

    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test(
    'Connection header without Upgrade token -> should not upgrade',
    async () => {
      const httpServer = http.createServer();
      const tinyWsServer = new WebsocketServer(httpServer);
      tinyWsServer.on('connection', () => {});

      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await ProtocolClient.attemptHandshake({
        host: 'localhost',
        port,
        headers: {
          Upgrade: 'websocket',
          Connection: 'keep-alive',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key':
            Buffer.from('0123456789abcdef').toString('base64'),
        },
        timeoutMs: 250,
      });

      const code = parseStatusCode(res.statusLine);
      assert.ok(
        res.statusLine === '' || code !== 101,
        `expected no upgrade, got: ${res.statusLine}`,
      );

      await new Promise((resolve) => httpServer.close(resolve));
    },
  );

  await t.test(
    'missing Host header (HTTP/1.1 requires Host) -> should not upgrade',
    async () => {
      const httpServer = http.createServer();
      const tinyWsServer = new WebsocketServer(httpServer);
      tinyWsServer.on('connection', () => {});

      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await ProtocolClient.attemptHandshake({
        host: 'localhost',
        port,
        includeHost: false,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key':
            Buffer.from('0123456789abcdef').toString('base64'),
        },
        timeoutMs: 250,
      });

      const code = parseStatusCode(res.statusLine);
      assert.ok(
        res.statusLine === '' || code !== 101,
        `expected no upgrade, got: ${res.statusLine}`,
      );

      await new Promise((resolve) => httpServer.close(resolve));
    },
  );

  await t.test('wrong HTTP method (POST) -> should not upgrade', async () => {
    const httpServer = http.createServer();
    const tinyWsServer = new WebsocketServer(httpServer);
    tinyWsServer.on('connection', () => {});

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const res = await ProtocolClient.attemptHandshake({
      host: 'localhost',
      port,
      method: 'POST',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
      timeoutMs: 250,
    });

    const code = parseStatusCode(res.statusLine);
    assert.ok(
      res.statusLine === '' || code !== 101,
      `expected no upgrade, got: ${res.statusLine}`,
    );

    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test('HTTP/1.0 request -> should not upgrade', async () => {
    const httpServer = http.createServer();
    const tinyWsServer = new WebsocketServer(httpServer);
    tinyWsServer.on('connection', () => {});

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const res = await ProtocolClient.attemptHandshake({
      host: 'localhost',
      port,
      httpVersion: '1.0',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
      timeoutMs: 250,
    });

    const code = parseStatusCode(res.statusLine);
    assert.ok(
      res.statusLine === '' || code !== 101,
      `expected no upgrade, got: ${res.statusLine}`,
    );

    await new Promise((resolve) => httpServer.close(resolve));
  });
});

// eslint-disable-next-line max-len
test('handshake: Sec-WebSocket-Accept is correct and no subprotocol by default', async () => {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer(httpServer);
  // Terminate immediately to avoid waiting for heartbeat timeouts
  tinyWsServer.on('connection', (ws) => ws.terminate());

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  // Do a raw handshake to inspect headers
  const key = Buffer.from('0123456789abcdef').toString('base64');
  const res = await ProtocolClient.attemptHandshake({
    host: 'localhost',
    port,
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    },
    timeoutMs: 600,
  });

  // Compute expected accept
  const expected = crypto
    .createHash('sha1')
    .update(key)
    .update(MAGIC)
    .digest('base64');

  const code = parseStatusCode(res.statusLine);
  assert.strictEqual(code, 101);
  assert.strictEqual(res.headers['sec-websocket-accept'], expected);
  // No subprotocol unless negotiated
  assert.strictEqual(res.headers['sec-websocket-protocol'], undefined);

  await new Promise((resolve) => httpServer.close(resolve));
});

// eslint-disable-next-line max-len
test('handshake: Connection header token matching is case-insensitive and allows multiple', async () => {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer(httpServer);
  // Terminate immediately to avoid waiting for heartbeat timeouts
  tinyWsServer.on('connection', (ws) => ws.terminate());

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const res = await ProtocolClient.attemptHandshake({
    host: 'localhost',
    port,
    headers: {
      Upgrade: 'websocket',
      // mixed case and extra tokens
      Connection: 'keep-alive, UpGrAdE',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
    },
    timeoutMs: 600,
  });

  const code = parseStatusCode(res.statusLine);
  assert.strictEqual(code, 101);
  await new Promise((resolve) => httpServer.close(resolve));
});
