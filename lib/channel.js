'use strict';

const http = require('http');
const path = require('path');
const metautil = require('metautil');

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

class Session {
  constructor(token, channel, data) {
    this.token = token;
    this.channel = channel;
    this.channels = new Map([channel]);
    this.data = data;
    this.context = new Proxy(data, {
      get: (data, key) => {
        if (key === 'token') return token;
        if (key === 'client') return channel.client;
        return Reflect.get(data, key);
      },
      set: (data, key, value) => {
        const res = Reflect.set(data, key, value);
        channel.application.auth.saveSession(token, data);
        return res;
      },
    });
  }
}

const sessions = new Map();
const channels = new Map();

class Client {
  constructor() {
    this.callId = 0;
  }

  emit(name, data) {
    const packet = { event: --this.callId, [name]: data };
    const channel = channels.get(this);
    if (!channel.connection) {
      throw new Error(`Can't send metacom events to http transport`);
    }
    channel.connection.send(JSON.stringify(packet));
  }

  async startSession(systemUserId) {
    const channel = channels.get(this);
    const token = channel.application.auth.generateToken();
    const data = {};
    const fields = { ip: channel.ip, systemUserId };
    channel.application.auth.startSession(token, data, fields);
    const session = new Session(token, channel, data);
    channel.session = session;
    sessions.set(token, session);
    return token;
  }

  async restoreSession(token) {
    let session = sessions.get(token);
    if (session) return session;
    const channel = channels.get(this);
    const data = await channel.application.auth.restoreSession(token);
    if (!data) return null;
    session = new Session(token, channel, data);
    channel.session = session;
    sessions.set(token, session);
    return session;
  }
}

class Channel {
  constructor(req, res, connection, application) {
    this.req = req;
    this.res = res;
    this.ip = req.socket.remoteAddress;
    this.connection = connection;
    this.application = application;
    const client = new Client();
    this.client = client;
    channels.set(client, this);
    this.session = null;
    this.restoreSession();
  }

  get token() {
    if (this.session === null) return 'anonymous';
    return this.session.token;
  }

  static() {
    const { req, res, ip, application } = this;
    const { url, method } = req;
    const filePath = url === '/' ? '/index.html' : url;
    const fileExt = path.extname(filePath).substring(1);
    const mimeType = MIME_TYPES[fileExt] || MIME_TYPES.html;
    res.writeHead(200, { ...HEADERS, 'Content-Type': mimeType });
    if (res.writableEnded) return;
    const data = application.getStaticFile(filePath);
    if (data) {
      res.end(data);
      application.console.log(`${ip}\t${method}\t${url}`);
      return;
    }
    this.error(404);
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

  error(code, err, callId) {
    const { req, res, connection, ip, application } = this;
    const { url, method } = req;
    const status = http.STATUS_CODES[code];
    const reason = err !== null ? err.stack : status;
    application.console.error(`${ip}\t${method}\t${url}\t${code}\t${reason}`);
    const message = status || err.message;
    const error = { message, code };
    if (connection) {
      connection.send(JSON.stringify({ callback: callId, error }));
      return;
    }
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': MIME_TYPES.json, ...HEADERS });
    res.end(JSON.stringify({ error }));
  }

  message(data) {
    if (data === '{}') {
      this.connection.send('{}');
      return;
    }
    let packet;
    try {
      packet = JSON.parse(data);
    } catch (err) {
      this.error(500, new Error('JSON parsing error'));
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      this.rpc(callId, interfaceName, methodName, args);
      return;
    }
    this.error(500, new Error('Packet structure error'));
  }

  async rpc(callId, interfaceName, methodName, args) {
    const { res, connection, application, session, client } = this;
    const { semaphore } = application.server;
    try {
      await semaphore.enter();
    } catch {
      this.error(504, null, callId);
      return;
    }
    const [iname, ver = '*'] = interfaceName.split('.');
    try {
      const context = session ? session.context : { client };
      const proc = application.getMethod(iname, ver, methodName, context);
      if (!proc) {
        this.error(404, null, callId);
        return;
      }
      if (!this.session && proc.access !== 'public') {
        this.error(403, null, callId);
        return;
      }
      const result = await application.invoke(proc, args);
      if (result instanceof Error) {
        this.error(result.code, result, callId);
        return;
      }
      const id = result ? result.systemUserId : 0;
      if (!this.session && id && proc.access === 'public') {
        this.session = application.auth.startSession(this, id);
        result.token = this.token;
      }
      const data = JSON.stringify({ callback: callId, result });
      if (connection) {
        connection.send(data);
      } else {
        res.writeHead(200, { 'Content-Type': MIME_TYPES.json, ...HEADERS });
        res.end(data);
      }
      const { ip, token } = this;
      const who = id > 0 ? id : token;
      const record = `${ip}\t${who}\t${interfaceName}/${methodName}`;
      application.console.log(record);
    } catch (err) {
      this.error(500, err, callId);
    } finally {
      semaphore.leave();
    }
  }

  startSession() {
    const token = this.generateToken();
    const host = metautil.parseHost(this.req.headers.host);
    const cookie = `${TOKEN}=${token}; ${COOKIE_HOST}=${host}`;
    const session = this.application.auth.startSession();
    if (this.res) this.res.setHeader('Set-Cookie', cookie);
    return session;
  }

  async restoreSession() {
    const { cookie } = this.req.headers;
    if (!cookie) return null;
    const cookies = metautil.parseCookies(cookie);
    const { token } = cookies;
    if (!token) return null;
    const session = await this.application.auth.restoreSession(token);
    if (!session) return null;
    return session;
  }

  deleteSession() {
    const { token } = this;
    if (token === 'anonymous') return;
    const host = metautil.parseHost(this.req.headers.host);
    this.res.setHeader('Set-Cookie', COOKIE_DELETE + host);
    this.application.auth.deleteSession(token);
  }

  destroy() {
    if (!this.session) return;
    const token = this.session.token;
    sessions.delete(token);
  }
}

module.exports = { Channel, channels };
