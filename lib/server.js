'use strict';

const http = require('http');
const https = require('https');
const worker = require('worker_threads');

const metautil = require('metautil');
const { Semaphore } = metautil;
const ws = require('ws');

const { Channel, channels } = require('./channel.js');

const SHUTDOWN_TIMEOUT = 5000;
const SHORT_TIMEOUT = 500;
const LONG_RESPONSE = 30000;

const receiveBody = async (req) => {
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString();
};

class Server {
  constructor(config, application) {
    this.config = config;
    this.application = application;
    const { host, balancer, protocol, ports, concurrency, queue } = config;
    this.semaphore = new Semaphore(concurrency, queue.size, queue.timeout);
    const { threadId } = worker;
    this.balancer = balancer && threadId === 1;
    const skipBalancer = balancer ? 1 : 0;
    this.port = this.balancer ? balancer : ports[threadId - skipBalancer - 1];
    const transport = protocol === 'http' || this.balancer ? http : https;
    const listener = this.listener.bind(this);
    this.server = transport.createServer({ ...application.cert }, listener);
    this.ws = new ws.Server({ server: this.server });
    this.ws.on('connection', async (connection, req) => {
      const channel = await new Channel(req, null, connection, application);
      connection.on('message', (data) => {
        channel.message(data);
      });
      connection.on('close', () => {
        channels.delete(channel.client);
        channel.destroy();
      });
    });
    this.protocol = protocol;
    this.host = host;
    this.server.listen(this.port, host);
  }

  async listener(req, res) {
    let finished = false;
    const { url } = req;
    const channel = await new Channel(req, res, null, this.application);
    const { client } = channel;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      channels.delete(client);
      channel.error(504);
      channel.destroy();
    }, LONG_RESPONSE);

    res.on('close', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channels.delete(client);
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
    else channel.static();
  }

  request(channel) {
    const { req } = channel;
    if (req.method === 'OPTIONS') {
      channel.options();
      return;
    }
    if (req.method !== 'POST') {
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
        const { pathname, searchParams } = new URL('http://' + req.url);
        const [, interfaceName, methodName] = pathname.split('/');
        const args = data ? JSON.parse(data) : Object.fromEntries(searchParams);
        channel.rpc(-1, interfaceName, methodName, args);
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
    await metautil.delay(SHUTDOWN_TIMEOUT);
    this.closeChannels();
  }
}

module.exports = { Server };
