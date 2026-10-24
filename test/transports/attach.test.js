'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Emitter } = require('metautil');

const { Server } = require('../../lib/server.js');
const { ServerTransport } = require('../../lib/transport.js');
const { ClientTransport } = require('../../lib/client-transport.js');
const {
  allTransports,
  registerTransport,
} = require('../../lib/transport-registry.js');

const application = { console: { error: () => {} } };
const options = { protocol: 'http', cors: { origin: '*' } };

class MockServerTransport extends ServerTransport {
  written = [];

  write(data) {
    this.written.push(data);
  }
}

MockServerTransport.capabilities = {
  duplex: true,
  streams: true,
  events: true,
};

const calls = [];

// Server is never started, emit close to stop WebsocketServer ping timer
const dispose = (server) => void server.httpServer.emit('close');

registerTransport('mock', {
  Client: ClientTransport,
  Server: MockServerTransport,
  capabilities: MockServerTransport.capabilities,
  attach: (server, attachOptions, onConnection) => {
    calls.push({ server, attachOptions, onConnection });
  },
});

test('Transport attach: every built-in adapter has attach hook', () => {
  for (const [name, adapter] of allTransports()) {
    assert.equal(typeof adapter.attach, 'function', name);
  }
});

test('Transport attach: Server attaches registered custom transport', () => {
  calls.length = 0;
  const server = new Server(application, options);
  assert.equal(calls.length, 1);
  const [{ server: target, attachOptions, onConnection }] = calls;
  assert.strictEqual(target, server);
  assert.equal(attachOptions.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(typeof attachOptions.verifyClient, 'function');
  assert.equal(typeof onConnection, 'function');
  assert.ok(server.wsServer, 'ws adapter still exposes wsServer');
  dispose(server);
});

test('Transport attach: websocketPath is passed as path', () => {
  calls.length = 0;
  const server = new Server(application, { ...options, websocketPath: '/ws' });
  const [{ attachOptions }] = calls;
  assert.equal(attachOptions.path, '/ws');
  assert.equal(attachOptions.verifyClient, undefined);
  dispose(server);
});

test('Transport attach: duplex transport messages reach Server', () => {
  calls.length = 0;
  const server = new Server(application, options);
  const [{ onConnection }] = calls;
  const transport = new MockServerTransport('mock');
  onConnection(transport);
  transport.emit('message', '{}');
  assert.equal(transport.written.length, 1);
  const packet = JSON.parse(transport.written[0]);
  assert.equal(packet.type, 'callback');
  assert.equal(packet.error.message, 'Packet structure error');
  dispose(server);
});

test('Transport attach: event transport connects through port', () => {
  const server = new Server(application, options);
  const port = new Emitter();
  const sent = [];
  port.postMessage = (data) => sent.push(data);
  port.close = () => {};
  server.emit('port', port);
  port.emit('message', '{}');
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]).error.message, 'Packet structure error');
  dispose(server);
});
