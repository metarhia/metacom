'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { WebsocketServer } = require('#ws');
const { ProtocolClient } = require('./protocolClient.js');

test('should echo messages', async () => {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer({ server: httpServer });

  tinyWsServer.on('connection', (connection) => {
    connection.on('message', (message) => connection.send(`Echo: ${message}`));
  });

  await new Promise((resolve) => {
    httpServer.listen(0, resolve);
  });
  const port = httpServer.address().port;

  const client = new ProtocolClient(`ws://localhost:${port}`);

  const received = await new Promise((resolve) => {
    client.on('open', () => client.send('Hello tinyWS'));
    client.on('message', (message) => {
      resolve(message.toString());
      client.close();
    });
  });

  assert.strictEqual(received, 'Echo: Hello tinyWS');

  await new Promise((resolve) => {
    httpServer.close(resolve);
  });
});
