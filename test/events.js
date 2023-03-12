'use strict';

const metatests = require('metatests');
const EventEmitter = require('../lib/events.js');

metatests.test('EventEmitter polyfill', async (test) => {
  const ee = new EventEmitter();
  ee.on('name', () => {
    test.end();
  });
  ee.emit('name');
});
