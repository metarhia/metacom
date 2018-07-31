'use strict';

const url = require('url');
const util = require('util');
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const websocket = require('websocket');

const Server = websocket.server;
const Client = websocket.client;

// WebSocket client wrapper
// - connection - WebSocket connection object (optional)
//
const WsClient = function(connection) {
  if (connection) this.wrapConnection(connection);
};

util.inherits(WsClient, EventEmitter);

// Wrap WebSocket connection object into Net socket interface
// - connection - WebSocket connection object
//
WsClient.prototype.wrapConnection = function(connection) {
  this.connection = connection;

  this.connection.on('message', message => {
    let data = null;

    if (message.type === 'utf8') data = message.utf8Data;
    else if (message.type === 'binary') data = message.binaryData;
    else return;

    this.emit('data', data);
  });

  this.connection.on('close', () => this.emit('close'));
  this.connection.on('error', err => this.emit('error', err));
};

// Connect WebSocket client to WebSocket server
// - port - server port
// - host - server hostname
// - config - WebSocket client config options (optional)
// - callback - on-connect callback (optional)
//
WsClient.prototype.connect = function({ port, host, config }, callback) {
  let protocol = 'ws';

  if (config && config.tlsOptions) {
    protocol = 'wss';
  }

  const client = new Client(config);
  const address = url.format({
    protocol,
    hostname: host,
    port,
    slashes: true
  });

  client.connect(address);

  client.on('connect', connection => {
    this.wrapConnection(connection);
    if (callback) callback();
    this.emit('connect');
  });

  client.on('connectFailed', err => this.emit('error', err));
};

// Write data to WebSocket connection
// - data - data to write
// - callback - on-write callback (optional)
//
WsClient.prototype.write = function(data, callback) {
  this.connection.send(data, callback);
};

// WebSocket server wrapper
// - options - WebSocket https server options (optional)
//
const WsServer = function(options) {
  let server = null;

  if (options) {
    server = https.createServer(options);
  } else {
    server = http.createServer();
  }

  this.httpServer = server;

  this.wsServer = new Server({
    httpServer: this.httpServer,
    autoAcceptConnections: false
  });

  this.wsServer.on('request', request => {
    let connection = request.accept(request.origin);
    connection = new WsClient(connection);
    this.emit('connection', connection);
  });
};

util.inherits(WsServer, EventEmitter);


WsServer.prototype.listen = function(port, host, callback) {
  this.httpServer.listen(port, host, callback);
};

module.exports = {
  WsServer,
  WsClient,
  createWsServer: () => new WsServer(),
  createWssServer: options => new WsServer(options)
};
