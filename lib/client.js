'use strict';

const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const websocket = require('websocket');

const common = require('metarhia-common');
const Connection = require('./connection');

const PARCEL_TYPE = {
  ping: 0,
  pong: 1,
  call: 2,
  callback: 3,
  event: 4,
  stream: 5
};

const transports = {
  ws: websocket.client,
  wss: websocket.client,
  tcp: net.Socket,
  tls: tls.Socket
};

class Client extends Connection {
  constructor(options) {
    super();
    this.active = false;
    this.host = options.host;
    this.port = options.port;
    this.parcelId = 0;
    const transport = options.transport; // ws, wss, tcp, tls

    if (!transport) {
      throw new Error('Transport is required');
    }

    const Transport = transports[transport];
    this.transport = new Transport({ host: this.host, port: this.port });
    Connection.call(this);

    this.transport.on('error', (err) => {
      this.emit('error', err);
    });
    this.transport.on('close', () => {
      this.active = false;
      this.emit('close');
    });
    this.connect();
  }

  connect(callback) {
    this.transport.connect(this.port, this.host, () => {
      const handshake = {
        status: 0,
        reserved: null,
        token: null
      };

      const onHandshake = (handshakeMessage) => {
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
  }

  close() {
    if (this.active) this.end();
  }

  end(data, encoding) {
    if (this.active) this.transport.end(data, encoding);
  }

  listApplications(callback) {
    this.rpcCall(null, null, 'listApplications', callback);
  }

  selectApi(appName, apiName, apiVersion, callback) {
    this.rpcCall(null, null, 'selectApi', appName, apiName,
      (error, methods) => {
        const api = {};

        methods.forEach((method) => {
          api[method] = (...args) => {
            this.rpcCall(appName, apiName, method, args);
          };
        });

        callback(error, api);
      }
    );
  }

  rpcCall(appName, apiName, method, ...args) {
    if (this.active) {
      const callback = common.safeCallback(args);
      const payload = { appName, apiName, method, args };
      const parcel = {
        parcelId: this.parcelId,
        parcelType: PARCEL_TYPE.call,
      };
      const chunk = {
        parcelId: this.parcelId++,
        payload
      };

      const onCallback = ({ error, result }) => {
        this.removeListener('callback', onCallback);
        callback(error, result);
      };

      this.sendParcel(parcel);
      this.sendChunk(chunk);
      this.on('callback', onCallback);
    }
  }
}

const connect = url => {
  const { protocol, hostname, port, pathname } = new URL(url);
  const transport = protocol.slice(0, -1);
  const application = pathname.substring(1);
  const client = new Client({ transport, host: hostname, port, application });
  return client;
};

module.exports = connect;
