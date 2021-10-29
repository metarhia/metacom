'use strict';

const metautil = require('metautil');
const { Channel } = require('./channel.js');

const MIME_TYPES = {
  html: 'text/html; charset=UTF-8',
  json: 'application/json; charset=UTF-8',
  js: 'application/javascript; charset=UTF-8',
  css: 'text/css',
  png: 'image/png',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
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
    const origin = application.config.server.cors.origin;
    HEADERS['Access-Control-Allow-Origin'] = origin;
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

  async hook(proc, interfaceName, methodName, args) {
    const { application, client } = this;
    const callId = -1;
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    const context = { client };
    let result = null;
    try {
      result = await proc.invoke(context, { method: methodName, args });
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

module.exports = { createChannel };
