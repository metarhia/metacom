'use strict';

const tests = ['events', 'client', 'server', 'streams'];

for (const test of tests) {
  require(`./${test}.js`);
}
