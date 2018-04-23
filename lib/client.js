'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
const { URL } = require('url');
const net = require('net');
const tls = require('tls');
const websocket = require('websocket');

const transports = {
  ws: websocket.client,
  wss: websocket.client,
  tcp: net.Socket,
  tls: tls.Socket
};

const Client = function(
  // Metacom client
  options // Object, client options
) {
  // Client class for client process
  this.active = false;
  this.transport = options.transport;
  this.host = options.host;
  this.port = options.port;
  this.application = options.application;
  const transport = options.transport; // ws, wss, tcp, tls
  const Transport = transports[transport];
  this.transport = new Transport({ host: this.host, port: this.port });
  this.transport.on('error', (err) => {
    this.emit('error', err);
  });
  this.transport.on('close', () => {
    this.active = false;
    this.emit('close');
  });
  this.connect();
};

// Events: connect, close, error, stream

common.inherits(Client, Connection);

Client.prototype.connect = function(callback) {
  this.transport.connect(this.port, this.host, () => {
    this.active = true;
    if (callback) callback();
    this.emit('connect');
  });
};

Client.prototype.close = function() {
  if (this.active) this.end();
};

Client.prototype.write = function(data, encoding, callback) {
  if (this.active) this.transport.write(data, encoding, callback);
};

Client.prototype.end = function(data, encoding) {
  if (this.active) this.transport.end(data, encoding);
};

Client.prototype.rpcCall = function(...args) {
  if (this.active) {
    const callback = common.safeCallback(args);
    // Implement RPC call here
    callback(args);
  }
};

const connect = url => {
  const { protocol, hostname, port, pathname } = new URL(url);
  const transport = protocol.slice(0, -1);
  const application = pathname.substring(1);
  const client = new Client({ transport, host: hostname, port, application });
  const proxy = new Proxy(client, {
    get(target, name) {
      return target[name] || target.rpcCall.bind(target, name);
    }
  });
  console.dir({ client, proxy });
  return client; // return proxy instead of client;
};

module.exports = connect;
