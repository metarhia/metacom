'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Connection } = require('./connection.js');
const { CLOSE_CODES } = require('./constants.js');

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_INTERVAL_MS = 10000;
const SERVER_REQUIRED = 'options.server (instance of http.Server) is required';
const EOL = '\r\n';
const EOL2 = '\r\n\r\n';
const UPGRADE = [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Accept: ',
].join(EOL);

const hasToken = (value, token) => {
  if (!value) return false;
  return value.toLowerCase().includes(token);
};

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
  const status = `HTTP/1.1 ${code} ${message}`;
  const lines = [status, 'Connection: close'].concat(extraHeaders);
  writeResponse(socket, lines);
  socket.destroy();
};

const isValidSecWebSocketKey = (key) => {
  if (typeof key !== 'string' || key.length !== 24) return false;
  const decoded = Buffer.from(key, 'base64');
  return decoded.length === 16;
};

const getPathname = (url) => {
  if (!url) return '/';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
};

class WebsocketServer extends EventEmitter {
  #options = null;
  #heartbeats = new Map();
  #pingTimer = null;

  constructor({ server, ...options } = {}) {
    super();
    if (!server || typeof server.on !== 'function') {
      throw new TypeError(`WebsocketServer: ${SERVER_REQUIRED}`);
    }
    this.#options = { pingInterval: PING_INTERVAL_MS, ...options };
    this.#init(server);
  }

  #init(server) {
    const { pingInterval } = this.#options;
    this.#pingTimer = setInterval(() => {
      for (const entry of this.#heartbeats) {
        const connection = entry[0];
        const heartbeat = entry[1];
        if (heartbeat.awaiting) {
          connection.terminate();
          this.#heartbeats.delete(connection);
          continue;
        }
        heartbeat.awaiting = true;
        connection.sendPing();
      }
    }, pingInterval);
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {
        socket.destroy();
      });
      try {
        this.#handleUpgrade(req, socket, head);
      } catch (error) {
        this.emit('error', error);
        abort(socket, 500, 'Internal Server Error');
      }
    });
    server.on('error', (error) => {
      const wsHasListeners = this.listenerCount('error') > 0;
      const httpHasOtherListeners = server.listenerCount('error') > 1;
      if (wsHasListeners || !httpHasOtherListeners) {
        this.emit('error', error);
      }
    });
    server.on('close', () => {
      clearInterval(this.#pingTimer);
      for (const connection of this.#heartbeats.keys()) {
        connection.sendClose('Server is closing', CLOSE_CODES['Going away']);
      }
      this.#heartbeats.clear();
      this.emit('close');
    });
  }

  #handleUpgrade(req, socket, head) {
    const { path, verifyClient } = this.#options;
    const { host, upgrade, connection } = req.headers;
    const pathname = getPathname(req.url);
    if (path !== undefined && pathname !== path) {
      return void abort(socket, 404, 'Not Found');
    }
    if (verifyClient) {
      const accepted = verifyClient({ req, socket, head });
      if (!accepted) return void abort(socket, 403, 'Forbidden');
    }
    // Enforce HTTP/1.1 per RFC 6455
    if (req.httpVersion !== '1.1') {
      return void abort(socket, 505, 'HTTP Version Not Supported');
    }
    // HTTP/1.1 requires Host header (RFC 7230 / RFC 9110)
    if (!host) {
      return void abort(socket, 400, 'Missing Host header');
    }
    if (req.method !== 'GET') {
      return void abort(socket, 405, 'Method Not Allowed');
    }
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return void abort(socket, 400, 'Invalid Upgrade header');
    }
    if (!hasToken(connection, 'upgrade')) {
      return void abort(socket, 400, 'Invalid Connection header');
    }
    const version = req.headers['sec-websocket-version'];
    if (version !== '13') {
      const extraHeaders = ['Sec-WebSocket-Version: 13'];
      return void abort(socket, 426, 'Upgrade Required', { extraHeaders });
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) return void abort(socket, 400, 'Missing Sec-WebSocket-Key');
    if (!isValidSecWebSocketKey(key)) {
      return void abort(socket, 400, 'Invalid Sec-WebSocket-Key');
    }
    const hash = crypto.createHash('sha1').update(key).update(MAGIC);
    const accept = hash.digest('base64');
    sendUpgrade(socket, accept);

    const options = { ...this.#options, isClient: false };
    const client = new Connection(socket, head, options);
    this.#setupHeartbeat(client);
    this.emit('connection', client, req);
  }

  #setupHeartbeat(connection) {
    const heartbeat = { awaiting: false };
    this.#heartbeats.set(connection, heartbeat);
    connection.on('pong', () => {
      heartbeat.awaiting = false;
    });
    connection.on('error', () => void this.#heartbeats.delete(connection));
    connection.on('close', () => void this.#heartbeats.delete(connection));
  }
}

module.exports = { WebsocketServer, MAGIC, getPathname };
