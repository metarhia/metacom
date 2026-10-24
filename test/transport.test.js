'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHeaders,
  ServerTransport,
  ClientTransport,
} = require('../lib/transport.js');

test('buildHeaders: returns default headers when cors is falsy', () => {
  const h = buildHeaders(null);
  assert.equal(h['Access-Control-Allow-Origin'], '*');
  assert.ok('Content-Type' in h);
});

test('buildHeaders: returns default headers when cors has no origin', () => {
  const h = buildHeaders({});
  assert.equal(h['Access-Control-Allow-Origin'], '*');
});

// eslint-disable-next-line max-len
test('buildHeaders: overrides Access-Control-Allow-Origin when cors.origin is set', () => {
  const h = buildHeaders({ origin: 'https://example.com' });
  assert.equal(h['Access-Control-Allow-Origin'], 'https://example.com');
  assert.ok('Content-Type' in h, 'other headers preserved');
});

test('buildHeaders: does not mutate the default headers object', () => {
  const a = buildHeaders({ origin: 'https://a.com' });
  const b = buildHeaders(null);
  assert.equal(a['Access-Control-Allow-Origin'], 'https://a.com');
  assert.equal(b['Access-Control-Allow-Origin'], '*');
});

test('ClientTransport: starts inactive', () => {
  const t = new ClientTransport('ws://localhost/api');
  assert.equal(t.active, false);
  assert.equal(t.url, 'ws://localhost/api');
});

test('ClientTransport: send serialises object and calls write', () => {
  const t = new ClientTransport('ws://localhost/api');
  const written = [];
  t.write = (data) => written.push(data);
  t.send({ type: 'call', id: '1' });
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0]), { type: 'call', id: '1' });
});

test('ClientTransport: online and offline are no-ops by default', () => {
  const t = new ClientTransport('ws://localhost/api');
  assert.doesNotThrow(() => t.online());
  assert.doesNotThrow(() => t.offline());
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
  const t = new TestTransport();
  t.send({ type: 'callback', id: '1' });
  assert.equal(t.written.length, 1);
  assert.deepEqual(JSON.parse(t.written[0].data), {
    type: 'callback',
    id: '1',
  });
  assert.equal(t.written[0].code, 200);
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
  const t = new TestTransport();
  t.error(404, { id: 'req-1', error: new Error('not found') });
  assert.equal(t.written.length, 1);
  const packet = JSON.parse(t.written[0]);
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
  const t = new TestTransport();
  t.error(500);
  const packet = JSON.parse(t.written[0]);
  assert.equal(packet.error.code, 500);
  assert.equal(typeof packet.error.message, 'string');
  assert.ok(packet.error.message.length > 0);
});
