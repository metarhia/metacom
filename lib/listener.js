'use strict';

const dgram = require('node:dgram');
const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');

const STUN_COOKIE = 0x2112a442;
const STUN_HEADER_BYTES = 8;
const PREFIX_LIMIT = 16 * 1024;
const TLS_RECORD = 0x16;
const TLS_HEADER_BYTES = 5;
const HANDSHAKE_HEADER_BYTES = 4;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const HELLO_FIXED_BYTES = 34;
const EXT_SERVER_NAME = 0x0000;
const EXT_ALPN = 0x0010;
const SNI_HOST_NAME = 0;
const SNI_HEADER_BYTES = 5;
const STUN_TYPE_LIMIT = 0x40;
const CHANNEL_MIN = 0x40;
const CHANNEL_MAX = 0x4f;
const DEFAULT_BIND_MS = 2000;
const DEFAULT_REQUEST_MS = 5000;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const MISDIRECTED = Buffer.from(
  'HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n',
);
const UNRECOGNIZED_ALERT = Buffer.from([
  0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70,
]);
const TCP_PROTOCOLS = ['h2', 'http/1.1', 'stun.turn', 'stun.nat-discovery'];
const STUN_PROTOCOLS = ['stun.turn', 'stun.nat-discovery'];
const HTTP_ALPN = ['h2', 'http/1.1'];
const KEEP_KINDS = ['stun', 'http', 'tls'];
const EMPTY = Buffer.alloc(0);
const HELLO_WAIT = { status: 'wait', servername: '', alpn: [] };
const HELLO_BAD = { status: 'bad', servername: '', alpn: [] };
const SILENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECANCELED',
  'ERR_STREAM_DESTROYED',
  'unrecognized_name',
]);

const isTcpProtocol = (id) => TCP_PROTOCOLS.includes(id);

const isStunProtocol = (id) => STUN_PROTOCOLS.includes(id);

const transportsFor = (protocols) => {
  const transports = [];
  if (protocols.some(isTcpProtocol)) transports.push('tcp');
  if (protocols.some(isStunProtocol)) transports.push('udp');
  return transports;
};

const listOf = (value) => (Array.isArray(value) ? value.slice() : []);

const stunId = (protocols) => {
  const id = STUN_PROTOCOLS.find((protocol) => protocols.includes(protocol));
  return id ?? '';
};

const isStunMessage = (buffer) => {
  if (buffer.length < STUN_HEADER_BYTES) return false;
  if (buffer[0] >= STUN_TYPE_LIMIT) return false;
  return buffer.readUInt32BE(4) === STUN_COOKIE;
};

const isChannelByte = (first) => first >= CHANNEL_MIN && first <= CHANNEL_MAX;

const readUInt24BE = (buffer, offset) => {
  const high = buffer[offset];
  const mid = buffer[offset + 1];
  const low = buffer[offset + 2];
  return high * 65536 + mid * 256 + low;
};

const fits = (offset, count, end) => offset + count <= end;

const helloResult = (status, servername, alpn) => ({
  status,
  servername,
  alpn,
});

const readServerName = (buffer, offset, length) => {
  const missing = { ok: false, name: '' };
  if (length < SNI_HEADER_BYTES) return missing;
  const listLength = buffer.readUInt16BE(offset);
  const listFits = listLength + 2 <= length;
  if (!listFits) return missing;
  const nameType = buffer[offset + 2];
  if (nameType !== SNI_HOST_NAME) return { ok: true, name: '' };
  const nameLength = buffer.readUInt16BE(offset + 3);
  const nameFits = nameLength + SNI_HEADER_BYTES <= length;
  if (!nameFits) return missing;
  const start = offset + SNI_HEADER_BYTES;
  const name = buffer.toString('utf8', start, start + nameLength);
  return { ok: true, name };
};

const readAlpn = (buffer, offset, length) => {
  if (length < 2) return null;
  const listLength = buffer.readUInt16BE(offset);
  const listFits = listLength + 2 <= length;
  if (!listFits) return null;
  const names = [];
  let cursor = offset + 2;
  const end = cursor + listLength;
  while (cursor < end) {
    const nameLength = buffer[cursor];
    const start = cursor + 1;
    const stop = start + nameLength;
    if (stop > end) return null;
    names.push(buffer.toString('utf8', start, stop));
    cursor = stop;
  }
  return names;
};

