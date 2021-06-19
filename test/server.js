'use strict';
const metatests = require('metatests');
const { Server } = require('../lib/server');

class Console {
  constructor() {
    this.infoData;
  }
  log(message) {
    console.log(message);
  }
  error(message) {
    console.error(message);
  }
  info(message) {
    console.info(message);
    this.infoData = message;
  }
}

metatests.test('Start Server in a single process', async (test) => {
  const config = {
    host: '::',
    balancer: 8000,
    protocol: 'http',
    ports: [8001],
    timeouts: {
      bind: 2000,
      start: 30000,
      stop: 5000,
      request: 5000,
      watch: 1000,
    },
    queue: {
      concurrency: 1000,
      size: 2000,
      timeout: 3000,
    },
    workers: {
      pool: 2,
    },
  };
  const application = {
    console: new Console(),
  };

  const server = await new Server(config, application);

  test.strictSame(typeof server, 'object');
  test.strictSame(application.console.infoData, 'Listen port 8001 in worker 0');

  test.end();
});
