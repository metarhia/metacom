'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
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
  const transport = options.transport; // ws, wss, tcp, tls
  const Transport = transports[transport];
  this.transport = new Transport(options);
  this.transport.on('error', err => this.emit('error', err));
  this.transport.on('close', () => {});
  this.transport.on('connect', () => {});
};

// Events: open, close, error, stream

common.inherits(Client, Connection);

Client.prototype.connect = function(port, host, callback) {
  this.transport.connect(port, host, () => {
    this.active = true;
    if (callback) callback();
  });
};

Client.prototype.close = function() {
};

Client.prototype.write = function(data, encoding, callback) {
  this.transport.write(data, encoding, callback);
};

Client.prototype.end = function(data, encoding) {
  this.transport.end(data, encoding);
};

const connect = options => new Client(options);

module.exports = connect;
