'use strict';

const http = require('http');
const { Channel } = require('./channel.js');

class WsChannel extends Channel {
  constructor(application, req, connection) {
    super(application, req);
    this.connection = connection;
    connection.on('message', (data, isBinary) => {
      if (isBinary) this.binary(data);
      else this.message(data.toString());
    });
    connection.on('close', () => {
      this.destroy();
    });
  }

  write(data) {
    this.connection.send(data);
  }

  send(obj) {
    this.write(JSON.stringify(obj));
  }

  error(code, err = null, callId) {
    const { req, ip, application } = this;
    const { url, method } = req;
    const status = http.STATUS_CODES[code];
    const reason = err ? err.stack : status;
    application.console.error(`${ip}\t${method}\t${url}\t${code}\t${reason}`);
    const message = err ? err.message : code.toString();
    this.send({ callback: callId, error: { message, code } });
  }
}

const createChannel = (application, req, connection) =>
  new WsChannel(application, req, connection);

module.exports = { createChannel };
