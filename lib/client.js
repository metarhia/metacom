'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const transport = { http, https };
const WebSocket = require('ws');

const FORCE_CLOSE_CODE = 1000;
const RECONNECT_TIMEOUT = 3000;

class MetacomInterface {
  constructor() {
    this._events = new Map();
  }

  on(name, fn) {
    const event = this._events.get(name);
    if (event) event.add(fn);
    else this._events.set(name, new Set([fn]));
  }

  emit(name, ...args) {
    const event = this._events.get(name);
    if (!event) return;
    for (const fn of event.values()) fn(...args);
  }
}

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
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this._initSocket();
  }

  _initSocket() {
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        this.message(data);
        return;
      }
    });

    this.socket.addEventListener(
      'error',
      (err) => this.emit('error', err),
      { once: true }
    );

    this.socket.addEventListener(
      'open',
      event => this.emit('ready', event),
      { once: true }
    );

    this.socket.addEventListener(
      'close',
      event => {
        this.emit('close', event)
        setImmediate(() => this._onClose(event.code === FORCE_CLOSE_CODE))
      },
      { once: true }
    );
  }

  _onClose(forceClose) {
    if (!forceClose) {
      setTimeout(() => this._initSocket(), RECONNECT_TIMEOUT);
    }
  }

  message(data) {
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
        const { name, size, status } = packet;
        if (name) {
          const stream = { name, size, chunks: [], received: 0 };
          this.streams.set(callId, stream);
          return;
        }
        const stream = this.streams.get(callId);
        if (status) {
          this.streams.delete(callId);
          const blob = new Blob(stream.chunks);
          blob.text().then((text) => {
            console.log({ text });
          });
          return;
        }
      }
    }
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
      const methods = new MetacomInterface();
      const iface = introspection[interfaceName];
      const request = this.socketCall(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[interfaceName] = methods;
    }
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
