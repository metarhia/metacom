'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
const parser = require('./parser');
const { URL } = require('url');
const net = require('net');
const tls = require('tls');
const websocket = require('websocket');

const ALL_INTERFACE_NAMES = '*';
const DEFAULT_VERSION = 'latest';
const INSPECTION_INTERFACE = 'inspection';
const HANDSHAKE_STATUS = {
  connect: 0,
  restore: 1,
  accept: 2,
  reject: 3
};
const FLAGS = {
  more: 1,
  stop: 2,
  pause: 4,
  resume: 8
};

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
  this.host = options.host;
  this.port = options.port;
  this.parcelId = 0;
  const transport = options.transport; // ws, wss, tcp, tls

  if (!transport) {
    throw new Error('Transport is required');
  }

  const Transport = transports[transport];
  this.transport = new Transport();
  Connection.call(this);

  this.transport.on('error', (err) => {
    this.emit('error', err);
  });
  this.transport.on('close', () => {
    this.active = false;
    this.emit('close');
  });
  this.connect();
};

common.inherits(Client, Connection);

Client.prototype.connect = function(callback) {
  this.transport.connect(this.port, this.host, () => {
    const handshake = {
      status: HANDSHAKE_STATUS.connect,
      reserved: 0,
    };

    const onHandshake = handshakeMessage => {
      if (handshakeMessage.status === HANDSHAKE_STATUS.accept) {
        this.active = true;
        this.token = handshakeMessage.token;
        if (callback) callback();
        this.emit('connect');
      }
    };

    this.sendHandshake(handshake);
    this.once('handshake', onHandshake);
  });
};

Client.prototype.close = function() {
  if (this.active) this.end();
};

Client.prototype.end = function(data, encoding) {
  if (this.active) this.transport.end(data, encoding);
};

Client.prototype.listApplications = function(callback) {
  this.rpcCall(
    null,
    DEFAULT_VERSION,
    INSPECTION_INTERFACE,
    'listApplications',
    callback
  );
};

Client.prototype.listInterfaces = function(
  application,
  version,
  callback
) {
  if (typeof application === 'function') {
    callback = application;
    application = this.application;
    version = this.version || DEFAULT_VERSION;
  } else if (typeof version === 'function') {
    callback = version;
    version = this.version || DEFAULT_VERSION;
  }

  this.rpcCall(
    application,
    version,
    INSPECTION_INTERFACE,
    'listInterfaces',
    callback
  );
};

Client.prototype.selectApplication = function(
  application, interfaceNames, version, callback
) {
  if (typeof interfaceNames === 'function') {
    callback = interfaceNames;
    interfaceNames = [ALL_INTERFACE_NAMES];
    version = DEFAULT_VERSION;
  } else if (typeof version === 'function') {
    callback = version;
    version = DEFAULT_VERSION;
  }

  this.rpcCall(
    application,
    version,
    INSPECTION_INTERFACE,
    'selectApplication',
    ...interfaceNames,
    (error, app) => {
      if (error) {
        callback(error);
        return;
      }

      const remoteProxy = (interfaceName, methodNames) => {
        const api = {};

        methodNames.forEach(methodName => {
          api[methodName] = (...args) => {
            this.rpcCall(
              application,
              version,
              interfaceName,
              methodName,
              ...args
            );
          };
        });

        return api;
      };

      for (const interfaceName in app) {
        app[interfaceName] = remoteProxy(interfaceName, app[interfaceName]);
      }

      this.application = application;
      this.version = version;
      callback(null, app);
    }
  );
};

Client.prototype.rpcCall = function(
  application, version, interfaceName, methodName, ...args
) {
  if (this.active) {
    const callback = common.safeCallback(args);
    const key = common.generateKey(8, common.ALPHA_DIGIT);
    const call = {
      application,
      version,
      interfaceName,
      methodName,
      args,
      key
    };
    const payload = JSON.stringify(call);
    const parcel = {
      parcelId: this.parcelId,
      parcelType: parser.PARCEL_CALL,
      compression: 0,
      length: payload.length.toString()
    };
    const chunks = parser.partPayload(payload);

    const onCallback = data => {
      data = JSON.parse(data);
      if (data.key !== key) return;
      this.removeListener('callback', onCallback);
      callback(data.error, data.result);
    };

    this.sendParcel(parcel);

    chunks.forEach(chunk => {
      chunk.parcelId = this.parcelId;
      chunk.flag = FLAGS.more;
      this.sendChunk(chunk);
    });

    this.parcelId++;
    this.on('callback', onCallback);
  }
};

const connect = url => {
  const { protocol, hostname, port } = new URL(url);
  const transport = protocol.slice(0, -1);
  const client = new Client({ transport, host: hostname, port });
  return client;
};

module.exports = connect;
