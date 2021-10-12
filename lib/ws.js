'use strict';

const { Channel } = require('./channel.js');

class WsChannel extends Channel {
  constructor(application, req, connection) {
    super(application, req);
    this.connection = connection;
    connection.on('message', (data) => {
      this.message(data);
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
}

const createChannel = (application, req, connection) =>
  new WsChannel(application, req, connection);

module.exports = { createChannel };
