'use strict';

const http = require('node:http');

const { Emitter, parseCookies, parseHost } = require('metautil');

const { WebsocketServer } = require('./websocket/ws.js');
const client = require('./client.js');
const { ClientTransport, ClientWsTransport } = client;
const { ClientHttpTransport, ClientEventTransport } = client;

const HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const TOKEN = 'token';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';
const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
const LOCATION = 'Path=/; Domain';
const COOKIE_DELETE = `${TOKEN}=deleted; Expires=${EPOCH}; ${LOCATION}=`;
const COOKIE_HOST = `Expires=${FUTURE}; ${LOCATION}`;

const adapters = new Map();

const buildHeaders = (cors) => {
  if (!cors?.origin) return HEADERS;
  return { ...HEADERS, 'Access-Control-Allow-Origin': cors.origin };
};

const registerTransport = (name, adapter) => {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('Transport name must be a non-empty string');
  }
  if (typeof adapter.Client !== 'function') {
    throw new TypeError(`Transport '${name}': Client must be a constructor`);
  }
  if (typeof adapter.Server !== 'function') {
    throw new TypeError(`Transport '${name}': Server must be a constructor`);
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== 'object') {
    throw new TypeError(`Transport '${name}': capabilities must be an object`);
  }
  adapters.set(name, adapter);
};

const getTransport = (name) => {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unknown transport: '${name}'`);
  return adapter;
};

const allTransports = () => adapters.entries();

class ServerTransport extends Emitter {
  constructor(source) {
    super();
    this.source = source;
  }

  // eslint-disable-next-line class-methods-use-this
  close() {}

  // eslint-disable-next-line class-methods-use-this
  getCookies() {
    return {};
  }

  // eslint-disable-next-line class-methods-use-this
  sendSessionCookie() {}

  // eslint-disable-next-line class-methods-use-this
  removeSessionCookie() {}

  // eslint-disable-next-line class-methods-use-this
  drain() {
    return Promise.resolve();
  }

  // Application codes (string or out of range) go as 500 to HTTP status
  error(code = 500, { id = '', error = null } = {}) {
    const status = http.STATUS_CODES[code];
    const message = error ? error.message : status || 'Unknown error';
    const packet = { type: 'callback', id, error: { message, code } };
    const httpCode = status ? code : 500;
    this.send(packet, httpCode);
  }

  send(obj, code = 200) {
    this.write(JSON.stringify(obj), code);
  }
}

class ServerWsTransport extends ServerTransport {
  static capabilities = { duplex: true, streams: true, events: true };

  constructor(req, connection) {
    super(req.socket.remoteAddress);
    this.connection = connection;
    connection.on('close', () => void this.emit('close'));
    connection.on('error', () => void this.emit('close'));
    connection.on('message', (data, isBinary) => {
      this.emit('message', isBinary ? data : data.toString());
    });
  }

  write(data) {
    const isSendable = typeof data === 'string' || Buffer.isBuffer(data);
    if (isSendable) return this.connection.send(data);
    const { buffer, byteOffset, byteLength } = data;
    const view = Buffer.from(buffer, byteOffset, byteLength);
    return this.connection.send(view);
  }

  drain() {
    return this.connection.drain();
  }

  close() {
    this.connection.terminate();
  }
}

const attachWs = (server, options, onConnection) => {
  const { path, verifyClient } = options;
  const wsOptions = { server: server.httpServer, path, verifyClient };
  const wsServer = new WebsocketServer(wsOptions);
  wsServer.on('connection', (connection, req) => {
    const transport = new ServerWsTransport(req, connection);
    onConnection(transport);
  });
  return wsServer;
};

class ServerHttpTransport extends ServerTransport {
  static capabilities = { duplex: false, streams: false, events: false };

  constructor(req, res, options = {}) {
    super(req.socket.remoteAddress);
    this.req = req;
    this.res = res;
    this.headers = options.headers ?? buildHeaders();
    if (req.method === 'OPTIONS') this.options();
    req.on('close', () => void this.emit('close'));
  }

  write(data, httpCode = 200) {
    const { res } = this;
    if (res.writableEnded) return;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const headers = { ...this.headers, 'Content-Length': body.length };
    res.writeHead(httpCode, headers);
    res.end(body);
  }

  options() {
    const { res } = this;
    if (res.headersSent) return;
    res.writeHead(200, this.headers);
    res.end();
  }

  getCookies() {
    const { cookie } = this.req.headers;
    if (!cookie) return {};
    return parseCookies(cookie);
  }

  sendSessionCookie(token) {
    const host = parseHost(this.req.headers.host);
    const cookie = `${TOKEN}=${token}; ${COOKIE_HOST}=${host}`;
    this.res.setHeader('Set-Cookie', cookie);
  }

  removeSessionCookie() {
    const host = parseHost(this.req.headers.host);
    this.res.setHeader('Set-Cookie', `${COOKIE_DELETE}${host}`);
  }

  close() {
    this.error(503);
    this.req.socket.destroy();
  }
}

const attachHttp = (server, options, onConnection) => {
  const { headers } = options;
  server.httpServer.on('request', (req, res) => {
    if (!req.url.startsWith('/api')) return;
    const transport = new ServerHttpTransport(req, res, { headers });
    if (res.writableEnded) return;
    onConnection(transport);
  });
};

class ServerEventTransport extends ServerTransport {
  static capabilities = { duplex: true, streams: true, events: true };

  constructor(port) {
    super('event transport');
    this.port = port;
    port.on('close', () => void this.emit('close'));
    port.on('message', (data) => {
      const packet = Buffer.isBuffer(data) ? data.toString() : data;
      this.emit('message', packet);
    });
  }

  write(data) {
    this.port.postMessage(data);
  }

  close() {
    this.port.close();
  }
}

// Ports arrive from outside, for example a Service Worker bridge
const attachEvent = (server, options, onConnection) => {
  server.on('port', (port) => {
    const transport = new ServerEventTransport(port);
    onConnection(transport);
  });
};

registerTransport('ws', {
  Client: ClientWsTransport,
  Server: ServerWsTransport,
  capabilities: ServerWsTransport.capabilities,
  attach: attachWs,
});

registerTransport('http', {
  Client: ClientHttpTransport,
  Server: ServerHttpTransport,
  capabilities: ServerHttpTransport.capabilities,
  attach: attachHttp,
});

registerTransport('event', {
  Client: ClientEventTransport,
  Server: ServerEventTransport,
  capabilities: ServerEventTransport.capabilities,
  attach: attachEvent,
});

module.exports = {
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  buildHeaders,
  registerTransport,
  getTransport,
  allTransports,
  ServerTransport,
  ServerWsTransport,
  ServerHttpTransport,
  ServerEventTransport,
};
