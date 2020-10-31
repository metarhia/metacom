'use strict';

const { Server } = require('./lib/server.js');
const client = require('./lib/client.js');

module.exports = client;
module.exports.Server = Server;
