'use strict';

const { Channel } = require('./channel.js');

class WsChannel extends Channel {
  constructor(server, req, connection) {
    super(server, req);
    this.connection = connection;
    connection.on('message', (data, isBinary) => {
      if (isBinary) this.binary(data);
      else this.message(data);
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

  sendSessionCookie(token) {
    this.console.error(`Can not send cookie for ${token} over websocket`);
  }

  removeSessionCookie() {
    this.console.error(`Can not remove cookie; it is websocket connection`);
  }
}

const createChannel = (server, req, connection) =>
  new WsChannel(server, req, connection);

module.exports = { createChannel };
