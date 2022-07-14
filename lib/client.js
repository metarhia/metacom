'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const transport = { http, https };
const WebSocket = require('ws');
const { MetacomWritable, MetacomReadable, MetacomChunk } = require('./streams');

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

const fetch = (url, options) => {
  const dest = new URL(url);
  return new Promise((resolve, reject) => {
    const protocol = transport[dest.protocol.slice(0, -1)];
    const req = protocol.request(url, options, async (res) => {
      const buffers = [];
      for await (const chunk of res) {
        buffers.push(chunk);
      }
      resolve(Buffer.concat(buffers).toString());
    });
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
};

class Metacom extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = new WebSocket(url);
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.streamId = 0;
    this.streams = new Map();
    this.socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') void this.message(data);
      else void this.binary(data);
    });
    this.socket.addEventListener('close', () => {
      this.connected = false;
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });
    this.socket.addEventListener('error', (err) => {
      this.emit('error', err);
      this.socket.close();
    });
  }

  async message(data) {
    if (data === '{}') return;
    this.lastActivity = new Date().getTime();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      if (callType === 'callback') {
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        this.calls.delete(callId);
        if (packet.error) {
          reject(new MetacomError(packet.error));
          return;
        }
        resolve(args);
        return;
      }
      if (callType === 'event') {
        const [interfaceName, eventName] = target.split('/');
        const metacomInterface = this.api[interfaceName];
        metacomInterface.emit(eventName, args);
      }
      if (callType === 'stream') {
        const { stream: streamId, name, size, status } = packet;
        const stream = this.streams.get(streamId);
        if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
          if (stream) {
            console.error(new Error(`Stream ${name} is already initialized`));
          } else {
            const streamData = { streamId, name, size };
            const stream = new MetacomReadable(streamData);
            this.streams.set(streamId, stream);
          }
        } else if (!stream) {
          console.error(new Error(`Stream ${streamId} is not initialized`));
        } else if (status === 'end') {
          await stream.close();
          this.streams.delete(streamId);
        } else if (status === 'terminate') {
          await stream.terminate();
          this.streams.delete(streamId);
        } else {
          console.error(new Error('Stream packet structure error'));
        }
      }
    }
  }

  async binary(buffer) {
    const byteView = new Uint8Array(buffer);
    const { streamId, payload } = MetacomChunk.decode(byteView);
    const stream = this.streams.get(streamId);
    if (stream) await stream.push(payload);
    else console.warn(`Stream ${streamId} is not initialized`);
  }

  static create(url) {
    return new Metacom(url);
  }

  ready() {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.OPEN) resolve();
      else this.socket.addEventListener('open', resolve);
    });
  }

  async load(...interfaces) {
    const introspect = this.httpCall('system')('introspect');
    const introspection = await introspect(interfaces);
    const available = Object.keys(introspection);
    for (const interfaceName of interfaces) {
      if (!available.includes(interfaceName)) continue;
      const methods = {};
      const iface = introspection[interfaceName];
      const request = this.socketCall(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[interfaceName] = methods;
    }
  }

  getStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size) {
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const streamId = ++this.streamId;
    const initData = { streamId, name, size };
    const transport = this.socket;
    return new MetacomWritable(transport, initData);
  }

  createBlobUploader(blob) {
    const name = blob.name || 'blob';
    const size = blob.size;
    const consumer = this.createStream(name, size);
    return {
      streamId: consumer.streamId,
      upload: async () => {
        const reader = blob.stream().getReader();
        let chunk;
        while (!(chunk = await reader.read()).done) {
          consumer.write(chunk.value);
        }
        consumer.end();
      },
    };
  }

  httpCall(iname, ver) {
    return (methodName) =>
      (args = {}) => {
        const callId = ++this.callId;
        const interfaceName = ver ? `${iname}.${ver}` : iname;
        const target = interfaceName + '/' + methodName;
        const packet = { call: callId, [target]: args };
        const dest = new URL(this.url);
        const protocol = dest.protocol === 'ws:' ? 'http' : 'https';
        const url = `${protocol}://${dest.host}/api`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(packet),
        }).then((json) => {
          const packet = JSON.parse(json);
          if (packet.error) throw new MetacomError(packet.error);
          return packet.result;
        });
      };
  }

  socketCall(iname, ver) {
    return (methodName) =>
      async (args = {}) => {
        const callId = ++this.callId;
        const interfaceName = ver ? `${iname}.${ver}` : iname;
        const target = interfaceName + '/' + methodName;
        await this.ready();
        return new Promise((resolve, reject) => {
          this.calls.set(callId, [resolve, reject]);
          const packet = { call: callId, [target]: args };
          this.socket.send(JSON.stringify(packet));
        });
      };
  }
}

module.exports = { Metacom };
