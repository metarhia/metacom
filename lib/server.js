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

const introspectionMethods = {
  listApplications: appsIndex => {
    const applications = {};
    const appNames = Array.from(appsIndex.keys());

    appNames.forEach(appName => {
      const app = appsIndex.get(appName);
      const versions = Array.from(app.keys())
        .filter(version => version !== 'latest');
      applications[appName] = versions;
    });

    return applications;
  },

  listInterfaces: interfaces => {
    const schema = {};

    for (const api in interfaces) {
      schema[api] = {};
      schema[api].methods = [];

      const { description } = interfaces[api];

      if (description) {
        schema[api].description = description;
      }


      const methods = Object.keys(interfaces[api]);
      methods.forEach(
        method => schema[api].methods.push(method)
      );
    }

    return schema;
  },

  selectApplication: (interfaces, interfaceNames) => {
    interfaceNames.forEach(name => {
      if (
        !Object.keys(interfaces).includes(name)
      ) {
        const error = `Interface does not exists: ${name}`;
        return [error];
      }
    });

    const definition = {};

    interfaceNames.forEach(api => {
      definition[api] = [];
      const methods = Object.keys(interfaces[api]);
      methods.forEach(
        method => definition[api].push(method)
      );
    });

    return [null, definition];
  }
};

const introspection = (call, apps) => {
  const { method } = call;
  const fn = introspectionMethods[method];
  const [version, ...args] = call.args;

  if (method === 'listApplications') {
    const result = fn(apps);
    return [null, result];
  }

  const app = apps.get(call.appName);
  if (!app) return [APP_NOT_FOUND];

  const interfaces = app.get(version || 'latest').api;

  if (method === 'selectApplication') {
    const interfaceNames = args;
    const [error, result] = fn(interfaces, interfaceNames);
    return [error, result];
  } else if (method === 'listInterfaces') {
    const result = fn(interfaces);
    return [null, result];
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
      chunk.flags = 1;
      connection.sendChunk(chunk);
    });
  };

  if (call.apiName === 'introspection') {
    [callback.error, callback.result] = introspection(call, applications);
    sendCallback();
    return;
  }

  const app = applications.get(call.appName);

  if (!app) {
    callback.error = APP_NOT_FOUND;
    sendCallback();
  } else {
    const [version, ...args] = call.args;
    const methodName = call.method;
    const interfaceName = call.apiName;
    const { api } = app.get(version);
    const fn = api[interfaceName][methodName];

    if (!fn) {
      callback.error = `No such method: ${methodName}`;
      sendCallback();
      return;
    }

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
  this.active = false;
  this.connections = [];
  const transport = options.transport; // ws, wss, tcp, tls
  const transportFactory = transports[transport];
  this.transport = transportFactory(options);

  const apps = options.applications;
  this.applications = this.buildApplicationsIndex(apps);

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
      onCall.bind(null, this.applications, connection)
    );

    this.connections.push(connection);
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

Server.prototype.buildApplicationsIndex = apps => {
  const index = new Map();

  apps.forEach(app => {
    const { name, version } = app;
    const versions = new Map([[version, app]]);
    versions.set('latest', app);
    index.set(name, versions);
  });

  return index;
};

Server.prototype.addApplication = application => {
  const { name, version } = application;

  if (this.applications.has(name)) {
    const message = 'Application already exists';
    throw new Error(message);
  }

  const versions = new Map([[version, application]]);
  versions.set('latest', application);
  this.applications.set(name, application);
};

module.exports = Server;
