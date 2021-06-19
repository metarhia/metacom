'use strict';

const { parentPort } = require('worker_threads');
const { Server } = require('../lib/server');
class Console {
  constructor() {
    this.infoData = [];
    this.warnData = [];
  }
  log(message) {
    console.log(message);
  }
  error(message) {
    console.error(message);
  }
  info(message) {
    console.info(message);
    this.infoData.push(message);
  }
  warn(message) {
    this.warnData.push(message);
  }
}

const config = {
  host: '::',
  protocol: 'http',
  ports: [8000, 8001],
  nagle: true,
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

(async () => {
  await new Server(config, application);
  application.console.infoData.forEach((data) => {
    parentPort.postMessage(data);
  });
})();
