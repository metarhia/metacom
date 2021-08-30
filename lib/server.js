'use strict';

const http = require('http');
const https = require('https');
const { threadId } = require('worker_threads');
const metautil = require('metautil');
const { Semaphore } = metautil;
const ws = require('ws');
const { Channel, channels } = require('./channel.js');
const { serveStatic } = require('./static.js');

const SHORT_TIMEOUT = 500;

const receiveBody = async (req) => {
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString();
};

class Server {
  constructor(config, application) {
    if (threadId === 0) throw new Error(`Thread 0 is intended for system use`);
    this.config = config;
    this.application = application;
    const { host, balancer, protocol, ports, queue } = config;
    const concurrency = queue.concurrency || config.concurrency;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    this.balancer = balancer && threadId === 1;
    const skipBalancer = balancer ? 1 : 0;
    const port = this.balancer ? balancer : ports[threadId - skipBalancer - 1];
    if (!port) throw new Error(`No port configured thread ${threadId}`);
    this.port = port;
    this.server = null;
    this.ws = null;
    this.protocol = protocol;
    this.host = host;
    this.bind();
  }

  bind() {
    const { config, application, port, host } = this;
    const { protocol, timeouts, nagle = true } = config;
    const transport = protocol === 'http' || this.balancer ? http : https;
    const listener = this.listener.bind(this);
    this.server = transport.createServer({ ...application.cert }, listener);
    if (!nagle) {
      this.server.on('connection', (socket) => {
        socket.setNoDelay(true);
      });
    }
    this.server.on('listening', () => {
      application.console.info(`Listen port ${port} in worker ${threadId}`);
    });
    this.ws = new ws.Server({ server: this.server });
    this.ws.on('connection', async (connection, req) => {
      const channel = await new Channel(req, null, connection, application);
      connection.on('message', (data) => {
        channel.message(data);
      });
      connection.on('close', () => {
        channel.destroy();
      });
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

  async listener(req, res) {
    let finished = false;
    const { url } = req;
    const channel = await new Channel(req, res, null, this.application);

    res.on('close', () => {
      if (finished) return;
      finished = true;
      channel.destroy();
    });

    if (this.balancer) {
      const host = metautil.parseHost(req.headers.host);
      const port = metautil.sample(this.config.ports);
      const { protocol } = this.config;
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
    const body = receiveBody(req);
    if (req.url === '/api') {
      body.then((data) => {
        channel.message(data);
      });
    } else {
      body.then((data) => {
        const pathname = req.url.slice('/api/'.length);
        const [path, params] = metautil.split(pathname, '?');
        const args = data ? JSON.parse(data) : metautil.parseParams(params);
        const [interfaceName, methodName] = metautil.split(path, '/');
        const hook = this.application.getHook(interfaceName);
        if (hook) channel.hook(hook, interfaceName, methodName, args);
        else channel.rpc(-1, interfaceName, methodName, args);
      });
    }
    body.catch((err) => {
      channel.error(500, err);
    });
  }

  closeChannels() {
    for (const channel of channels.values()) {
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
    if (channels.size === 0) {
      await metautil.delay(SHORT_TIMEOUT);
      return;
    }
    await metautil.delay(this.config.timeouts.stop);
    this.closeChannels();
  }
}

module.exports = { Server };
