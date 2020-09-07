'use strict';

const http = require('http');
const https = require('https');
const worker = require('worker_threads');

const common = require('@metarhia/common');
const WebSocket = require('ws');

const Semaphore = require('./semaphore.js');
const Channel = require('./channel.js');

const SHUTDOWN_TIMEOUT = 5000;
const LONG_RESPONSE = 30000;

const timeout = msec =>
  new Promise(resolve => {
    setTimeout(resolve, msec);
  });

const sample = arr => arr[Math.floor(Math.random() * arr.length)];

const receiveBody = async req => {
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString();
};

class Server {
  constructor(config, { application }) {
    this.config = config;
    this.application = application;
    this.channels = new Map();
    const { ports, host, concurrency, queue } = config;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    const { threadId } = worker;
    const port = ports[threadId - 1];
    this.ports = config.ports.slice(1);
    const transport = threadId === 1 ? http : https;
    const listener = this.listener.bind(this);
    this.server = transport.createServer({ ...application.cert }, listener);
    this.ws = new WebSocket.Server({ server: this.server });
    this.ws.on('connection', (connection, req) => {
      const channel = new Channel(req, null, connection, application);
      connection.on('message', data => {
        channel.message(data);
      });
    });
    this.server.listen(port, host);
  }

  listener(req, res) {
    const { channels } = this;
    let finished = false;
    const { method, url, connection } = req;
    const channel = new Channel(req, res, null, this.application);
    channels.set(connection, channel);

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      channels.delete(connection);
      channel.error(504);
    }, LONG_RESPONSE);

    res.on('close', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channels.delete(connection);
    });

    if (url === '/api') {
      if (method !== 'POST') {
        channel.error(403);
        return;
      }
      receiveBody(req).then(
        data => {
          channel.message(data);
        },
        err => {
          channel.error(500, err);
        }
      );
    } else {
      if (url === '/' && !req.connection.encrypted) {
        const host = common.parseHost(req.headers.host);
        const port = sample(this.ports);
        channel.redirect(`https://${host}:${port}/`);
      }
      channel.static();
    }
  }

  closeChannels() {
    const { channels } = this;
    for (const [connection, channel] of channels.entries()) {
      channels.delete(connection);
      channel.error(503);
      connection.destroy();
    }
  }

  async close() {
    this.server.close(err => {
      if (err) this.application.logger.error(err.stack);
    });
    await timeout(SHUTDOWN_TIMEOUT);
    this.closeChannels();
  }
}

module.exports = { Server };
