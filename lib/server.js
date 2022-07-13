'use strict';

const http = require('http');
const https = require('https');
const metautil = require('metautil');
const { Semaphore } = metautil;
const ws = require('ws');
const { channels } = require('./channel.js');
const { serveStatic } = require('./static.js');
const transport = require('./transport.js');

const SHORT_TIMEOUT = 500;

class Server {
  constructor(options, application) {
    const { cors, queue } = options;
    this.options = options;
    this.application = application;
    if (cors) transport.http.addHeaders(cors);
    const concurrency = queue.concurrency || options.concurrency;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    this.server = null;
    this.ws = null;
    this.channels = channels;
    this.bind();
  }

  bind() {
    const { options, application } = this;
    const { host, port, kind, protocol, timeouts, nagle = true } = options;
    const proto = protocol === 'http' || kind === 'balancer' ? http : https;
    const listener = this.listener.bind(this);
    this.server = proto.createServer({ ...application.cert }, listener);
    if (!nagle) {
      this.server.on('connection', (socket) => {
        socket.setNoDelay(true);
      });
    }
    this.server.on('listening', () => {
      application.console.info(`Listen port ${port}`);
    });
    this.ws = new ws.Server({ server: this.server });
    this.ws.on('connection', (connection, req) => {
      transport.ws.createChannel(application, req, connection);
    });
    this.ws.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') return;
      application.console.warn(`Address in use: ${host}:${port}, retry...`);
      setTimeout(() => {
        this.bind();
      }, timeouts.bind);
    });
    this.server.listen(port, host);
  }

  listener(req, res) {
    const { url } = req;
    const channel = transport.http.createChannel(this.application, req, res);
    if (this.options.kind === 'balancer') {
      const host = metautil.parseHost(req.headers.host);
      const port = metautil.sample(this.options.ports);
      const { protocol } = this.options;
      channel.redirect(`${protocol}://${host}:${port}/`);
      return;
    }
    if (url.startsWith('/api')) this.request(channel);
    else serveStatic(channel);
  }

  request(channel) {
    const { req } = channel;
    if (req.method === 'OPTIONS') {
      channel.options();
      return;
    }
    if (req.url === '/api' && req.method !== 'POST') {
      channel.error(403);
      return;
    }
    const body = metautil.receiveBody(req);
    if (req.url === '/api') {
      body.then((data) => {
        channel.message(data);
      });
    } else {
      body.then((data) => {
        let args = null;
        if (data.length > 0) {
          args = metautil.jsonParse(data);
          if (!args) {
            const error = new Error('JSON parsing error');
            channel.error(500, { error, pass: true });
            return;
          }
        }
        const pathname = req.url.slice('/api/'.length);
        const [path, params] = metautil.split(pathname, '?');
        if (!args) args = metautil.parseParams(params);
        const [interfaceName, methodName] = metautil.split(path, '/');
        const { headers } = req;
        const hook = this.application.getHook(interfaceName);
        if (hook) channel.hook(hook, interfaceName, methodName, args, headers);
        else channel.rpc(-1, interfaceName, methodName, args, headers);
      });
    }
    body.catch((error) => {
      channel.error(500, { error });
    });
  }

  closeChannels() {
    for (const channel of this.channels.values()) {
      if (channel.connection) {
        channel.connection.terminate();
      } else {
        channel.error(503);
        channel.req.connection.destroy();
      }
    }
  }

  async close() {
    this.server.close((err) => {
      if (err) this.application.console.error(err);
    });
    if (this.channels.size === 0) {
      await metautil.delay(SHORT_TIMEOUT);
      return;
    }
    await metautil.delay(this.options.timeouts.stop);
    this.closeChannels();
  }
}

module.exports = { Server };
