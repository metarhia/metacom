'use strict';

const { Metacom, MetacomProxy, MetacomError } = require('./lib/metacom.js');
const server = require('./lib/server.js');
const { Server, Client, Context, Session, createProxy } = server;
const transport = require('./lib/transport.js');
const { ClientTransport, ServerTransport, buildHeaders } = transport;
const registry = require('./lib/transport-registry.js');
const { registerTransport, getTransport, allTransports } = registry;
const transportWs = require('./lib/transport-ws.js');
const { ClientWsTransport, ServerWsTransport } = transportWs;
const transportHttp = require('./lib/transport-http.js');
const { ClientHttpTransport, ServerHttpTransport } = transportHttp;
const transportEvent = require('./lib/transport-event.js');
const { ClientEventTransport, ServerEventTransport } = transportEvent;
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
