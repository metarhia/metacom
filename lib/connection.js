'use strict';

const EventEmitter = require('events');
const parser = require('./parser.js');

const INITIAL_BUFFER_SIZE = 16384;

const ENCODING = {
  binary: 0,
  jstp: 1,
  json: 2,
  bson: 3,
  v8: 4
};

const PARCEL_TYPES = [
  'ping',
  'pong',
  'call',
  'callback',
  'event',
  'stream'
];

class Connection extends EventEmitter {
  constructor() {
    super();
    this.encoding = ENCODING.binary;

    this.chunks = new Map();
    this.parcels = new Map();

    // Buffer for collecting full data,
    // cut by lower-level protocols
    this.position = 0;
    this.buffer = Buffer.alloc(INITIAL_BUFFER_SIZE);
    this.bytesToRead = parser.HANDSHAKE_LENGTH;
    this.waitingHandshake = true;

    this.transport.on('data', (data) => {
      if (this.bytesToRead === 0) {
        const structType = parser.readStructType(data);
        this.bytesToRead = structType === parser.STRUCT_PARCEL ?
          parser.PARCEL_LENGTH : parser.CHUNK_LENGTH;
      }
      this._onRawData(data);
    });

    // Process handshake as a first structure
    this.once('structure', this._onHandshake);
  }

  _onRawData(data) {
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
        !this.waitingHandshake &&
        structType === parser.STRUCT_CHUNK &&
        this.position === parser.CHUNK_LENGTH
      ) {
        this.bytesToRead = parser.readPayloadLength(this.buffer);
      } else {
        this.emit('structure', this.buffer, this.position);
        this.position = 0;
        // if more data, read struct type from it
        // and set appropriate value to bytesToRead
        // or set bytesToRead equal to 0
        if (data.length) {
          const structType = parser.readStructType(data);
          this.bytesToRead = structType === parser.STRUCT_PARCEL ?
            parser.PARCEL_LENGTH : parser.CHUNK_LENGTH;
        } else {
          this.bytesToRead = 0;
        }
      }

      if (data.length > 0) this._onRawData(data);
    }
  }

  setEncoding(encoding) {
    this.encoding = ENCODING[encoding];
  }

  sendHandshake(handshake) {
    const buffer = parser.handshake(handshake);
    this.send(buffer);
  }

  sendParcel(parcel, callback) {
    parcel.encoding = this.encoding;
    const buffer = parser.parcel(parcel);
    this.send(buffer, callback);
  }

  sendChunk(chunk, callback) {
    chunk.encoding = this.encoding;
    const buffer = parser.chunk(chunk);
    this.send(buffer, callback);
  }

  send(data, callback) {
    this.transport.write(data, callback);
  }

  _onHandshake(buffer) {
    const handshake = parser.readHandshake(buffer);
    this.waitingHandshake = false;
    this.emit('handshake', handshake);
    this.on('structure', (buffer, length) => {
      const struct = parser.readStruct(buffer, length);
      if (struct.structType === parser.STRUCT_PARCEL) this._onParcel(struct);
      else if (struct.structType === parser.STRUCT_CHUNK) this._onChunk(struct);
    });
  }

  _onParcel(parcel) {
    if (parcel.parcelType === parser.PARCEL_STREAM) {
      this._emitParcelType(parcel);
    }

    const chunks = this.chunks.get(parcel.parcelId);

    if (!chunks) {
      parcel.chunks = [];
      parcel.currentLength = 0;
      this.parcels.set(parcel.parcelId, parcel);
      return;
    }

    const currentLength = chunks.reduce((acc, cur) => acc += cur.length, 0);
    Object.assign(parcel, { chunks, currentLength });

    if (currentLength === parcel.length) this._emitParcelType(parcel);
  }

  _onChunk(chunk) {
    const parcel = this.parcels.get(chunk.parcelId);

    if (parcel) {
      parcel.chunks.push(chunk);
      parcel.currentLength += chunk.length;

      if (parcel.currentLength === parcel.length) this._emitParcelType(parcel);
    } else {
      const chunks = this.chunks.get(chunk.parcelId);

      if (chunks) {
        chunks.push(chunk);
      } else {
        this.chunks.set(chunk.parcelId, [chunk]);
      }
    }
  }

  _emitParcelType(parcel) {
    const type = parcel.parcelType;
    const length = parcel.length;
    const buffer = Buffer.alloc(length);
    const chunks = parcel.chunks.sort((cur, next) => cur.id - next.id);
    chunks.reduce(
      (pos, { payload }) => pos += payload.copy(buffer, pos), 0
    );
    this.emit(PARCEL_TYPES[type], buffer);
  }
}

module.exports = Connection;