const readExtensions = (buffer, start, end) => {
  if (!fits(start, 2, end)) return HELLO_BAD;
  const length = buffer.readUInt16BE(start);
  let offset = start + 2;
  const extEnd = offset + length;
  if (extEnd > end) return HELLO_BAD;
  let servername = '';
  let alpn = [];
  while (fits(offset, 4, extEnd)) {
    const type = buffer.readUInt16BE(offset);
    const size = buffer.readUInt16BE(offset + 2);
    const data = offset + 4;
    if (!fits(data, size, extEnd)) return HELLO_BAD;
    if (type === EXT_SERVER_NAME) {
      const parsed = readServerName(buffer, data, size);
      if (!parsed.ok) return HELLO_BAD;
      if (servername === '') servername = parsed.name;
    }
    if (type === EXT_ALPN) {
      const names = readAlpn(buffer, data, size);
      if (!names) return HELLO_BAD;
      alpn = alpn.concat(names);
    }
    offset = data + size;
  }
  return helloResult('ok', servername, alpn);
};

const parseClientHello = (buffer, recordEnd) => {
  const header = TLS_HEADER_BYTES;
  const minHello = header + HANDSHAKE_HEADER_BYTES;
  if (recordEnd < minHello) return HELLO_BAD;
  if (buffer[header] !== HANDSHAKE_CLIENT_HELLO) return HELLO_BAD;
  const length = readUInt24BE(buffer, header + 1);
  const end = minHello + length;
  if (end > recordEnd) return HELLO_BAD;
  let offset = minHello;
  if (!fits(offset, HELLO_FIXED_BYTES, end)) return HELLO_BAD;
  offset += HELLO_FIXED_BYTES;
  if (!fits(offset, 1, end)) return HELLO_BAD;
  const sessionLength = buffer[offset];
  offset += 1;
  if (!fits(offset, sessionLength, end)) return HELLO_BAD;
  offset += sessionLength;
  if (!fits(offset, 2, end)) return HELLO_BAD;
  const cipherLength = buffer.readUInt16BE(offset);
  offset += 2;
  if (!fits(offset, cipherLength, end)) return HELLO_BAD;
  offset += cipherLength;
  if (!fits(offset, 1, end)) return HELLO_BAD;
  const methodLength = buffer[offset];
  offset += 1;
  if (!fits(offset, methodLength, end)) return HELLO_BAD;
  offset += methodLength;
  if (offset === end) return helloResult('ok', '', []);
  return readExtensions(buffer, offset, end);
};

const readClientHello = (buffer) => {
  if (buffer.length < TLS_HEADER_BYTES) return HELLO_WAIT;
  if (buffer[0] !== TLS_RECORD) return HELLO_BAD;
  const payloadLength = buffer.readUInt16BE(3);
  const recordEnd = TLS_HEADER_BYTES + payloadLength;
  const overPayload = payloadLength > PREFIX_LIMIT;
  const overRecord = recordEnd > PREFIX_LIMIT;
  if (overPayload || overRecord) return HELLO_BAD;
  if (buffer.length < recordEnd) return HELLO_WAIT;
  return parseClientHello(buffer, recordEnd);
};

const offersHttp1 = (protocols) => {
  const h2 = protocols.includes('h2');
  const http1 = protocols.includes('http/1.1');
  return h2 || http1;
};

const withHttp1 = (protocols) => {
  const http = offersHttp1(protocols);
  const listed = protocols.includes('http/1.1');
  if (!http || listed) return protocols;
  return protocols.concat(['http/1.1']);
};

const selectAlpn = (protocols, offered) => {
  const candidates = withHttp1(protocols);
  if (offered.length === 0) return { chosen: '', matched: true };
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    if (offered.includes(id)) return { chosen: id, matched: true };
  }
  return { chosen: '', matched: false };
};

