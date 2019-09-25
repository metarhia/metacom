'use strict';

const structSizes = {
  HANDSHAKE_SIZE: 36,
  PARCEL_HEADER_SIZE: 16,
  CHUNK_HEADER_SIZE: 12,
  PING_SIZE: 1,
  PONG_SIZE: 1,
};

const structTypes = {
  STRUCT_HANDSHAKE: 0,
  STRUCT_PARCEL_HEADER: 1,
  STRUCT_CHUNK_HEADER: 2,
  STRUCT_PING: 3,
  STRUCT_PONG: 4,
};

const parcelTypes = {
  PARCEL_CALL: 0,
  PARCEL_CALLBACK: 1,
  PARCEL_EVENT: 2,
  PARCEL_STREAM: 3,
};

module.exports = {
  PROTOCOL_VERSION: 1,
  ...structSizes,
  ...structTypes,
  ...parcelTypes,
};
