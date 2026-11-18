'use strict';

const { Metacom, MetacomError } = require('./lib/metacom.js');
const { MetacomProxy } = require('./lib/proxy.js');
const { MetacomRouter } = require('./lib/router.js');
const { MetacomPeer } = require('./lib/peer.js');
const {
  ClientRtcBridgeTransport,
  MetacomRtcBridge,
} = require('./lib/rtc-bridge.js');
const server = require('./lib/server.js');
const { Server, Client, Context, Session, createProxy } = server;
const { matchDomain, Listener } = require('./lib/listener.js');
const transport = require('./lib/transport.js');
const { ClientTransport, ServerTransport, buildHeaders } = transport;
const { isApiPath } = transport;
const { registerTransport, getTransport, allTransports } = transport;
const { ClientWsTransport, ServerWsTransport } = transport;
const { ClientHttpTransport, ServerHttpTransport } = transport;
const { ClientEventTransport, ServerEventTransport } = transport;
const { ClientRtcTransport } = require('./lib/client.js');
const { RtcConnection, retireRtcGeneration } = require('./lib/rtc.js');
const { RtcChannelEndpoint } = require('./lib/rtc-channel.js');
const { TRANSPORTS } = require('./lib/client.js');
const streams = require('./lib/streams.js');
const { MetaReadable, MetaWritable, isStreamMeta } = streams;
const utils = require('./lib/utils.js');
const { startInterval, parseMethod, encodeEvent, emitError } = utils;
const { chunkEncode, chunkDecode } = require('./lib/chunks-node.js');
const ws = require('./lib/websocket/ws.js');

module.exports = {
  Metacom,
  MetacomProxy,
  MetacomRouter,
  MetacomPeer,
  ClientRtcBridgeTransport,
  MetacomRtcBridge,
  MetacomError,
  Server,
  Listener,
  matchDomain,
  Client,
  Context,
  Session,
  createProxy,
  ClientTransport,
  ServerTransport,
  buildHeaders,
  isApiPath,
  registerTransport,
  getTransport,
  allTransports,
  ClientWsTransport,
  ServerWsTransport,
  ClientHttpTransport,
  ServerHttpTransport,
  ClientEventTransport,
  ClientRtcTransport,
  RtcConnection,
  retireRtcGeneration,
  RtcChannelEndpoint,
  ServerEventTransport,
  TRANSPORTS,
  MetaReadable,
  MetaWritable,
  isStreamMeta,
  startInterval,
  parseMethod,
  encodeEvent,
  emitError,
  chunkEncode,
  chunkDecode,
  ...ws,
};
