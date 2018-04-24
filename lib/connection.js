'use strict';

const common = require('metarhia-common');
const { EventEmitter } = require('events');

const parser = require('./parser.js');

const Connection = function(transport) {
  EventEmitter.call(this);

  this._transport = transport;

  // Mechanism for collecting full data,
  // cut by lower-level protocols
  this._bytesToRead = 36;
  this._data = Buffer.alloc(0);

  this._transport.on('data', (data) => {
    if (this._bytesToRead === 0) {
      const structType = data.readUInt8();
      this._bytesToRead = structType === 0 ? 16 : 12;
    }
    this._onRawData(data);
  });

  // Process handshake as a first structure
  this.once('data', this._onHandshake);
};

common.inherits(Connection, EventEmitter);

Connection.prototype.sendHandshake = function(handshake) {
  const buffer = parser.handshake(handshake);
  this._send(buffer);
};

Connection.prototype.sendParcel = function(parcel, encoding, callback) {
  const buffer = parser.parcel(parcel);
  this._send(buffer, encoding, callback);
};

Connection.prototype.sendChunk = function(chunk, encoding, callback) {
  const buffer = parser.chunk(chunk);
  this._send(buffer, encoding, callback);
};

Connection.prototype._send = function(data, encoding, callback) {
  this.transport.write(data, encoding, callback);
};

// Mechanism for collecting data,
// cut by lower-level protocols
Connection.prototype._onRawData = function(data) {
  if (data.length < this._bytesToRead) {
    this._bytesToRead -= data.length;
    this._data = Buffer.concat([this._data, data]);
  } else {
    const newChunk = data.slice(0, this._bytesToRead);
    this._data = Buffer.concat([this._data, newChunk]);
    this.emit('data', this._data);

    data = data.slice(this._bytesToRead);
    this._data = Buffer.alloc(0);
    this._bytesToRead = 0;

    if (data.length > 0) {
      const structType = data.readUInt8();
      this._bytesToRead = structType === 0 ? 16 : 12;
      this._onRawData(data);
    }
  }
};

Connection.prototype._onHandshake = function(buffer) {
  const handshake = parser.readHandshake(buffer);
  this.emit('handshake', handshake);
  this.on('data', this._onStructure);
};

Connection.prototype._onStructure = function(buffer) {
  const struct = parser.readStruct(buffer);
  this.emit(struct.structType, struct);
};

module.exports = Connection;
