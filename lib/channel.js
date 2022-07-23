'use strict';

const http = require('http');
const metautil = require('metautil');
const {
  MetacomReadable,
  MetacomWritable,
  MetacomChunk,
} = require('./streams.js');

const DELIVERY_STATUS_IN_PROCESS = 1;
const DELIVERY_STATUS_END = 0;
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
    this.eventId = 0;
    this.streams = new Map();
    this.streamId = 0;
  }

  redirect(location) {
    const channel = channels.get(this);
    if (channel) channel.redirect(location);
  }

  get ip() {
    const channel = channels.get(this);
    return channel ? channel.ip : undefined;
  }

  on(name, callback) {
    if (name !== 'close') return;
    this.events.close.push(callback);
  }

  emit(name, data) {
    const packet = { event: --this.eventId, [name]: data };
    const channel = channels.get(this);
    if (!channel || !channel.connection) {
      throw new Error(`Can't send metacom events to http transport`);
    }
    channel.send(packet);
  }

  getStream(streamId) {
    const channel = channels.get(this);
    if (!channel.connection) {
      throw new Error(`Can't receive stream from http transport`);
    }
    const stream = this.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size = 1) {
    const channel = channels.get(this);
    if (!channel.connection) {
      throw new Error(`Can't send metacom streams to http transport`);
    }
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const streamId = --this.streamId;
    const initData = { streamId, name, size };
    const transport = channel.connection;
    return new MetacomWritable(transport, initData);
  }

  startSession(token, data = {}) {
    const channel = channels.get(this);
    if (!channel) return false;
    if (channel.session) sessions.delete(channel.session.token);
    const session = new Session(token, channel, data);
    channel.session = session;
    sessions.set(token, session);
    return true;
  }

  restoreSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    const channel = channels.get(this);
    if (!channel) return false;
    channel.session = session;
    return true;
  }

  deleteSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    const channel = channels.get(this);
    if (!channel.session) return false;
    sessions.delete(channel.session.token);
    channel.session = null;
    return true;
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
      this.error(500, { error, pass: true });
      return;
    }
    const [callType] = Object.keys(packet);
    if (callType === 'call') {
      this.handleRpcPacket(packet);
      return;
    } else if (callType === 'stream') {
      this.handleStreamPacket(packet);
      return;
    }
    const error = new Error('Packet structure error');
    this.error(500, { error, pass: true });
  }

  async binary(data) {
    try {
      const { streamId, deliveryStatus, payload } = MetacomChunk.decode(data);
      const upstream = this.client.streams.get(streamId);
      if (upstream) {
        if (deliveryStatus === DELIVERY_STATUS_END) {
          await upstream.close();
          this.client.streams.delete(streamId);
        } else if (deliveryStatus === DELIVERY_STATUS_IN_PROCESS) {
          upstream.push(payload);
        }
      } else {
        const error = new Error(`Stream ${streamId} is not initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      }
    } catch (error) {
      this.error(400, { callId: 0, error });
    }
  }

  handleRpcPacket(packet) {
    const [callType, target] = Object.keys(packet);
    const callId = parseInt(packet[callType], 10);
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      void this.rpc(callId, interfaceName, methodName, args);
      return;
    }
    const error = new Error('Packet structure error');
    this.error(400, { callId, error, pass: true });
  }

  async handleStreamPacket(packet) {
    const { stream: streamId, name, size, status } = packet;
    const stream = this.client.streams.get(streamId);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        const error = new Error(`Stream ${name} is already initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      } else {
        const streamData = { streamId, name, size };
        const stream = new MetacomReadable(streamData);
        this.client.streams.set(streamId, stream);
      }
    } else if (!stream) {
      const error = new Error(`Stream ${streamId} is not initialized`);
      this.error(400, { callId: streamId, error, pass: true });
    } else if (status === 'end') {
      await stream.close();
      this.client.streams.delete(streamId);
    } else if (status === 'terminate') {
      await stream.terminate();
      this.client.streams.delete(streamId);
    } else {
      const error = new Error('Stream packet structure error');
      this.error(400, { callId: streamId, error, pass: true });
    }
  }

  async rpc(callId, interfaceName, methodName, args) {
    const { application, session, client } = this;
    const [iname, ver = '*'] = interfaceName.split('.');
    const proc = application.getMethod(iname, ver, methodName);
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    const context = session ? session.context : { client };
    if (!this.session && proc.access !== 'public') {
      this.error(403, { callId });
      return;
    }
    try {
      await proc.enter();
    } catch {
      this.error(503, { callId });
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (error) {
      if (error.message === 'Timeout reached') {
        error.code = error.httpCode = 408;
      }
      this.error(error.code, { callId, error });
      return;
    } finally {
      proc.leave();
    }
    if (result?.constructor?.name === 'Error') {
      const { code, httpCode } = result;
      this.error(code, { callId, error: result, httpCode: httpCode || 200 });
      return;
    }
    this.send({ callback: callId, result });
    const record = `${this.ip}\t${interfaceName}/${methodName}`;
    application.console.log(record);
  }

  error(code = 500, { callId, error = null, httpCode = null } = {}) {
    const { req, ip, application } = this;
    const { url, method } = req;
    if (!httpCode) httpCode = (error && error.httpCode) || code;
    const status = http.STATUS_CODES[httpCode];
    const pass = httpCode < 500 || httpCode > 599;
    const message = pass && error ? error.message : status || 'Unknown error';
    const reason = `${httpCode}\t${code}\t${error ? error.stack : status}`;
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
