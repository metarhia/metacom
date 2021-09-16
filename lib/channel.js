'use strict';

const metautil = require('metautil');
const {
  MetacomReadable,
  MetacomWritable,
  MetacomChunk,
} = require('./streams.js');

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
    const packet = { event: --this.eventId, [name]: data };
    const channel = channels.get(this);
    if (!channel.connection) {
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

  createStream(name, size) {
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
    const [callType] = Object.keys(packet);
    if (callType === 'call') this.handleRpcPacket(packet);
    else if (callType === 'stream') void this.handleStreamPacket(packet);
    else this.error(400, new Error('Packet structure error'));
  }

  binary(data) {
    try {
      const { streamId, payload } = MetacomChunk.decode(data);
      const upstream = this.client.streams.get(streamId);
      if (upstream) {
        upstream.push(payload);
      } else {
        this.error(400, new Error(`Stream ${streamId} is not initialized`));
      }
    } catch (error) {
      this.error(400, error);
    }
  }

  handleRpcPacket(packet) {
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      const [interfaceName, methodName] = target.split('/');
      void this.rpc(callId, interfaceName, methodName, args);
    } else {
      this.error(400, new Error('Rpc packet structure error'));
    }
  }

  async handleStreamPacket(packet) {
    const { stream: streamId, name, size, status } = packet;
    const stream = this.client.streams.get(streamId);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        this.error(400, new Error(`Stream ${name} is already initialized`));
      } else {
        const streamData = { streamId, name, size };
        const stream = new MetacomReadable(streamData);
        this.client.streams.set(streamId, stream);
      }
    } else if (!stream) {
      this.error(400, new Error(`Stream ${streamId} is not initialized`));
    } else if (status === 'end') {
      await stream.close();
      this.client.streams.delete(streamId);
    } else if (status === 'terminate') {
      await stream.terminate();
      this.client.streams.delete(streamId);
    } else {
      this.error(400, new Error('Stream packet structure error'));
    }
  }

  async rpc(callId, interfaceName, methodName, args) {
    const { application, session, client } = this;
    const [iname, ver = '*'] = interfaceName.split('.');
    const proc = application.getMethod(iname, ver, methodName);
    if (!proc) {
      this.error(404, null, callId);
      return;
    }
    try {
      await proc.enter();
    } catch {
      this.error(504, null, callId);
      return;
    }
    const context = session ? session.context : { client };
    if (!this.session && proc.access !== 'public') {
      this.error(403, null, callId);
      return;
    }
    let result = null;
    try {
      result = await proc.invoke(context, args);
    } catch (err) {
      const code = err.message === 'Timeout reached' ? 408 : 500;
      this.error(code, err, callId);
      return;
    } finally {
      proc.leave();
    }
    if (typeof result === 'object' && result instanceof Error) {
      this.error(result.code, result, callId);
      return;
    }
    this.send({ callback: callId, result });
    const record = `${this.ip}\t${interfaceName}/${methodName}`;
    application.console.log(record);
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
