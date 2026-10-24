'use strict';

const { parseCookies, parseHost } = require('metautil');
const { ClientHttpTransport } = require('./client-http.js');
const { ServerTransport, buildHeaders } = require('./transport.js');
const { registerTransport } = require('./transport-registry.js');

const TOKEN = 'token';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';
const FUTURE = 'Fri, 01 Jan 2100 00:00:00 GMT';
const LOCATION = 'Path=/; Domain';
const COOKIE_DELETE = `${TOKEN}=deleted; Expires=${EPOCH}; ${LOCATION}=`;
const COOKIE_HOST = `Expires=${FUTURE}; ${LOCATION}`;

class ServerHttpTransport extends ServerTransport {
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

ServerHttpTransport.capabilities = {
  duplex: false,
  streams: false,
  events: false,
};

const attach = (server, options, onConnection) => {
  const { headers } = options;
  server.httpServer.on('request', (req, res) => {
    if (!req.url.startsWith('/api')) return;
    const transport = new ServerHttpTransport(req, res, { headers });
    if (res.writableEnded) return;
    onConnection(transport);
  });
};

registerTransport('http', {
  Client: ClientHttpTransport,
  Server: ServerHttpTransport,
  capabilities: ServerHttpTransport.capabilities,
  attach,
});

module.exports = { ClientHttpTransport, ServerHttpTransport, attach };
