'use strict';

const common = require('metarhia-common');
const Connection = require('./connection');
const parser = require('./parser');
const { URL } = require('url');
const net = require('net');
const tls = require('tls');
const websocket = require('websocket');

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
  this.application = options.application;
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
      status: 0,
      reserved: null,
      token: null
    };

    const onHandshake = handshakeMessage => {
      if (handshakeMessage.status === 2) {
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

Client.prototype.listApi = function(callback) {
  this.rpcCall(null, 'listApi', this.application, callback);
};

Client.prototype.selectApi = function(
  apiNames, callback
) {
  this.rpcCall(
    null,
    'selectApi',
    apiNames,
    (error, app) => {
      if (error) {
        callback(error);
        return;
      }

      const remoteProxy = (apiName, methods) => {
        const api = {};

        methods.forEach(method => {
          api[method] = (...args) => {
            this.rpcCall(apiName, method, ...args);
          };
        });

        return api;
      };

      for (const apiName in app) {
        app[apiName] = remoteProxy(apiName, app[apiName]);
      }

      callback(null, app);
    }
  );
};

Client.prototype.rpcCall = function(
  apiName, method, ...args
) {
  if (this.active) {
    const callback = common.safeCallback(args);
    const key = common.generateKey(8, common.ALPHA_DIGIT);
    const call = { appName: this.application, apiName, method, args, key };
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
  const { protocol, hostname, port, pathname } = new URL(url);
  const transport = protocol.slice(0, -1);
  const application = pathname.substring(1);
  const client = new Client({ transport, host: hostname, port, application });
  return client;
};

module.exports = connect;
