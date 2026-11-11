'use strict';

const { Metacom, MetacomError } = require('./lib/metacom.js');
const { MetacomProxy } = require('./lib/proxy.js');
const server = require('./lib/server.js');
const { Server, Client, Context, Session, createProxy } = server;
const transport = require('./lib/transport.js');
const { ClientTransport, ServerTransport, buildHeaders } = transport;
const { registerTransport, getTransport, allTransports } = transport;
const { ClientWsTransport, ServerWsTransport } = transport;
const { ClientHttpTransport, ServerHttpTransport } = transport;
const { ClientEventTransport, ServerEventTransport } = transport;
const { MetaReadable, MetaWritable } = require('./lib/streams.js');
const { chunkEncode, chunkDecode } = require('./lib/chunks-node.js');
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
