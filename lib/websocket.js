'use strict';

const url = require('url');
const http = require('http');
const https = require('https');
const websocket = require('websocket');
const EventEmitter = require('events');
const util = require('util');

const Server = websocket.server;
const Client = websocket.client;

const WsClient = function(connection) {
  if (connection) this.wrapConnection(connection);
};

util.inherits(WsClient, EventEmitter);

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

WsClient.prototype.connect = function(port, hostname, options, callback) {
  let protocol = 'ws';

  if (typeof options === 'function') {
    callback = options;
    options = null;
  } else if (options && options.tlsOptions) {
    protocol = 'wss';
  }

  const client = new Client(options);
  const address = url.format({
    protocol,
    hostname,
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

WsClient.prototype.write = function(data, encoding, callback) {
  this.connection.send(data, callback);
};

const WsServer = function(options, secure = false) {
  let server = null;

  if (secure) {
    server = new https.Server(options);
  } else {
    server = new http.Server(options);
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
  createWsServer: options => new WsServer(options),
  createWssServer: options => new WsServer(options, true)
};
