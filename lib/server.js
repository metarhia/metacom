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
const parser = require('./parser.js');

const APP_NOT_FOUND = 'Application not found';

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

const ClientConnection = function(
  transport
) {
  this.transport = transport;
  this.parcelId = 0;
  Connection.call(this);
};

common.inherits(ClientConnection, Connection);

const reservedMethods = {
  listApi: app => {
    // Build App API schema:
    // {
    //   interfaceName: [...methodNames]
    //   ...
    // }
    //
    const schema = {};
    for (const api in app) {
      schema[api] = [];
      app[api].forEach(
        method => schema[api].push(method)
      );
    }
    return schema;
  },

  selectApi: (app, apiNames) => {
    // Build selective API schema
    const schema = {};
    apiNames.forEach(api => {
      schema[api] = [];
      app[api].forEach(
        method => schema[api].push(method)
      );
    });
    return schema;
  }
};

const onCall = (
  applications,
  connection,
  callString
) => {
  const call = JSON.parse(callString);
  const key = call.key;
  const callback = { key, error: null, result: null };

  const parcel = {
    parcelId: connection.parcelId,
    parcelType: parser.PARCEL_CALLBACK,
    compression: 0,
  };

  const sendCallback = () => {
    const payload = JSON.stringify(callback);
    const chunks = parser.partPayload(payload);
    parcel.length = payload.length.toString();
    connection.sendParcel(parcel);
    chunks.forEach(chunk => {
      chunk.parcelId = this.parcelId;
      chunk.flag = 1;
      connection.sendChunk(chunk);
    });
  };

  const app = applications.find(
    app => app.name === call.appName
  );

  if (!app) {
    callback.error = APP_NOT_FOUND;
    sendCallback();
  } else if (!call.apiName) {
    const fn = reservedMethods[call.method];
    callback.result = fn(app.api, ...call.args);
    sendCallback();
  } else {
    const api = call.apiName;
    const method = call.method;
    const args = call.args;
    const fn = app.api[api][method];
    fn(...args, (err, result) => {
      callback.error = err;
      callback.result = result;
      sendCallback();
    });
  }
};

const Server = function(
  // Metacom server
  options // Object, transport options
) {
  EventEmitter.call(this);
  this.applications = options.applications;
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
    connection = new ClientConnection(connection);

    connection.on(
      'call',
      onCall.bind(this.applications, connection)
    );

    this.emit('connection', connection);
  });
};

common.inherits(Server, EventEmitter);

// Events: connection, close, error, listening

Server.prototype.listen = function(
  port,
  host = 'localhost',
  callback
) {
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
  this.transport.close();
};

Server.prototype.getConnections = function(callback) {
  if (callback) callback(this.connections);
};


module.exports = Server;
