'use strict';

const common = require('metarhia-common');
const { EventEmitter } = require('events');

const parser = require('./parser.js');

const Connection = function(transport) {
  EventEmitter.call(this);

  this._transport = transport;
  this._parcels = [];
  this._chunks = [];

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
  this.once('structure', this._onHandshake);
};

common.inherits(Connection, EventEmitter);

// Mechanism for collecting data,
// cut by lower-level protocols
Connection.prototype._onRawData = function(data) {
  if (data.length < this._bytesToRead) {
    this._bytesToRead -= data.length;
    this._data = Buffer.concat([this._data, data]);
  } else {
    const newDataChunk = data.slice(0, this._bytesToRead);
    this._data = Buffer.concat([this._data, newDataChunk]);
    data = data.slice(this._bytesToRead);

    // Chunk structure header
    if (this._data.readUInt8() === 1 && this._data.length === 12) {
      const length = this._data.readUInt16LE(10); // payload length
      this._bytesToRead = length;
    } else {
      this.emit('structure', this._data);
      this._data = Buffer.alloc(0);
      this._bytesToRead = data.length ?       // data.length === 0 ->
        data.readUInt8() === 0 ? 16 : 12 : 0; // _bytesToRead = 0, else 16 or 12
    }

    if (data.length > 0) this._onRawData(data);
  }
};

Connection.prototype.sendHandshake = function(handshake) {
  const buffer = parser.handshake(handshake);
  this._send(buffer);
};

Connection.prototype.sendParcel = function(parcel, callback) {
  const buffer = parser.parcel(parcel);
  this._send(buffer, callback);
};

Connection.prototype.sendChunk = function(chunk, encoding, callback) {
  const buffer = parser.chunk(chunk);
  this._send(buffer, encoding, callback);
};

Connection.prototype._send = function(data, encoding, callback) {
  this.transport.write(data, encoding, callback);
};

Connection.prototype._onHandshake = function(buffer) {
  const handshake = parser.readHandshake(buffer);
  this.emit('handshake', handshake);
  this.on('structure', (buffer) => {
    const struct = parser.readStruct(buffer);
    if (struct.structType === 'parcel') this._onParcel(struct);
    else if (struct.structType === 'chunk') this._onChunk(struct);
  });
};

Connection.prototype._onParcel = function(parcel) {
  const chunks = this._chunks.filter(
    chunk => chunk.parcelId === parcel.parcelId
  );
  const currentLength = chunks.reduce((acc, cur) => acc += cur.length, 0);
  Object.assign(parcel, { chunks, currentLength });

  if (currentLength === parcel.length) {
    this._emitStructure(parcel);
  } else {
    this._parcels.push(parcel);
  }
};

Connection.prototype._onChunk = function(chunk) {
  const parcel = this._parcels.find(
    parcel => parcel.parcelId === chunk.parcelId
  );

  if (parcel) {
    parcel.chunks.push(chunk);
    parcel.currentLength += chunk.length;

    if (parcel.currentLength === parcel.length) {
      this._emitStructure(parcel);
    }
  } else {
    this._chunks.push(chunk);
  }
};

Connection.prototype._emitStructure = function(parcel) {
  parcel.chunks.sort((cur, next) => cur.id - next.id);
  const payload = parcel.chunks.reduce((acc, cur) => acc += cur.payload, '');
  this.emit(parcel.parcelType, payload);
};

module.exports = Connection;
