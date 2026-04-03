'use strict';

const http = require('node:http');
const { Emitter, parseCookies, parseHost } = require('metautil');

const HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const buildHeaders = (cors) => {
  if (!cors || !cors.origin) return HEADERS;
  return { ...HEADERS, 'Access-Control-Allow-Origin': cors.origin };
};

const TOKEN = 'token';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';
const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
const LOCATION = 'Path=/; Domain';
const COOKIE_DELETE = `${TOKEN}=deleted; Expires=${EPOCH}; ${LOCATION}=`;
const COOKIE_HOST = `Expires=${FUTURE}; ${LOCATION}`;

class ServerTransport extends Emitter {
  constructor(source) {
    super();
    this.source = source;
  }

  error(code = 500, { id, error = null, httpCode = null } = {}) {
    if (!httpCode) httpCode = (error && error.httpCode) || code;
    const status = http.STATUS_CODES[httpCode];
    const pass = httpCode < 500 || httpCode > 599;
    const message = pass && error ? error.message : status || 'Unknown error';
    const outCode = pass ? code : httpCode;
    if (this.req) this.emit('error', error, httpCode, code);
    const packet = { type: 'callback', id, error: { message, code: outCode } };
    this.send(packet, httpCode);
  }

  send(obj, code = 200) {
    this.write(JSON.stringify(obj), code);
  }
}

class ServerHttpTransport extends ServerTransport {
  constructor(req, res, options = {}) {
    super(req.socket.remoteAddress);
    this.req = req;
    this.res = res;
    this.headers = options.headers || HEADERS;
    if (req.method === 'OPTIONS') this.options();
    req.on('close', () => void this.emit('close'));
  }

  write(data, httpCode = 200) {
    const { res } = this;
    if (httpCode >= 200 && httpCode <= 299) this.emit('debug', httpCode);
    if (res.writableEnded) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const headers = { ...this.headers, 'Content-Length': buf.length };
    res.writeHead(httpCode, headers);
    res.end(buf);
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
    this.res.setHeader('Set-Cookie', COOKIE_DELETE + host);
  }

  close() {
    this.error(503);
    this.req.socket.destroy();
  }
}

class ServerWsTransport extends ServerTransport {
  constructor(req, connection) {
    super(req.socket.remoteAddress);
    this.connection = connection;
    connection.on('close', () => void this.emit('close'));
  }

  write(data) {
    this.connection.send(data);
  }

  close() {
    this.connection.terminate();
  }
}

class ServerEventTransport extends ServerTransport {
  constructor(port) {
    super('event transport');
    this.port = port;
    port.on('close', () => void this.emit('close'));
  }

  write(data) {
    this.port.postMessage(data);
  }

  close() {
    this.port.close();
  }
}

ServerTransport.transport = {
  http: ServerHttpTransport,
  ws: ServerWsTransport,
  event: ServerEventTransport,
};

module.exports = {
  ServerTransport,
  buildHeaders,
};
