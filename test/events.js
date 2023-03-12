'use strict';

const metatests = require('metatests');
const EventEmitter = require('../lib/events.js');
const { MetacomInterface } = require('../lib/client.js');

metatests.test('EventEmitter polyfill', async (test) => {
  const ee = new EventEmitter();
  ee.on('name', () => {
    test.end();
  });
  ee.emit('name');
});

metatests.test('MetacomInterface', async (test) => {
  const ee = new MetacomInterface();
  ee.on('name', () => {
    test.end();
  });
  ee.emit('name');
});
