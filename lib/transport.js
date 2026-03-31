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
  constructor(req, options = {}) {
    super();
    this.req = req;
    this.ip = req.socket.remoteAddress;
    this.console = options.console || globalThis.console;
  }

  error(code = 500, { id, error = null, httpCode = null } = {}) {
    const { req, ip, console } = this;
    const { url, method } = req;
    if (!httpCode) httpCode = (error && error.httpCode) || code;
    const status = http.STATUS_CODES[httpCode];
    const pass = httpCode < 500 || httpCode > 599;
    const message = pass && error ? error.message : status || 'Unknown error';
    const reason = `${httpCode}\t${code}\t${error ? error.stack : status}`;
    console.error(`${ip}\t${method}\t${url}\t${reason}`);
    const outCode = pass ? code : httpCode;
    const packet = { type: 'callback', id, error: { message, code: outCode } };
    this.send(packet, httpCode);
  }

  log(code) {
    const { req, ip, console } = this;
    const { url, method } = req;
    const msg = `${ip}\t${method}\t${url}\t${code}`;
    if (code >= 200 && code <= 299) console.debug(msg);
    else console.error(msg);
  }

  send(obj, code = 200) {
    this.write(JSON.stringify(obj), code);
  }
}

class ServerHttpTransport extends ServerTransport {
  constructor(req, res, options = {}) {
    super(req, options);
    this.res = res;
    this.headers = options.headers || HEADERS;
    if (req.method === 'OPTIONS') this.options();
    req.on('close', () => void this.emit('close'));
  }

  write(data, httpCode = 200) {
    this.log(httpCode);
    const { res } = this;
    if (res.writableEnded) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const headers = { ...this.headers, 'Content-Length': buf.length };
    res.writeHead(httpCode, headers);
    res.end(buf);
  }

  redirect(location) {
    const { res, req } = this;
    if (res.headersSent) return;
    const code = ['GET', 'HEAD'].includes(req.method) ? 302 : 307;
    res.writeHead(code, { Location: location, ...this.headers });
    res.end();
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
  constructor(req, connection, options = {}) {
    super(req, options);
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
  constructor(port, options = {}) {
    super(null, options);
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
