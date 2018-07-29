'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
const parser = require('./parser');
const url = require('url');
const net = require('net');
const tls = require('tls');
const websocket = require('websocket');

const ALL_INTERFACE_NAMES = '*';
const DEFAULT_VERSION = 'latest';
const INSPECTION_INTERFACE = 'inspection';

const STATUS = {
  new: 0,
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
  options // Client connect options
) {
  const { transport, path, port, host } = options;
  this.active = false;
  this.transportType = transport; // ws, wss, tcp, tls
  this.options = path ? [path] : [port, host];
  this.parcelId = 0;

  if (!this.transportType) {
    throw new Error('Transport is required');
  }

  const Transport = transports[this.transportType];
  this.transport = new Transport();
  Connection.call(this);

  this.transport.on('error', err => {
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
  this.transport.connect(...this.options, () => {
    const handshake = {
      status: STATUS.new,
      reserved: 0,
    };

    const onHandshake = ({ status, token }) => {
      if (status === STATUS.accept) {
        this.active = true;
        this.token = token;
        if (callback) callback();
        this.emit('connect');
      } else if (status === STATUS.reject) {
        this.emit('error', new Error('Fail to connect'));
      }
    };

    this.sendHandshake(handshake);
    this.once('handshake', onHandshake);
  });
};

Client.prototype.restore = function(callback) {
  const Transport = transports[this.transportType];
  this.transport = new Transport();

  this.transport.connect(...this.options, () => {
    const handshake = {
      status: STATUS.restore,
      reserved: 0,
      token: this.token
    };

    const onHandshake = ({ status }) => {
      if (status === STATUS.accept) {
        this.active = true;
        if (callback) callback();
        this.emit('restore');
      } else if (status === STATUS.reject) {
        this.emit('error', new Error('Fail to restore connection'));
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
  application,
  interfaceNames,
  version,
  callback
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
  application,
  version,
  interfaceName,
  methodName,
  ...args
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

const connect = address => {
  const { protocol, hostname, port, path } = url.parse(address);
  const transport = protocol ? protocol.slice(0, -1) : 'tcp';
  const options = { transport, host: hostname, port, path };
  const client = new Client(options);

  return client;
};

module.exports = connect;