const classifyDecrypted = (buffer) => {
  if (buffer.length === 0) return 'wait';
  if (buffer[0] >= STUN_TYPE_LIMIT) return 'http';
  if (buffer.length < STUN_HEADER_BYTES) return 'wait';
  if (isStunMessage(buffer)) return 'stun';
  return 'http';
};

const classifyUdp = (buffer, protocols) => {
  if (buffer.length === 0) return '';
  const first = buffer[0];
  if (isChannelByte(first)) {
    const listed = protocols.includes('stun.turn');
    return listed ? 'stun.turn' : '';
  }
  if (!isStunMessage(buffer)) return '';
  return stunId(protocols);
};

const classifyHello = (buffer) => {
  const hello = readClientHello(buffer);
  if (hello.status === 'wait') {
    if (buffer.length > PREFIX_LIMIT) return 'destroy';
    return 'wait';
  }
  if (hello.status !== 'ok') return 'destroy';
  return 'tls';
};

const normalizeDomain = (name) => {
  const text = typeof name === 'string' ? name : '';
  const lower = text.toLowerCase();
  if (!lower.endsWith('.')) return lower;
  return lower.slice(0, -1);
};

const matchPattern = (pattern, name) => {
  const rule = `${pattern}`.toLowerCase();
  const wildcard = rule.startsWith('*.');
  if (wildcard) {
    const suffix = rule.slice(1);
    if (!name.endsWith(suffix)) return false;
    const label = name.slice(0, name.length - suffix.length);
    if (label.length === 0) return false;
    return !label.includes('.');
  }
  const rooted = rule.startsWith('.');
  if (rooted) {
    const root = rule.slice(1);
    if (name === root) return true;
    return name.endsWith(rule);
  }
  return name === rule;
};

const matchDomain = (patterns, name) => {
  const listed = Array.isArray(patterns) && patterns.length > 0;
  if (!listed) return true;
  const host = normalizeDomain(name);
  for (let i = 0; i < patterns.length; i++) {
    if (matchPattern(patterns[i], host)) return true;
  }
  return false;
};

const hostName = (value) => {
  const text = value.trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return text;
    return text.slice(1, end);
  }
  const colon = text.lastIndexOf(':');
  if (colon <= 0) return text;
  const port = text.slice(colon + 1);
  if (port.length === 0) return text;
  for (let i = 0; i < port.length; i++) {
    const code = port.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    if (!digit) return text;
  }
  return text.slice(0, colon);
};

const headerField = (buffer, name) => {
  const end = buffer.indexOf(HEADER_END);
  const limit = end === -1 ? buffer.length : end;
  const prefix = `${name}:`;
  let start = 0;
  while (start < limit) {
    let stop = buffer.indexOf(CRLF, start);
    if (stop === -1 || stop > limit) stop = limit;
    const line = buffer.toString('latin1', start, stop);
    const field = line.toLowerCase();
    if (field.startsWith(prefix)) return line.slice(prefix.length).trim();
    if (stop === limit) break;
    start = stop + CRLF.length;
  }
  return '';
};

const hostAllowed = (patterns, buffer) => {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const value = headerField(buffer, 'host');
  const name = hostName(value);
  return matchDomain(patterns, name);
};

const refuseMisdirected = (socket) => {
  socket.end(MISDIRECTED);
};

const classifyTcp = (buffer) => {
  if (buffer.length === 0) return 'wait';
  if (buffer[0] === TLS_RECORD) return classifyHello(buffer);
  if (isStunMessage(buffer)) return 'stun';
  const blank = buffer.indexOf(HEADER_END);
  if (blank !== -1) return 'http';
  if (buffer.length > PREFIX_LIMIT) return 'destroy';
  return 'wait';
};

const cappedConcat = (head, chunk) => {
  const total = head.length + chunk.length;
  if (total <= PREFIX_LIMIT) return Buffer.concat([head, chunk]);
  const room = PREFIX_LIMIT + 1 - head.length;
  const fitting = room > 0 ? chunk.subarray(0, room) : EMPTY;
  const prefix = room > 0 ? Buffer.concat([head, fitting]) : head;
  const kind = classifyTcp(prefix);
  if (KEEP_KINDS.includes(kind)) return Buffer.concat([head, chunk]);
  if (room > 0) return prefix;
  return head;
};

