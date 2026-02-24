'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { WebsocketServer } = require('../../../lib/websocket/server.js');
const { ProtocolClient } = require('../utils/protocolClient.js');

test('should echo messages', async () => {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer({ server: httpServer });

  tinyWsServer.on('connection', (conn) => {
    conn.on('message', (msg) => conn.send(`Echo: ${msg}`));
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const client = new ProtocolClient(`ws://localhost:${port}`);

  const received = await new Promise((resolve) => {
    client.on('open', () => client.send('Hello tinyWS'));
    client.on('message', (msg) => {
      resolve(msg.toString());
      client.close();
    });
  });

  assert.strictEqual(received, 'Echo: Hello tinyWS');

  await new Promise((resolve) => httpServer.close(resolve));
});
