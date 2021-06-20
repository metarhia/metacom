'use strict';

const metatests = require('metatests');
const { Worker } = require('worker_threads');

metatests.test(
  'Start server without balancer with 2 workers (2 ports)',
  (test) => {
    const workersNum = 3;

    for (let i = 1; i < workersNum; i++) {
      const worker = new Worker('./test/worker.js');
      worker.on('message', (message) => {
        if (message.includes('port undefined')) {
          test.error(new Error('Listen port undefined in worker 3'));
        }
      });
    }

    setTimeout(() => {
      test.end();
    }, 100);
  }
);
