'use strict';

const common = require('metarhia-common');
const EventEmitter = require('events');

const parser = require('./parser.js');

const Connection = function(transport) {
  EventEmitter.call(this);
  this.transport = transport;
  this.transport.once('data', this._onHandshake);
};

common.inherits(Connection, EventEmitter);

Connection.prototype.send = function(data, encoding, callback) {
  this.transport.write(data, encoding, callback);
};

Connection.prototype._onHandshake = function(buffer) {
  const handshakeMessage = parser.handshake(buffer);
  this.emit('handshake', handshakeMessage);
  this.on('data', this._onStructure);
};

Connection.prototype._onStructure = function(buffer) {
  const struct = parser.structure(buffer);
  this.emit(struct.structType, struct);
};

module.exports = Connection;
