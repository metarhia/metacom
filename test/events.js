'use strict';

const metatests = require('metatests');
const EventEmitter = require('../lib/events.js');
const { MetacomUnit } = require('../lib/client.js');

metatests.test('EventEmitter polyfill', async (test) => {
  const ee = new EventEmitter();
  ee.on('eventName', () => {
    test.end();
  });
  ee.emit('eventName');
});

metatests.test('MetacomUnit', async (test) => {
  const ee = new MetacomUnit();
  ee.on('eventName', () => {
    test.end();
  });
  ee.emit('eventName');
});

metatests.test('MetacomUnit subscribe *', async (test) => {
  test.plan(3);
  const ee = new MetacomUnit();
  ee.on('*', (name, data) => {
    test.strictEqual(name, 'eventName');
    test.strictEqual(data, { data: 100 });
  });
  ee.on('eventName', (data) => {
    test.strictEqual(data, { data: 100 });
  });
  ee.emit('eventName', { data: 100 });
});