const reportError = (output, error) => {
  const code = error.code ?? '';
  if (SILENT_CODES.has(code)) return;
  output.error(error);
};

const connectionInfo = (socket, tls, servername, alpn) => {
  const port = socket.localPort ?? 0;
  const transport = 'tcp';
  const address = socket.remoteAddress ?? '';
  const remotePort = socket.remotePort ?? 0;
  const remote = { address, port: remotePort };
  return { port, transport, tls, servername, alpn, remote };
};

const tcpInfo = (socket) => connectionInfo(socket, false, '', '');

const appendChunk = (head, chunk) => Buffer.concat([head, chunk]);

// First bytes choose the protocol, a socket that stays silent is dropped
const sniff = (socket, timeoutMs, append, classify, onKind) => {
  let settled = false;
  let head = EMPTY;
  const onTimeout = () => {
    settled = true;
    socket.destroy();
  };
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref();
  const onData = (chunk) => {
    if (settled) return;
    head = append(head, chunk);
    const kind = classify(head);
    if (kind === 'wait') return;
    settled = true;
    clearTimeout(timer);
    socket.off('data', onData);
    onKind(head, kind);
  };
  socket.on('data', onData);
  socket.on('close', () => clearTimeout(timer));
};

const httpServerOf = (handler) => {
  if (handler instanceof http.Server) return handler;
  const server = handler.httpServer ?? null;
  return server instanceof http.Server ? server : null;
};

const connectionOf = (handler) => {
  if (typeof handler.connection === 'function') {
    return (socket, info) => handler.connection(socket, info);
  }
  const server = httpServerOf(handler);
  if (!server) return null;
  return (socket) => void server.emit('connection', socket);
};

// HTTP/2 requests go to a handler, its request method, or its httpServer
const requestOf = (handler) => {
  if (typeof handler === 'function') return handler;
  const isServer = handler instanceof http.Server;
  const server = isServer ? null : httpServerOf(handler);
  if (server) {
    return (request, response) => {
      server.emit('request', request, response);
    };
  }
  if (typeof handler.request !== 'function') return null;
  return (request, response) => handler.request(request, response);
};

const datagramOf = (handler) => {
  if (typeof handler.datagram !== 'function') return null;
  return (buffer, remote, socket) => handler.datagram(buffer, remote, socket);
};

const createRoute = (handler) => ({
  connection: connectionOf(handler),
  request: requestOf(handler),
  datagram: datagramOf(handler),
});

const isListed = (protocols, id) => {
  if (id === 'http/1.1') return offersHttp1(protocols);
  return protocols.includes(id);
};

// Listed protocols with handlers, HTTP/1.1 falls back to h2 HTTP server
const createRoutes = (handlers, protocols) => {
  const routes = new Map();
  const ids = Object.keys(handlers);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const handler = handlers[id];
    const isRouted = Boolean(handler) && isListed(protocols, id);
    if (isRouted) routes.set(id, createRoute(handler));
  }
  const fallback = handlers.h2 ?? null;
  const hasHttp1 = routes.has('http/1.1') || !offersHttp1(protocols);
  if (hasHttp1 || !fallback || !httpServerOf(fallback)) return routes;
  routes.set('http/1.1', createRoute(fallback));
  return routes;
};

const handoff = (socket, head, route, info) => {
  socket.pause();
  if (head.length > 0) socket.unshift(head);
  if (!route.connection) return void socket.destroy();
  route.connection(socket, info);
  socket.resume();
};

const passSocket = (server, socket, head) => {
  socket.pause();
  socket.unshift(head);
  server.emit('connection', socket);
};

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const closeUdp = (socket) =>
  new Promise((resolve) => {
    socket.once('close', () => resolve());
    try {
      socket.close();
    } catch (error) {
      const alreadyClosed = error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING';
      if (!alreadyClosed) throw error;
      resolve();
    }
  });

