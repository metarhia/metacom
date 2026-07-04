'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { WebsocketServer } = require('#ws');
const { ProtocolClient } = require('../utils/protocolClient.js');

test('WebsocketServer: accepts new connection after socket error', async () => {
  const httpServer = http.createServer();
  new WebsocketServer({
    server: httpServer,
    pingInterval: 50,
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const first = new ProtocolClient(`ws://localhost:${port}`);
  await new Promise((resolve) => first.on('open', resolve));
  first.socket.destroy();

  await new Promise((resolve) => setTimeout(resolve, 150));

  const second = new ProtocolClient(`ws://localhost:${port}`);
  const opened = await new Promise((resolve) => {
    second.on('open', () => resolve(true));
    second.on('close', () => resolve(false));
  });

  assert.strictEqual(opened, true);
  second.close();
  await new Promise((resolve) => httpServer.close(resolve));
});
