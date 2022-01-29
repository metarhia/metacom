'use strict';

const http = require('http');
const metautil = require('metautil');

const EMPTY_PACKET = Buffer.from('{}');

class Session {
  constructor(token, channel, data) {
    this.token = token;
    this.channel = channel;
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

const sessions = new Map(); // token: Session
const channels = new Map(); // Client: Channel

class Client {
  constructor() {
    this.events = { close: [] };
    this.callId = 0;
  }

  redirect(location) {
    return channels.get(this).redirect(location);
  }

  get ip() {
    return channels.get(this).ip;
  }

  on(name, callback) {
    if (name !== 'close') return;
    this.events.close.push(callback);
  }

  emit(name, data) {
    const packet = { event: --this.callId, [name]: data };
    const channel = channels.get(this);
    if (!channel.connection) {
      throw new Error(`Can't send metacom events to http transport`);
    }
    channel.send(packet);
  }

  startSession(token, data = {}) {
    const channel = channels.get(this);
    if (channel.session) sessions.delete(channel.session.token);
    const session = new Session(token, channel, data);
    channel.session = session;
    sessions.set(token, session);
  }

  restoreSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    const channel = channels.get(this);
    channel.session = session;
    return true;
  }

  deleteSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    const channel = channels.get(this);
    if (channel.session) {
      sessions.delete(channel.session.token);
      channel.session = null;
      return true;
    }
    return false;
  }
}

class Channel {
  constructor(application, req, res) {
    this.application = application;
    this.req = req;
    this.res = res;
    this.ip = req.socket.remoteAddress;
    this.client = new Client();
    channels.set(this.client, this);
    this.session = null;
    this.restoreSession();
  }

  get token() {
    if (this.session === null) return '';
    return this.session.token;
  }

  message(data) {
    if (Buffer.compare(EMPTY_PACKET, data) === 0) {
      this.send('{}');
      return;
    }
    const packet = metautil.jsonParse(data);
    if (!packet) {
      const error = new Error('JSON parsing error');
      this.error(400, { error, pass: true });
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = parseInt(packet[callType], 10);
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      this.rpc(callId, interfaceName, methodName, args);
      return;
    }
    const error = new Error('Packet structure error');
    this.error(400, { callId, error, pass: true });
  }

  async rpc(callId, interfaceName, methodName, args) {
    const { application, session, client } = this;
    const [iname, ver = '*'] = interfaceName.split('.');
    const proc = application.getMethod(iname, ver, methodName);
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    try {
      await proc.enter();
    } catch {
      this.error(503, { callId });
      return;
    }
    const context = session ? session.context : { client };
    if (!this.session && proc.access !== 'public') {
      this.error(403, { callId });
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      const timedout = error.message === 'Timeout reached';
      const code = timedout ? 408 : 500;
      this.error(code, { callId, error, pass: timedout });
      return;
    } finally {
      proc.leave();
    }
    if (typeof result === 'object' && result.constructor.name === 'Error') {
      this.error(result.code, { callId, error: result, pass: true });
      return;
    }
    this.send({ callback: callId, result });
    const record = `${this.ip}\t${interfaceName}/${methodName}`;
    application.console.log(record);
  }

  error(code, { callId, error = null, pass = false } = {}) {
    const { req, ip, application } = this;
    const { url, method } = req;
    const status = http.STATUS_CODES[code];
    const message = pass ? error.message : status || 'Unknown error';
    const httpCode = status ? code : 500;
    const reason = `${httpCode}\t${error ? error.stack : status}`;
    application.console.error(`${ip}\t${method}\t${url}\t${reason}`);
    const packet = { callback: callId, error: { message, code } };
    this.send(packet, httpCode);
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

  destroy() {
    channels.delete(this.client);
    for (const callback of this.client.events.close) callback();
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

module.exports = { Channel, channels };
