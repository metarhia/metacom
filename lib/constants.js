'use strict';

const sizes = {
  HANDSHAKE_SIZE: 36,
  PARCEL_HEADER_SIZE: 16,
  CHUNK_HEADER_SIZE: 12,
};

const structTypes = {
  STRUCT_PARCEL_HEADER: 0,
  STRUCT_CHUNK_HEADER: 1,
};

const parcelTypes = {
  PARCEL_PING: 0,
  PARCEL_PONG: 1,
  PARCEL_CALL: 2,
  PARCEL_CALLBACK: 3,
  PARCEL_EVENT: 4,
  PARCEL_STREAM: 5,
};

module.exports = {
  PROTOCOL_VERSION: 1,
  ...sizes,
  ...structTypes,
  ...parcelTypes,
};