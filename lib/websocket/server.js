'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Connection } = require('./connection.js');
const { MAGIC, EOL, EOL2, UPGRADE, PING_INTERVAL } = require('./constants.js');

const hasToken = (value, token) =>
  !!value && value.toLowerCase().includes(token);

const writeResponse = (socket, headerLines) => {
  socket.cork();
  socket.write(headerLines.join(EOL));
  socket.write(EOL2);
  socket.uncork();
};

const sendUpgrade = (socket, accept) => {
  socket.cork();
  socket.write(UPGRADE);
  socket.write(accept);
  socket.write(EOL2);
  socket.uncork();
};

const abort = (socket, code, message, { extraHeaders = [] } = {}) => {
  const lines = [
    `HTTP/1.1 ${code} ${message}`,
    'Connection: close',
    ...extraHeaders,
  ];
  writeResponse(socket, lines);
  socket.destroy();
};

const isValidSecWebSocketKey = (key) =>
  typeof key === 'string' &&
  key.length === 24 &&
  Buffer.from(key, 'base64').length === 16;
class WebsocketServer extends EventEmitter {
  #options;
  #connections = new Set();
  #heartbeats = new Map(); // { awaiting: boolean }
  #pingTimer;

  constructor({ server, ...opts } = {}) {
    super();
    if (!server || typeof server.on !== 'function') {
      throw new TypeError(
        'WebsocketServer: options.server (instance of http.Server) is required',
      );
    }
    this.#options = {
      pingInterval: PING_INTERVAL,
      ...opts,
    };
    this.#init(server);
  }

  #init(server) {
    const { pingInterval } = this.#options;
    this.#pingTimer = setInterval(() => {
      for (const ws of this.#connections) {
        const heartbeat = this.#heartbeats.get(ws);
        if (heartbeat.awaiting) {
          ws.terminate();
          this.#heartbeats.delete(ws);
        } else {
          heartbeat.awaiting = true;
          ws.sendPing();
        }
      }
    }, pingInterval);
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {
        socket.destroy();
      });
      try {
        this.#handleUpgrade(req, socket, head);
      } catch (err) {
        console.error(err);
        abort(socket, 500, 'Internal Server Error');
      }
    });
    server.on('error', (err) => {
      // Forward error to WebsocketServer if:
      // 1) WebsocketServer has its own 'error' listeners; or
      // 2) The underlying server has no other 'error' listeners.
      const wsHasListeners = this.listenerCount('error') > 0;
      const httpHasOtherListeners = server.listenerCount('error') > 1;
      if (wsHasListeners || !httpHasOtherListeners) {
        this.emit('error', err);
      }
    });
    server.on('close', () => {
      clearInterval(this.#pingTimer);
      for (const ws of this.#connections) {
        ws.sendClose(1001, 'Server is closing');
      }
      this.#connections.clear();
      this.#heartbeats.clear();
      this.emit('close');
    });
  }

  #handleUpgrade(req, socket, head) {
    // Enforce HTTP/1.1 per RFC 6455
    if (req.httpVersion !== '1.1') {
      return void abort(socket, 505, 'HTTP Version Not Supported');
    }
    // HTTP/1.1 requires Host header (RFC 7230 / RFC 9110)
    if (!req.headers.host) {
      return void abort(socket, 400, 'Missing Host header');
    }
    if (req.method !== 'GET') {
      return void abort(socket, 405, 'Method Not Allowed');
    }
    const upgrade = req.headers['upgrade'];
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return void abort(socket, 400, 'Invalid Upgrade header');
    }
    if (!hasToken(req.headers['connection'], 'upgrade')) {
      return void abort(socket, 400, 'Invalid Connection header');
    }
    const version = req.headers['sec-websocket-version'];
    if (version !== '13') {
      const options = { extraHeaders: ['Sec-WebSocket-Version: 13'] };
      return void abort(socket, 426, 'Upgrade Required', options);
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) return void abort(socket, 400, 'Missing Sec-WebSocket-Key');
    if (!isValidSecWebSocketKey(key)) {
      return void abort(socket, 400, 'Invalid Sec-WebSocket-Key');
    }
    const accept = crypto
      .createHash('sha1')
      .update(key)
      .update(MAGIC)
      .digest('base64');
    sendUpgrade(socket, accept);

    const ws = new Connection(socket, head, {
      ...this.#options,
      isClient: false,
    });
    this.#setupHeartbeat(ws);
    this.emit('connection', ws, req);
  }

  #setupHeartbeat(ws) {
    this.#heartbeats.set(ws, { awaiting: false });
    this.#connections.add(ws);
    ws.on('pong', () => {
      const heartbeat = this.#heartbeats.get(ws);
      heartbeat.awaiting = false;
    });
    ws.on('close', () => {
      this.#connections.delete(ws);
      this.#heartbeats.delete(ws);
    });
  }
}

module.exports = { WebsocketServer };
