'use strict';

const tests = ['client', 'server', 'streams'];

for (const test of tests) {
  require(`./${test}.js`);
}
