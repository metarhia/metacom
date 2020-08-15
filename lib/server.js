'use strict';

const WebSocket = require('ws');

const upgradeServer = server => {
  console.log(server instanceof WebSocket);
};

module.exports = { upgradeServer };
