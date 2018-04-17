'use strict';

const common = require('./metarhia-common');
const Connection = require('./connection');

const Client = function(url) {
  // Client class for client process
  this.url = url;
};

common.inherits(Client, Connection);

const connect = (url) => new Client(url);

module.exports = connect;
