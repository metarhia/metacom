'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../../lib/transport-ws.js');
require('../../lib/transport-http.js');
require('../../lib/transport-event.js');
const {
  allTransports,
  getTransport,
  registerTransport,
} = require('../../lib/transport-registry.js');

const REQUIRED_CAPABILITIES = ['duplex', 'streams', 'events'];

const assertCapabilities = (caps, name) => {
  assert.ok(
    caps && typeof caps === 'object',
    `${name}: capabilities must be an object`,
  );
  for (const key of REQUIRED_CAPABILITIES) {
    assert.ok(
      typeof caps[key] === 'boolean',
      `${name}: capabilities.${key} must be a boolean`,
    );
  }
};

const assertMethod = (obj, method, name) => {
  assert.equal(
    typeof obj.prototype[method],
    'function',
    `${name}: must have method '${method}'`,
  );
};

test('Transport registry: built-in adapters are registered', () => {
  const names = [...allTransports()].map(([name]) => name);
  assert.ok(names.includes('ws'), 'ws adapter must be registered');
  assert.ok(names.includes('http'), 'http adapter must be registered');
  assert.ok(names.includes('event'), 'event adapter must be registered');
});

test('Transport registry: getTransport throws for unknown name', () => {
  assert.throws(() => getTransport('unknown-transport'), /Unknown transport/);
});

test('registerTransport: rejects empty name', () => {
  assert.throws(
    () =>
      registerTransport('', {
        Client: class {},
        Server: class {},
        capabilities: {},
      }),
    /Transport name must be a non-empty string/,
  );
});

test('registerTransport: rejects non-string name', () => {
  assert.throws(
    () =>
      registerTransport(42, {
        Client: class {},
        Server: class {},
        capabilities: {},
      }),
    /Transport name must be a non-empty string/,
  );
});

test('registerTransport: rejects missing Client', () => {
  assert.throws(
    () => registerTransport('test', { Server: class {}, capabilities: {} }),
    /Client must be a constructor/,
  );
});

test('registerTransport: rejects non-function Client', () => {
  assert.throws(
    () =>
      registerTransport('test', {
        Client: 'not-a-function',
        Server: class {},
        capabilities: {},
      }),
    /Client must be a constructor/,
  );
});

test('registerTransport: rejects missing Server', () => {
  assert.throws(
    () => registerTransport('test', { Client: class {}, capabilities: {} }),
    /Server must be a constructor/,
  );
});

test('registerTransport: rejects missing capabilities', () => {
  assert.throws(
    () => registerTransport('test', { Client: class {}, Server: class {} }),
    /capabilities must be an object/,
  );
});

test('registerTransport: rejects null capabilities', () => {
  assert.throws(
    () =>
      registerTransport('test', {
        Client: class {},
        Server: class {},
        capabilities: null,
      }),
    /capabilities must be an object/,
  );
});

for (const [name, adapter] of allTransports()) {
  // eslint-disable-next-line max-len
  test(`Transport adapter '${name}': has Client and Server constructors`, () => {
    assert.equal(typeof adapter.Client, 'function');
    assert.equal(typeof adapter.Server, 'function');
  });

  test(`Transport adapter '${name}': capabilities are valid`, () => {
    assertCapabilities(adapter.capabilities, name);
  });

  test(`Transport adapter '${name}': Client has required methods`, () => {
    for (const method of ['open', 'close', 'write', 'send']) {
      assertMethod(adapter.Client, method, `Client '${name}'`);
    }
  });

  test(`Transport adapter '${name}': Server has required methods`, () => {
    for (const method of ['write', 'close', 'send', 'error']) {
      assertMethod(adapter.Server, method, `Server '${name}'`);
    }
  });

  // eslint-disable-next-line max-len
  test(`Transport adapter '${name}': Server.capabilities match adapter capabilities`, () => {
    const serverCaps = adapter.Server.capabilities;
    assertCapabilities(serverCaps, `Server '${name}'`);
    assert.deepEqual(
      serverCaps,
      adapter.capabilities,
      `Server.capabilities for '${name}' must match adapter-level capabilities`,
    );
  });

  if (typeof adapter.attach !== 'undefined') {
    test(`Transport adapter '${name}': attach is a function`, () => {
      assert.equal(typeof adapter.attach, 'function');
    });

    // eslint-disable-next-line max-len
    test(`Transport adapter '${name}': attach accepts (server, options, onConnection)`, () => {
      assert.equal(
        adapter.attach.length,
        3,
        `attach for '${name}' must accept exactly 3 arguments`,
      );
    });
  }
}

test('ClientHttpTransport: open emits open and sets active', async () => {
  const { Client } = getTransport('http');
  const transport = new Client('http://localhost:9999/api');
  const events = [];
  transport.on('open', () => events.push('open'));

  assert.equal(transport.active, false, 'initially inactive');
  await transport.open();
  assert.equal(transport.active, true, 'active after open');
  assert.deepEqual(events, ['open']);
});

test('ClientHttpTransport: close emits close and clears active', async () => {
  const { Client } = getTransport('http');
  const transport = new Client('http://localhost:9999/api');
  const events = [];
  transport.on('close', () => events.push('close'));

  await transport.open();
  transport.close();
  assert.equal(transport.active, false, 'inactive after close');
  assert.deepEqual(events, ['close']);
});

test('ClientHttpTransport: double open is idempotent', async () => {
  const { Client } = getTransport('http');
  const transport = new Client('http://localhost:9999/api');
  const opens = [];
  transport.on('open', () => opens.push('open'));

  await transport.open();
  await transport.open();
  assert.deepEqual(opens, ['open'], 'open event fires only once');
});

test('ClientHttpTransport: send serialises object to JSON', async () => {
  const { Client } = getTransport('http');
  const transport = new Client('http://localhost:9999/api');
  await transport.open();

  const written = [];
  transport.write = (data) => written.push(data);
  transport.send({ type: 'call', id: '1', method: 'unit/method', args: {} });
  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0]);
  assert.equal(parsed.type, 'call');
  assert.equal(parsed.id, '1');
});

test('http adapter: not duplex, no streams, no events', () => {
  const { capabilities } = getTransport('http');
  assert.equal(capabilities.duplex, false);
  assert.equal(capabilities.streams, false);
  assert.equal(capabilities.events, false);
});

test('ws adapter: duplex, streams, events all true', () => {
  const { capabilities } = getTransport('ws');
  assert.equal(capabilities.duplex, true);
  assert.equal(capabilities.streams, true);
  assert.equal(capabilities.events, true);
});

test('event adapter: duplex, streams, events all true', () => {
  const { capabilities } = getTransport('event');
  assert.equal(capabilities.duplex, true);
  assert.equal(capabilities.streams, true);
  assert.equal(capabilities.events, true);
});
