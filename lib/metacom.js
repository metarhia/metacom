'use strict';

const https = require('https');
const WebSocket = require('ws');

const fetch = (url, options) =>
  new Promise((resolve, reject) => {
    options.rejectUnauthorized = false;
    const req = https.request(url, options, async res => {
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

module.exports = class Metacom {
  constructor(host) {
    this.host = host;
    this.socket = new WebSocket('wss://' + host);
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.socket.addEventListener('message', ({ data }) => {
      try {
        const packet = JSON.parse(data);
        const { callback, event } = packet;
        const callId = callback || event;
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        if (packet.error) {
          const { code, message } = packet.error;
          const error = new Error(message);
          error.code = code;
          reject(error);
          return;
        }
        resolve(packet.result);
      } catch (err) {
        console.error(err);
      }
    });
  }

  ready() {
    return new Promise(resolve => {
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

  httpCall(iname, ver) {
    return methodName => (args = {}) => {
      const callId = ++this.callId;
      const interfaceName = ver ? `${iname}.${ver}` : iname;
      const target = interfaceName + '/' + methodName;
      const packet = { call: callId, [target]: args };
      const url = `https://${this.host}/api`;
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      });
    };
  }

  socketCall(iname, ver) {
    return methodName => async (args = {}) => {
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
};
