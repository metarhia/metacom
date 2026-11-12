'use strict';

const http = require('node:http');
const timers = require('node:timers/promises');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WebsocketServer } = require('#ws');
const transport = require('../lib/transport.js');
const { buildHeaders, ServerTransport, ClientTransport } = transport;
const { ClientWsTransport } = transport;

test('buildHeaders: returns default headers when cors is falsy', () => {
  const headers = buildHeaders(null);
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.ok('Content-Type' in headers);
});

test('buildHeaders: returns default headers when cors has no origin', () => {
  const headers = buildHeaders({});
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
});

// eslint-disable-next-line max-len
test('buildHeaders: overrides Access-Control-Allow-Origin when cors.origin is set', () => {
  const headers = buildHeaders({ origin: 'https://example.com' });
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://example.com');
  assert.ok('Content-Type' in headers, 'other headers preserved');
});

test('buildHeaders: does not mutate the default headers object', () => {
  const first = buildHeaders({ origin: 'https://a.com' });
  const second = buildHeaders(null);
  assert.equal(first['Access-Control-Allow-Origin'], 'https://a.com');
  assert.equal(second['Access-Control-Allow-Origin'], '*');
});

test('ClientTransport: starts inactive', () => {
  const transport = new ClientTransport('ws://localhost/api');
  assert.equal(transport.active, false);
  assert.equal(transport.url, 'ws://localhost/api');
});

test('ClientTransport: send serialises object and calls write', () => {
  const transport = new ClientTransport('ws://localhost/api');
  const written = [];
  transport.write = (data) => written.push(data);
  transport.send({ type: 'call', id: '1' });
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0]), { type: 'call', id: '1' });
});

test('ClientTransport: online and offline are no-ops by default', () => {
  const transport = new ClientTransport('ws://localhost/api');
  assert.doesNotThrow(() => transport.online());
  assert.doesNotThrow(() => transport.offline());
});

test('ServerTransport: send calls write with JSON-stringified object', () => {
  class TestTransport extends ServerTransport {
    constructor() {
      super('127.0.0.1');
      this.written = [];
    }
    write(data, code) {
      this.written.push({ data, code });
    }
  }
  const transport = new TestTransport();
  transport.send({ type: 'callback', id: '1' });
  assert.equal(transport.written.length, 1);
  assert.deepEqual(JSON.parse(transport.written[0].data), {
    type: 'callback',
    id: '1',
  });
  assert.equal(transport.written[0].code, 200);
});

// eslint-disable-next-line max-len
test('ServerTransport: error sends a callback packet with the error message', () => {
  class TestTransport extends ServerTransport {
    constructor() {
      super('127.0.0.1');
      this.written = [];
    }
    write(data) {
      this.written.push(data);
    }
  }
  const transport = new TestTransport();
  transport.error(404, { id: 'req-1', error: new Error('not found') });
  assert.equal(transport.written.length, 1);
  const packet = JSON.parse(transport.written[0]);
  assert.equal(packet.type, 'callback');
  assert.equal(packet.id, 'req-1');
  assert.equal(packet.error.code, 404);
  assert.equal(packet.error.message, 'not found');
});

// eslint-disable-next-line max-len
test('ServerTransport: error with no Error object uses HTTP status text', () => {
  class TestTransport extends ServerTransport {
    constructor() {
      super('127.0.0.1');
      this.written = [];
    }
    write(data) {
      this.written.push(data);
    }
  }
  const transport = new TestTransport();
  transport.error(500);
  const packet = JSON.parse(transport.written[0]);
  assert.equal(packet.error.code, 500);
  assert.equal(typeof packet.error.message, 'string');
  assert.ok(packet.error.message.length > 0);
});

// eslint-disable-next-line max-len
test('ServerTransport: error keeps application code, sends 500 as HTTP status', () => {
  class TestTransport extends ServerTransport {
    constructor() {
      super('127.0.0.1');
      this.written = [];
    }
    write(data, code) {
      this.written.push({ packet: JSON.parse(data), code });
    }
  }
  const transport = new TestTransport();
  transport.error(1001, { error: new Error('Domain error') });
  transport.error('EEXIST', { error: new Error('Already exists') });
  transport.error(404);
  const codes = transport.written.map(({ code }) => code);
  const packetCodes = transport.written.map(({ packet }) => packet.error.code);
  assert.deepEqual(codes, [500, 500, 404]);
  assert.deepEqual(packetCodes, [1001, 'EEXIST', 404]);
  assert.equal(transport.written[0].packet.error.message, 'Domain error');
});

test('ClientWsTransport: emits close once when connection drops', async () => {
  const httpServer = http.createServer();
  const wsServer = new WebsocketServer({ server: httpServer });
  wsServer.on('connection', (connection) => {
    connection.on('message', () => connection.terminate());
  });
  await new Promise((resolve) => {
    httpServer.listen(8091, resolve);
  });
  const client = new ClientWsTransport('ws://localhost:8091/');
  const events = [];
  client.on('close', () => events.push('close'));
  await client.open();
  client.write('drop');
  await timers.setTimeout(100);
  httpServer.close();
  assert.deepEqual(events, ['close']);
});

test('ClientWsTransport: failed open rejects without close event', async () => {
  const client = new ClientWsTransport('ws://localhost:8092/');
  const events = [];
  client.on('close', () => events.push('close'));
  await assert.rejects(client.open(), /Connection closed/);
  await timers.setTimeout(50);
  assert.deepEqual(events, []);
});
