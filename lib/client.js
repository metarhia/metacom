'use strict';

const WebSocket = require('ws');

class Client {
  constructor(host) {
    this.socket = new WebSocket('wss://' + host);
  }
}

module.exports = { Client };
