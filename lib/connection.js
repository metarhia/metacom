'use strict';

const common = require('metarhia-common');
const EventEmitter = require('events');

const parser = require('./parser.js');

const BUFFER_BEGIN = 0;
const INITIAL_BUFFER_SIZE = 16384;

const encoding = {
  binary: 0,
  jstp: 1,
  json: 2,
  bson: 3,
  v8: 4
};

const Connection = function() {
  EventEmitter.call(this);
  this.encoding = encoding.binary;

  this.parcels = new Map();
  this.chunks = new Map();

  // Buffer for collecting full data,
  // cut by lower-level protocols
  this.position = BUFFER_BEGIN;
  this.buffer = Buffer.alloc(INITIAL_BUFFER_SIZE);
  this.bytesToRead = parser.HANDSHAKE_LENGTH;

  this.transport.on('data', (data) => {
    if (this.bytesToRead === 0) {
      const structType = parser.readStructType(data);
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
    this.position += data.copy(this.buffer, this.position);
  } else {
    this.position += data.copy(
      this.buffer, this.position, 0, this.bytesToRead
    );
    const structType = parser.readStructType(this.buffer);

    data = data.slice(this.bytesToRead);

    if (
      // Chunk structure header
      structType === 1 &&
      this.buffer.length === parser.CHUNK_LENGTH
    ) {
      const length = parser.readPayloadLength(this.buffer);
      this.bytesToRead = length;
    } else {
      this.emit('structure', this.buffer);
      this.position = BUFFER_BEGIN;
      // if more data, read struct type from it
      // and set appropriate value to bytesToRead
      // or set bytesToRead equal to 0
      this.bytesToRead = data.length ? parser.readStructType(data) === 0 ?
        parser.PARCEL_LENGTH : parser.CHUNK_LENGTH : 0;
    }

    if (data.length > 0) this._onRawData(data);
  }
};

Connection.prototype.setEncoding = function(enc) {
  this.encoding = encoding[enc];
};

Connection.prototype.sendHandshake = function(handshake) {
  const buffer = parser.handshake(handshake);
  this.send(buffer);
};

Connection.prototype.sendParcel = function(parcel, callback) {
  const buffer = parser.parcel(parcel, this.encoding);
  this.send(buffer, callback);
};

Connection.prototype.sendChunk = function(chunk, callback) {
  const buffer = parser.chunk(chunk, this.encoding);
  this.send(buffer, this.encoding, callback);
};

Connection.prototype.send = function(data, callback) {
  this.transport.write(data, callback);
};

Connection.prototype._onHandshake = function(buffer) {
  const handshake = parser.readHandshake(buffer);
  this.emit('handshake', handshake);
  this.on('structure', (buffer) => {
    const struct = parser.readStruct(buffer);
    if (struct.structType === parser.STRUCT_PARCEL) this._onParcel(struct);
    else if (struct.structType === parser.STRUCT_CHUNK) this._onChunk(struct);
  });
};

Connection.prototype._onParcel = function(parcel) {
  if (parcel.parcelType === parser.PARCEL_STREAM) {
    this._emitParcelType(parcel);
  }

  const chunks = this.chunks.get(parcel.parcelId);
  if (!chunks) return;

  const currentLength = chunks.reduce((acc, cur) => acc += cur.length, 0);
  Object.assign(parcel, { chunks, currentLength });

  if (currentLength === parcel.length) {
    this._emitParcelType(parcel);
  } else {
    this.parcels.set(parcel.parcelId, parcel);
  }
};

Connection.prototype._onChunk = function(chunk) {
  const parcel = this.parcels.get(chunk.parcelId);

  if (parcel) {
    parcel.chunks.push(chunk);
    parcel.currentLength += chunk.length;

    if (parcel.currentLength === parcel.length) {
      this._emitParcelType(parcel);
    }
  } else {
    const chunks = this.chunks.get(chunk.parcelId);
    chunks ? chunks.push(chunk) : this.chunks.set(chunk.parcelId, [chunk]);
  }
};

Connection.prototype._emitParcelType = function(parcel) {
  parcel.chunks.sort((cur, next) => cur.id - next.id);
  const payload = parcel.chunks.reduce((acc, cur) => acc += cur.payload, '');
  this.emit(parcel.parcelType, payload);
};

module.exports = Connection;
