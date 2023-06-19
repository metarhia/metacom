'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const metautil = require('metautil');
const protocol = require('./protocol.js');

const MIME_TYPES = {
  bin: 'application/octet-stream',
  htm: 'text/html',
  html: 'text/html',
  shtml: 'text/html',
  json: 'application/json',
  xml: 'text/xml',
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  txt: 'text/plain',
  csv: 'text/csv',
  ics: 'text/calendar',
  avif: 'image/avif',
  bmp: 'image/x-ms-bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jng: 'image/x-jng',
  jpg: 'image/jpg',
  png: 'image/png',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  wbmp: 'image/vnd.wap.wbmp',
  webp: 'image/webp',
  '3gpp': 'video/3gpp',
  '3gp': 'video/3gpp',
  aac: 'audio/aac',
  asf: 'video/x-ms-asf',
  avi: 'video/x-msvideo',
  m4a: 'audio/x-m4a',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpega: 'video/mpeg',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  ra: 'audio/x-realaudio',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ai: 'application/postscript',
  eps: 'application/postscript',
  jar: 'application/java-archive',
  pdf: 'application/pdf',
  ps: 'application/postscript',
  wasm: 'application/wasm',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  rar: 'application/x-rar-compressed',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  zip: 'application/zip',
};

const HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOKEN = 'token';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';
const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
const LOCATION = 'Path=/; Domain';
const COOKIE_DELETE = `${TOKEN}=deleted; Expires=${EPOCH}; ${LOCATION}=`;
const COOKIE_HOST = `Expires=${FUTURE}; ${LOCATION}`;

class Transport extends EventEmitter {
  constructor(server, req) {
    super();
    this.server = server;
    this.req = req;
    this.ip = req.socket.remoteAddress;
  }

  error(code = 500, { id, error = null, httpCode = null } = {}) {
    const { server, req, ip } = this;
    const { console } = server;
    const { url, method } = req;
    if (!httpCode) httpCode = (error && error.httpCode) || code;
    const status = http.STATUS_CODES[httpCode];
    const pass = httpCode < 500 || httpCode > 599;
    const message = pass && error ? error.message : status || 'Unknown error';
    const reason = `${httpCode}\t${code}\t${error ? error.stack : status}`;
    console.error(`${ip}\t${method}\t${url}\t${reason}`);
    const packet = protocol.serialize('callback', { id, message, code });
    this.send(packet, httpCode);
  }

  send(obj, code = 200) {
    const data = JSON.stringify(obj);
    this.write(data, code, 'json');
  }
}

class HttpTransport extends Transport {
  constructor(server, req, res) {
    super(server, req);
    this.res = res;
    if (req.method === 'OPTIONS') this.options();
    req.on('close', () => {
      this.emit('close');
    });
  }

  write(data, httpCode = 200, ext = 'json', options = {}) {
    const { res } = this;
    if (res.writableEnded) return;
    const streaming = data instanceof Readable;
    const mimeType = MIME_TYPES[ext] || MIME_TYPES.html;
    const headers = { ...HEADERS, 'Content-Type': mimeType };
    if (httpCode === 206) {
      const { start, end, size = '*' } = options;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Accept-Ranges'] = 'bytes';
      headers['Content-Length'] = end - start + 1;
    }
    if (!streaming) headers['Content-Length'] = data.length;
    res.writeHead(httpCode, headers);
    if (streaming) data.pipe(res);
    else res.end(data);
  }

  redirect(location) {
    const { res } = this;
    if (res.headersSent) return;
    res.writeHead(302, { Location: location, ...HEADERS });
    res.end();
  }

  options() {
    const { res } = this;
    if (res.headersSent) return;
    res.writeHead(200, HEADERS);
    res.end();
  }

  getCookies() {
    const { cookie } = this.req.headers;
    if (!cookie) return {};
    return metautil.parseCookies(cookie);
    /*const { token } = cookies.token;
    if (!token) return;
    const restored = client.restoreSession(token);
    if (restored) return;
    const data = await this.server.auth.readSession(token);
    if (data) client.initializeSession(token, data);*/
  }

  sendSessionCookie(token) {
    const host = metautil.parseHost(this.req.headers.host);
    const cookie = `${TOKEN}=${token}; ${COOKIE_HOST}=${host}`;
    this.res.setHeader('Set-Cookie', cookie);
  }

  removeSessionCookie() {
    const host = metautil.parseHost(this.req.headers.host);
    this.res.setHeader('Set-Cookie', COOKIE_DELETE + host);
  }

  close() {
    this.error(503);
    this.req.connection.destroy();
  }
}

class WsTransport extends Transport {
  constructor(server, req, connection) {
    super(server, req);
    this.connection = connection;
    connection.on('close', () => {
      this.emit('close');
    });
  }

  write(data) {
    this.connection.send(data);
  }

  close() {
    this.connection.terminate();
  }
}

module.exports = { Transport, HttpTransport, WsTransport, MIME_TYPES, HEADERS };
