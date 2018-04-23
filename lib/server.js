'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const websocket = require('websocket');
const WsServer = websocket.server;

const transports = {
  ws: options => new WsServer({
    httpServer: http.createServer(options),
    autoAcceptConnections: false
  }),
  wss: options => new WsServer({
    httpServer: https.createServer(options),
    autoAcceptConnections: false
  }),
  tcp: options => net.createServer(options),
  tls: options => tls.createServer(options)
};

const Server = function(
  // Metacom server
  options // Object, transport options
) {
  EventEmitter.call(this);
  this.connections = [];
  this.active = false;
  const transport = options.transport; // ws, wss, tcp, tls
  const transportFactory = transports[transport];
  this.transport = transportFactory(options);
  this.transport.on('error', (err) => {
    this.emit('error', err);
  });
  this.transport.on('close', () => {
    this.emit('close');
  });
  this.transport.on('connection', (connection) => {
    this.emit('connection', connection);
  });
};

common.inherits(Server, EventEmitter);

// Events: connection, close, error, listening

Server.prototype.listen = function(port, host = 'localhost', callback) {
  this.port = port;
  this.host = host;
  this.transport.listen(port, host, () => {
    this.active = true;
    if (callback) callback();
    this.emit('listening');
  });
};

Server.prototype.close = function(callback) {
  if (callback) callback();
};

Server.prototype.getConnections = function(callback) {
  if (callback) callback(this.connections);
};

const ClientConnection = function(
  // Client class for server process
) {
  Connection.call(this);
};

common.inherits(ClientConnection, Connection);

module.exports = Server;
