'use strict';

const metatests = require('metatests');
const { delay } = require('metautil');
const { Server } = require('../lib/server');
const { Metacom } = require('../lib/client.js');

const host = 'localhost';
const protocol = 'ws';
const port = 8000;
const url = `${protocol}://${host}:${port}`;
const queue = { size: 1, timeout: 1000 };
const options = { port, protocol, queue };
const application = { console };

const CONNECTION_CLOSE_TIMEOUT = 100;

metatests.test('Client.close()', async (test) => {
  const server = new Server(options, application);
  const client = Metacom.create(url);
  await client.open();
  await client.load();

  test.ok(client.active);
  test.ok(client.pingInterval);
  test.notEqual(client.callTimeouts, {});

  client.close();

  await delay(CONNECTION_CLOSE_TIMEOUT);

  test.equal(client.active, false);
  test.equal(client.connected, false);
  test.equal(client.socket, null);

  test.equal(client.pingInterval, null);
  test.equal(client.reconnectTimeout, null);
  test.equal(client.callTimeouts, {});

  server.close();

  test.end();
});
