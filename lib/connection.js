'use strict';

const common = require('metarhia-common');
const EventEmitter = require('events');

const parser = require('./parser.js');

const Connection = function() {
  EventEmitter.call(this);

  this.parcels = [];
  this.chunks = [];

  // Buffer for collecting full data,
  // cut by lower-level protocols
  this.buffer = Buffer.alloc(0);
  this.bytesToRead = parser.HANDSHAKE_LENGTH;

  this.transport.on('data', (data) => {
    if (this.bytesToRead === 0) {
      const structType = data.readUInt8();
      this.bytesToRead = structType === 0 ?
        parser.PARCEL_LENGTH : parser.CHUNK_LENGTH;
    }
    this._onRawData(data);
  });

  // Process handshake as a first structure
  this.once('structure', this._onHandshake);
};

common.inherits(Connection, EventEmitter);

Connection.prototype._onRawData = function(data) {
  if (data.length < this.bytesToRead) {
    this.bytesToRead -= data.length;
    this.buffer = Buffer.concat([this.buffer, data]);
  } else {
    const newDataChunk = data.slice(0, this.bytesToRead);
    this.buffer = Buffer.concat([this.buffer, newDataChunk]);
    data = data.slice(this.bytesToRead);

    if (
      // Chunk structure header
      this.buffer.readUInt8() === 1 &&
      this.buffer.length === parser.CHUNK_LENGTH
    ) {
      const length = parser.readPayloadLength(this.buffer);
      this.bytesToRead = length;
    } else {
      this.emit('structure', this.buffer);
      this.buffer = Buffer.alloc(0);
      // if more data, read struct type from it
      // and set appropriate value to bytesToRead
      // or set bytesToRead equal to 0
      this.bytesToRead = data.length ? data.readUInt8() === 0 ?
        parser.PARCEL_LENGTH : parser.CHUNK_LENGTH : 0;
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
  const chunks = this.chunks.filter(
    chunk => chunk.parcelId === parcel.parcelId
  );
  const currentLength = chunks.reduce((acc, cur) => acc += cur.length, 0);
  Object.assign(parcel, { chunks, currentLength });

  if (currentLength === parcel.length) {
    this._emitParcelType(parcel);
  } else {
    this.parcels.push(parcel);
  }
};

Connection.prototype._onChunk = function(chunk) {
  const parcel = this.parcels.find(
    parcel => parcel.parcelId === chunk.parcelId
  );

  if (parcel) {
    parcel.chunks.push(chunk);
    parcel.currentLength += chunk.length;

    if (parcel.currentLength === parcel.length) {
      this._emitParcelType(parcel);
    }
  } else {
    this.chunks.push(chunk);
  }
};

Connection.prototype._emitParcelType = function(parcel) {
  parcel.chunks.sort((cur, next) => cur.id - next.id);
  const payload = parcel.chunks.reduce((acc, cur) => acc += cur.payload, '');
  this.emit(parcel.parcelType, payload);
};

module.exports = Connection;