const closeEndpoint = (endpoint) => {
  if (endpoint.server) return closeServer(endpoint.server);
  return closeUdp(endpoint.socket);
};

const release = async (endpoints, sockets) => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(endpoints.map(closeEndpoint));
  sockets.clear();
};

const makeEndpoint = (transport, server, socket, info) => {
  const port = info.port;
  const address = info.address;
  return { transport, server, socket, port, address };
};

const describeEndpoint = (endpoint) => {
  const port = endpoint.port;
  const transport = endpoint.transport;
  const address = endpoint.address;
  return { port, transport, address };
};

const codedError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const untilListening = (emitter, timeoutMs, output, start) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (error) => {
      if (settled) {
        reportError(output, error);
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    timer = setTimeout(() => {
      fail(codedError('ETIMEDOUT', 'Bind timed out'));
    }, timeoutMs);
    emitter.once('listening', succeed);
    emitter.on('error', fail);
    try {
      start();
    } catch (error) {
      fail(error);
    }
  });

const bindTcp = async (port, host, timeoutMs, onConnection, output) => {
  const server = net.createServer(onConnection);
  try {
    await untilListening(server, timeoutMs, output, () => {
      server.listen(port, host);
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  const info = server.address();
  return makeEndpoint('tcp', server, null, info);
};

const bindUdp = async (type, address, port, timeoutMs, onMessage, output) => {
  const ipv6 = type === 'udp6';
  const options = { type, ipv6Only: ipv6 };
  const socket = dgram.createSocket(options);
  socket.on('message', (buffer, remote) => {
    onMessage(buffer, remote, socket);
  });
  try {
    await untilListening(socket, timeoutMs, output, () => {
      socket.bind({ port, address });
    });
  } catch (error) {
    try {
      await closeUdp(socket);
    } catch (closeError) {
      reportError(output, closeError);
    }
    throw error;
  }
  const info = socket.address();
  return makeEndpoint('udp', null, socket, info);
};

class Listener {
  ports = [];

  #host = '';
  #requested = [];
  #transports = [];
  #protocols = [];
  #tls = false;
  #secureContext = null;
  #domains = [];
  #contexts = new Map();
  #routes = null;
  #http2 = null;
  #tlsServer = null;
  #nagle = true;
  #bindTimeout = 0;
  #requestTimeout = 0;
  #output = null;
  #endpoints = [];
  #sockets = new Set();
  #accepting = false;
  #listening = false;
  #closing = null;

  constructor(options) {
    const protocols = listOf(options.protocols);
    const given = options.transports;
    const isGiven = Array.isArray(given);
    const { secureContext } = options;
    const isContext = typeof secureContext === 'function';
    const handlers = options.handlers ?? {};
    const timeouts = options.timeouts ?? {};
    this.#host = options.host ?? '0.0.0.0';
    this.#requested = listOf(options.ports);
    this.#transports = isGiven ? given.slice() : transportsFor(protocols);
    this.#protocols = protocols;
    this.#tls = options.tls === true;
    this.#secureContext = isContext ? secureContext : null;
    this.#domains = listOf(options.domains);
    this.#routes = createRoutes(handlers, protocols);
    this.#nagle = options.nagle ?? true;
    this.#bindTimeout = timeouts.bind ?? DEFAULT_BIND_MS;
    this.#requestTimeout = timeouts.request ?? DEFAULT_REQUEST_MS;
    this.#output = options.console ?? console;
  }

  async listen() {
    if (this.#closing) throw new Error('Listener is closed');
    if (this.#listening) throw new Error('Listener is already listening');
    let opened = [];
    try {
      const requested = this.#requested;
      const transports = this.#transports;
      for (let i = 0; i < requested.length; i++) {
        const port = requested[i];
        for (let j = 0; j < transports.length; j++) {
          const transport = transports[j];
          const bound = await this.#bind(port, transport);
          opened = opened.concat(bound);
        }
      }
      this.#endpoints = opened;
      this.ports = opened.map(describeEndpoint);
      this.#listening = true;
      this.#accepting = true;
    } catch (error) {
      this.#accepting = false;
      await release(opened, this.#sockets);
      throw error;
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = this.#shutdown();
    return this.#closing;
  }

  async #bind(port, transport) {
    if (transport === 'tcp') {
      const endpoint = await this.#bindTcp(port);
      return [endpoint];
    }
    if (transport === 'udp') return this.#bindUdp(port);
    throw new Error(`Unsupported transport: ${transport}`);
  }

  #bindTcp(port) {
    const host = this.#host;
    const timeoutMs = this.#bindTimeout;
    const output = this.#output;
    const onConnection = (socket) => this.#onConnection(socket);
    return bindTcp(port, host, timeoutMs, onConnection, output);
  }

  async #bindUdp(port) {
    const host = this.#host;
    const wildcard = host === '0.0.0.0' || host === '::';
    if (!wildcard) {
      const type = host.includes(':') ? 'udp6' : 'udp4';
      const endpoint = await this.#openUdp(type, host, port);
      return [endpoint];
    }
    const v4 = await this.#openUdp('udp4', '0.0.0.0', port);
    try {
      const v6 = await this.#openUdp('udp6', '::', v4.port);
      return [v4, v6];
    } catch (error) {
      try {
        await closeUdp(v4.socket);
      } catch (closeError) {
        reportError(this.#output, closeError);
      }
      throw error;
    }
  }

  #openUdp(type, address, port) {
    const timeoutMs = this.#bindTimeout;
    const output = this.#output;
    const onMessage = (buffer, remote, socket) => {
      this.#onDatagram(buffer, remote, socket);
    };
    return bindUdp(type, address, port, timeoutMs, onMessage, output);
  }

  #onConnection(socket) {
    const output = this.#output;
    socket.on('error', (error) => {
      reportError(output, error);
    });
    if (!this.#accepting) return void socket.destroy();
    if (this.#nagle === false) socket.setNoDelay(true);
    this.#sockets.add(socket);
    socket.on('close', () => {
      this.#sockets.delete(socket);
    });
    const timeoutMs = this.#requestTimeout;
    const onKind = (head, kind) => this.#route(socket, head, kind);
    sniff(socket, timeoutMs, cappedConcat, classifyTcp, onKind);
  }

  #route(socket, head, kind) {
    if (kind === 'tls') {
      this.#routeTls(socket, head);
      return;
    }
    const plain = kind === 'http' || kind === 'stun';
    const refused = kind === 'destroy' || (plain && this.#tls);
    if (refused) {
      socket.destroy();
      return;
    }
    const httpPlain = kind === 'http';
    if (httpPlain && !hostAllowed(this.#domains, head)) {
      refuseMisdirected(socket);
      return;
    }
    const id = kind === 'http' ? 'http/1.1' : stunId(this.#protocols);
    const route = this.#routes.get(id);
    if (!route) return void socket.destroy();
    handoff(socket, head, route, tcpInfo(socket));
  }

  #contextFor(servername) {
    const secureContext = this.#secureContext;
    if (!secureContext) return null;
    try {
      const context = secureContext(servername);
      return context ?? null;
    } catch (error) {
      reportError(this.#output, error);
      return null;
    }
  }

  #acceptSni(servername, callback) {
    const name = typeof servername === 'string' ? servername : '';
    const context = this.#contexts.get(name) ?? null;
    if (context) return void callback(null, context);
    callback(codedError('unrecognized_name', 'unrecognized_name'));
  }

  #terminalAlpn(offered) {
    const selection = selectAlpn(this.#protocols, offered);
    if (!selection.matched) return '';
    const chosen = selection.chosen;
    const isTerminal = isStunProtocol(chosen) || chosen === 'http/1.1';
    return isTerminal ? chosen : '';
  }

  #routeTls(socket, head) {
    const hello = readClientHello(head);
    if (hello.status !== 'ok') {
      socket.destroy();
      return;
    }
    const servername = hello.servername;
    const allowed = matchDomain(this.#domains, servername);
    const context = allowed ? this.#contextFor(servername) : null;
    if (!context) {
      socket.write(UNRECOGNIZED_ALERT);
      socket.destroy();
      return;
    }
    this.#contexts.set(servername, context);
    const selection = selectAlpn(this.#protocols, hello.alpn);
    if (!selection.matched) {
      socket.destroy();
      return;
    }
    if (selection.chosen === 'h2') {
      this.#handoffHttp2(socket, head);
      return;
    }
    this.#handoffTls(socket, head);
  }

  #openHttp2() {
    if (this.#http2) return this.#http2;
    const output = this.#output;
    const server = http2.createSecureServer({
      allowHTTP1: true,
      SNICallback: (name, callback) => this.#acceptSni(name, callback),
      ALPNProtocols: HTTP_ALPN.slice(),
    });
    const onError = (error) => {
      reportError(output, error);
    };
    server.on('error', onError);
    server.on('clientError', onError);
    server.on('sessionError', onError);
    server.on('session', (session) => {
      session.on('error', onError);
    });
    server.on('request', (request, response) => {
      this.#onHttp2(request, response);
    });
    this.#http2 = server;
    return server;
  }

  #onHttp2(request, response) {
    const onRequest = this.#routes.get('h2')?.request;
    if (!onRequest) return void response.end();
    onRequest(request, response);
  }

  #handoffHttp2(socket, head) {
    if (!this.#routes.has('h2')) return void socket.destroy();
    passSocket(this.#openHttp2(), socket, head);
  }

  #openTls() {
    if (this.#tlsServer) return this.#tlsServer;
    const output = this.#output;
    const server = tls.createServer({
      SNICallback: (name, callback) => this.#acceptSni(name, callback),
      ALPNCallback: ({ protocols }) => {
        const chosen = this.#terminalAlpn(protocols);
        return chosen || undefined;
      },
    });
    server.on('error', (error) => {
      reportError(output, error);
    });
    server.on('tlsClientError', (error) => {
      reportError(output, error);
    });
    server.on('secureConnection', (socket) => {
      this.#onSecure(socket);
    });
    this.#tlsServer = server;
    return server;
  }

  #handoffTls(socket, head) {
    passSocket(this.#openTls(), socket, head);
  }

  #onSecure(socket) {
    const output = this.#output;
    this.#sockets.add(socket);
    socket.on('close', () => {
      this.#sockets.delete(socket);
    });
    socket.on('error', (error) => {
      reportError(output, error);
    });
    const alpn = socket.alpnProtocol || '';
    const servername = socket.servername || '';
    if (isStunProtocol(alpn)) {
      return void this.#deliverSecure(socket, EMPTY, alpn, servername, alpn);
    }
    this.#readDecrypted(socket, servername, alpn);
  }

  #deliverSecure(socket, head, id, servername, alpn) {
    const route = this.#routes.get(id);
    if (!route) return void socket.destroy();
    const info = connectionInfo(socket, true, servername, alpn);
    handoff(socket, head, route, info);
  }

  #readDecrypted(socket, servername, alpn) {
    const timeoutMs = this.#requestTimeout;
    const onKind = (head, kind) => {
      const id = kind === 'stun' ? stunId(this.#protocols) : 'http/1.1';
      this.#deliverSecure(socket, head, id, servername, alpn);
    };
    socket.pause();
    sniff(socket, timeoutMs, appendChunk, classifyDecrypted, onKind);
    socket.resume();
  }

  #onDatagram(buffer, remote, socket) {
    const id = classifyUdp(buffer, this.#protocols);
    const datagram = this.#routes.get(id)?.datagram;
    if (datagram) datagram(buffer, remote, socket);
  }

  async #shutdown() {
    this.#accepting = false;
    this.#listening = false;
    const closing = this.#endpoints.map(closeEndpoint);
    if (this.#http2) closing.push(closeServer(this.#http2));
    if (this.#tlsServer) closing.push(closeServer(this.#tlsServer));
    for (const socket of this.#sockets) socket.destroy();
    await Promise.all(closing);
    this.#sockets.clear();
    this.#endpoints = [];
    this.#http2 = null;
    this.#tlsServer = null;
  }
}

module.exports = { matchDomain, Listener };
