'use strict';

const metautil = require('metautil');
const { Channel } = require('./channel.js');

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

class HttpChannel extends Channel {
  constructor(application, req, res) {
    super(application, req, res);
    res.on('close', () => {
      this.destroy();
    });
  }

  write(data, httpCode = 200, ext = 'json') {
    const { res } = this;
    if (res.writableEnded) return;
    const mimeType = MIME_TYPES[ext] || MIME_TYPES.html;
    res.writeHead(httpCode, { ...HEADERS, 'Content-Type': mimeType });
    res.end(data);
  }

  send(obj, httpCode = 200) {
    const data = JSON.stringify(obj);
    this.write(data, httpCode, 'json');
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

  async hook(proc, interfaceName, methodName, args, headers) {
    const { application, client, req } = this;
    const verb = req.method;
    const callId = -1;
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    const context = { client };
    let result = null;
    try {
      const par = { verb, method: methodName, args, headers };
      result = await proc.invoke(context, par);
    } catch (error) {
      this.error(500, { callId, error });
      return;
    }
    this.send(result);
    const record = `${this.ip}\t${interfaceName}/${methodName}`;
    application.console.log(record);
  }

  startSession() {
    const token = this.application.auth.generateToken();
    const host = metautil.parseHost(this.req.headers.host);
    const cookie = `${TOKEN}=${token}; ${COOKIE_HOST}=${host}`;
    const session = this.application.auth.startSession();
    if (this.res) this.res.setHeader('Set-Cookie', cookie);
    return session;
  }

  deleteSession() {
    const { token } = this;
    if (token === 'anonymous') return;
    const host = metautil.parseHost(this.req.headers.host);
    this.res.setHeader('Set-Cookie', COOKIE_DELETE + host);
    this.application.auth.deleteSession(token);
  }
}

const createChannel = (application, req, res) =>
  new HttpChannel(application, req, res);

const addHeaders = (headers) => {
  const { origin } = headers;
  if (origin) HEADERS['Access-Control-Allow-Origin'] = origin;
};

module.exports = { createChannel, addHeaders };
