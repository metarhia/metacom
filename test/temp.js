'use strict';
const { Server } = require('../lib/server');
const config = {
  host: '127.0.0.1',
  balancer: 8000,
  protocol: 'http',
  ports: [8001, 8002],
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
  console: {
    log: (args) => {
      console.log(args);
    },
    error: (args) => {
      console.error(args);
    },
    info: (args) => {
      console.info(args);
    },
  },
  cert: '',
};

const server = new Server(config, application);
console.log(server);
