'use strict';

const { Metacom, MetacomProxy, MetacomError } = require('./lib/metacom.js');
const {
  Server,
  Client,
  Context,
  Session,
  createProxy,
} = require('./lib/server.js');
const {
  ClientTransport,
  ServerTransport,
  buildHeaders,
} = require('./lib/transport.js');
const {
  registerTransport,
  getTransport,
  allTransports,
} = require('./lib/transport-registry.js');
const {
  ClientWsTransport,
  ServerWsTransport,
} = require('./lib/transport-ws.js');
const {
  ClientHttpTransport,
  ServerHttpTransport,
} = require('./lib/transport-http.js');
const {
  ClientEventTransport,
  ServerEventTransport,
} = require('./lib/transport-event.js');
const { MetaReadable, MetaWritable } = require('./lib/streams.js');
const { chunkEncode, chunkDecode } = require('./lib/chunks.js');
const ws = require('./lib/websocket/ws.js');

module.exports = {
  Metacom,
  MetacomProxy,
  MetacomError,
  Server,
  Client,
  Context,
  Session,
  createProxy,
  ClientTransport,
  ServerTransport,
  buildHeaders,
  registerTransport,
  getTransport,
  allTransports,
  ClientWsTransport,
  ServerWsTransport,
  ClientHttpTransport,
  ServerHttpTransport,
  ClientEventTransport,
  ServerEventTransport,
  MetaReadable,
  MetaWritable,
  chunkEncode,
  chunkDecode,
  ...ws,
};
