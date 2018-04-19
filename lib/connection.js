'use strict';

const common = require('./metarhia-common');
const EventEmitter = require('events');

const Connection = function() {
  EventEmitter.call(this);
};

common.inherits(Connection, EventEmitter);

module.exports = Connection;
