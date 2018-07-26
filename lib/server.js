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

const TOKEN_EXPIRATION_TIME = 60 * 60 * 24; // 24 hours
const APP_NOT_FOUND = 'Application not found';

const STATUS = {
  // Server handshake status
  new: 0,
  restore: 1,
  accept: 2,
  reject: 3
};


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

// Metacom wrapper class for TCP and WebSocket connections
//
const ClientConnection = function(
  transport // object, TCP or WebSocket connection socket
) {
  this.transport = transport;
  this.parcelId = 0;
  Connection.call(this);
};

common.inherits(ClientConnection, Connection);

// Methods which are used for client inspection
//
const introspectionMethods = {

  // List server applications
  // - appsIndex - Metacom.Server applications index
  //
  // Returns: object like { <AppName>: <verions>, ... }
  //          where `versions` is an array of strings representing
  //          app versions using semver contract
  //
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

  // List interfaces from application
  // - interfaces - object, application API
  //
  // Returns: object which represents application API schema
  //          {
  //            <interfaceName>: {
  //              methods: [
  //                { name: <methodName>, length: <argumentsCount> },
  //                ...
  //              ],
  //              [description]: <interfaceDescription>
  //            }
  //            ...
  //          }
  //
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
      methods.forEach(name => {
        const fn = interfaces[api][name];
        const description = { name, length: fn.length };
        schema[api].methods.push(description);
      });
    }

    return schema;
  },

  // Select interfaces from application
  // - interfaces - object, application interfaces
  // - interfaceNames - array of strings, interfaces to select
  //
  //
  // Returns: object, definition of selected interfaces
  //          {
  //            <interfaceName>: <mathodNames>
  //            ...
  //          }
  //          where `mathodNames` is an array of names of
  //          interface methods
  //
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

// Process call which was made to introspection interface
// - call - Metacom call object
// - apps - Metacom.Server applications index
//
// Returns: tuple [error, result]
//
const introspection = (call, apps) => {
  const { method } = call;
  const fn = introspectionMethods[method];
  const args = call.args;
  const version = call.appVersion;

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

// Process Metacom call object described in Issue #29
// - applications - Metacom.Server applications index
// - connection - Metacom ClientConnection object
// - callString - Metacom call object stringified with JSON.stringify
//
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

  call.appVersion = call.appVersion || 'latest';

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
    const version = call.appVersion;
    const args = call.args;
    const methodName = call.method;
    const interfaceName = call.apiName;
    const { api } = app.get(version);
    const fn = api[interfaceName][methodName];

    if (!fn) {
      callback.error = `No such method: ${methodName}`;
      sendCallback();
      return;
    }

    fn(connection, ...args, (err, result) => {
      callback.error = err;
      callback.result = result;
      sendCallback();
    });
  }
};

// Process Metacom handshake message
// - stateStorage - Metacom.Server state storage,
//                  Map { token => { timeout, data  }
//
// - connection - Metacom ClientConnection object
// - handshake - Metacom handshake message
//
const onHandshake = (
  stateStorage,
  connection,
  handshake
) => {
  // Prepare handshake response
  //
  const handshakeResponse = { reserved: 0 };

  if (handshake.version !== parser.PROTOCOL_VERSION) {
    // Reject connection if different
    // version of protocol
    handshake.status = STATUS.reject;
    connection.sendHandshake(handshakeResponse);
    return;
  }

  // Set expiration timeout for current token
  //
  const setTokenExpirationTimeout = token => {
    const state = stateStorage.get(token);

    state.timeout = setTimeout(() => {
      stateStorage.delete(token);
    }, TOKEN_EXPIRATION_TIME);
  };

  let status = null;
  let token = null;

  if (handshake.status === STATUS.new) {
    // New connection
    const state = {};
    state.data = {};
    connection.state = state;
    status = STATUS.accept;
    token = common.generateKey(32, common.ALPHA_DIGIT);
  } else if (handshake.status === STATUS.restore) {
    // Restore connection
    token = handshake.token;
    const state = stateStorage.get(token);

    if (state) {
      // Successfully restored connection state
      clearTimeout(state.timeout);
      state.timeout = null;
      connection.state = state.data;
      status = STATUS.accept;
    } else {
      // If state not found reject connection
      status = STATUS.reject;
    }
  } else {
    status = STATUS.reject;
  }

  if (token) {
    connection.on('close', () => {
      setTokenExpirationTimeout(token);
    });
  }

  Object.assign(handshakeResponse, { status, token });
  connection.sendHandshake(handshakeResponse);
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

  this.stateStorage = new Map(); // Map { token => { timeout, data } }

  this.transport.on('error', (err) => {
    this.emit('error', err);
  });

  this.transport.on('close', () => {
    this.emit('close');
  });


  this.transport.on('connection', (conn) => {
    const connection = new ClientConnection(conn);

    connection.on(
      'handshake',
      onHandshake.bind(null, this.stateStorage, connection)
    );

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

// Build index from array of applications
// - apps - array of objects, where each application looks like
//          {
//            name: <AppName>,
//            version: <AppVersion>, (semver)
//            api: {
//              <interfaceName>: {
//                <methodName>: <function>,
//                ...
//                [description]: <interface description>
//              }
//            }
//          }
//
// Returns: applications index build by name and versions
//
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

// Add application to Metacom.Server
// - application - application object
//
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
