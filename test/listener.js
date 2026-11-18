'use strict';

const assert = require('node:assert');
const dgram = require('node:dgram');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { Duplex } = require('node:stream');
const { test } = require('node:test');
const tls = require('node:tls');

const { Listener, matchDomain } = require('../lib/listener.js');
const metacom = require('../metacom.js');
const { ProtocolClient } = require('./websocket/protocolClient.js');

const TIMEOUT = { timeout: 5000 };
const PREFIX_LIMIT = 16 * 1024;
const STUN_COOKIE = 0x2112a442;
const FIXTURES = path.join(__dirname, 'fixtures');
const TLS_KEY = fs.readFileSync(path.join(FIXTURES, 'turn-key.pem'));
const TLS_CERT = fs.readFileSync(path.join(FIXTURES, 'turn-cert.pem'));
const TLS_CONTEXT = tls.createSecureContext({ key: TLS_KEY, cert: TLS_CERT });

const SILENT = {
  error() {},
  info() {},
  warn() {},
  log() {},
  debug() {},
};

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const optionsFor = (overrides) => {
  const options = {
    host: '127.0.0.1',
    ports: [0],
    protocols: ['http/1.1'],
    tls: false,
    handlers: {},
    nagle: false,
    timeouts: { bind: 2000, request: 5000 },
    console: SILENT,
  };
  return Object.assign(options, overrides ?? {});
};

const endpoint = (listener, transport, address) => {
  const ports = listener.ports;
  for (let i = 0; i < ports.length; i++) {
    const item = ports[i];
    if (item.transport !== transport) continue;
    if (address && item.address !== address) continue;
    return item;
  }
  return null;
};

const stunPacket = (first) => {
  const packet = Buffer.alloc(20);
  packet[0] = first;
  packet.writeUInt32BE(STUN_COOKIE, 4);
  packet.write('0123456789ab', 8);
  return packet;
};

const echoServer = () =>
  http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.end(body);
    });
  });

const openServer = (port) =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const connect = (port, host) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.on('error', () => {});
      resolve(socket);
    });
  });

const bindUdp = (type, address) =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket(type);
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.bind(0, address, () => {
      socket.off('error', onError);
      socket.on('error', () => {});
      resolve(socket);
    });
  });

const closeUdp = (socket) =>
  new Promise((resolve) => {
    socket.once('close', () => resolve());
    try {
      socket.close();
    } catch (error) {
      const closed = error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING';
      if (!closed) throw error;
      resolve();
    }
  });

const waitMessage = (socket) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('UDP reply timed out'));
    }, 1000);
    socket.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

const post = async (port, body) => {
  const url = `http://127.0.0.1:${port}/`;
  const response = await fetch(url, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(2000),
  });
  const text = await response.text();
  return { status: response.status, text };
};

const tlsOptions = (overrides) =>
  optionsFor(
    Object.assign(
      {
        transports: ['tcp'],
        secureContext: () => TLS_CONTEXT,
      },
      overrides ?? {},
    ),
  );

const postTls = (port, body, alpn) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        servername: 'localhost',
        port,
        method: 'POST',
        rejectUnauthorized: false,
        ALPNProtocols: alpn,
        headers: {
          host: 'localhost',
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, text });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });

const postH2 = (port, body) =>
  new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
      servername: 'localhost',
      ALPNProtocols: ['h2'],
    });
    const fail = (error) => {
      client.close();
      reject(error);
    };
    client.on('error', fail);
    const request = client.request({ ':method': 'POST', ':path': '/' });
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      client.close();
      resolve(Buffer.concat(chunks).toString());
    });
    request.on('error', fail);
    request.end(body);
  });

const echoRequest = (request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    response.end(Buffer.concat(chunks));
  });
};

const WEBSOCKET_KEY = Buffer.from('0123456789abcdef').toString('base64');

const metacomServer = (extra) => {
  const application = { console: SILENT };
  const protocol = 'http';
  const options = Object.assign({ protocol }, extra ?? {});
  return new metacom.Server(application, options);
};

const serveEcho = (server) => {
  server.on('request', ({ req, res }) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.end(Buffer.concat(chunks));
    });
  });
};

const stopServer = (server) => server.close();

const isUnrecognized = (error) => {
  const code = error.code ?? '';
  const reason = error.reason ?? '';
  const message = error.message ?? '';
  const text = `${code} ${reason} ${message}`.toLowerCase();
  const normalized = text.replaceAll(' ', '_');
  return normalized.includes('unrecognized_name');
};

const exchange = (port, host) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.on('error', () => {});
      const lines = [
        'GET / HTTP/1.1',
        `Host: ${host}`,
        'Connection: close',
        '',
        '',
      ];
      socket.end(lines.join('\r\n'));
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });

const upgradeTls = (port) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve({ status, socket });
    };
    timer = setTimeout(() => {
      finish(new Error('TLS upgrade timed out'));
    }, 2000);
    socket.once('error', (error) => {
      finish(error);
    });
    socket.once('secureConnect', () => {
      const host = `localhost:${port}`;
      const lines = [
        'GET / HTTP/1.1',
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${WEBSOCKET_KEY}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ];
      socket.write(lines.join('\r\n'));
    });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index === -1) return;
      const head = buffer.subarray(0, index).toString();
      const status = head.split('\r\n')[0];
      finish(null, status);
    });
  });

const openTls = (port, extra) =>
  new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
    };
    const socket = tls.connect(Object.assign(options, extra ?? {}));
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      socket.on('error', () => {});
      resolve(socket);
    });
  });

const readClosed = (socket) =>
  new Promise((resolve) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks)));
  });

const captureHello = () =>
  new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', (chunk) => {
        socket.destroy();
        if (settled) return;
        settled = true;
        if (client) client.destroy();
        resolve({ server, hello: chunk });
      });
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (client) client.destroy();
      server.close(() => {
        reject(error);
      });
    };
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const info = server.address();
      const port = info.port;
      client = tls.connect({
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1'],
      });
      client.on('error', (error) => {
        if (settled) return;
        fail(error);
      });
    });
  });

const splitSocket = (raw, size, gapMs) => {
  const state = { slices: 0 };
  const proxy = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      const isBuffer = Buffer.isBuffer(chunk);
      const bytes = isBuffer ? chunk : Buffer.from(chunk, encoding);
      const send = (offset) => {
        if (offset >= bytes.length) {
          callback();
          return;
        }
        state.slices += 1;
        const slice = bytes.subarray(offset, offset + size);
        raw.write(slice, () => {
          setTimeout(() => send(offset + size), gapMs);
        });
      };
      send(0);
    },
  });
  raw.on('data', (chunk) => {
    proxy.push(chunk);
  });
  raw.on('end', () => {
    proxy.push(null);
  });
  raw.on('error', () => {});
  proxy.on('error', () => {});
  return { proxy, state };
};

test('metacom exports Listener', TIMEOUT, () => {
  assert.strictEqual(metacom.Listener, Listener);
  assert.strictEqual(metacom.matchDomain, matchDomain);
});

test('plain HTTP is served without Server.listen', TIMEOUT, async () => {
  const httpServer = echoServer();
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  try {
    await listener.listen();
    assert.strictEqual(httpServer.listening, false);
    const bound = endpoint(listener, 'tcp');
    assert.ok(bound);
    assert.strictEqual(bound.address, '127.0.0.1');
    assert.strictEqual(bound.transport, 'tcp');
    assert.ok(bound.port > 0);
    const response = await post(bound.port, 'ping');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'ping');
    assert.strictEqual(httpServer.listening, false);
  } finally {
    await listener.close();
  }
});

test('http/1.1 connection() reads the request', TIMEOUT, async () => {
  let head = null;
  const handler = {
    connection(socket) {
      head = socket.read();
      const body = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n';
      socket.end(`${body}Connection: close\r\n\r\nok`);
    },
  };
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      handlers: { 'http/1.1': handler },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const url = `http://127.0.0.1:${bound.port}/`;
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await response.text();
    assert.strictEqual(text, 'ok');
    assert.ok(Buffer.isBuffer(head));
    assert.ok(head.toString().startsWith('GET /'));
  } finally {
    await listener.close();
  }
});

test('raw STUN over TCP leaves the bytes readable', TIMEOUT, async () => {
  let seen = null;
  const provider = {
    connection(socket, info) {
      const head = socket.read();
      seen = { head, info };
      socket.end();
    },
  };
  const listener = new Listener(
    optionsFor({
      protocols: ['stun.turn'],
      transports: ['tcp'],
      handlers: { 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const packet = stunPacket(0x3f);
    socket = await connect(bound.port, '127.0.0.1');
    socket.write(packet.subarray(0, 4));
    await delay(30);
    assert.strictEqual(seen, null);
    const closed = once(socket, 'close');
    socket.write(packet.subarray(4));
    await closed;
    assert.ok(Buffer.isBuffer(seen.head));
    assert.ok(seen.head.equals(packet));
    const info = seen.info;
    assert.strictEqual(info.port, bound.port);
    assert.strictEqual(info.transport, 'tcp');
    assert.strictEqual(info.tls, false);
    assert.strictEqual(info.servername, '');
    assert.strictEqual(info.alpn, '');
    assert.strictEqual(info.remote.address, '127.0.0.1');
    assert.strictEqual(typeof info.remote.port, 'number');
    assert.ok(info.remote.port > 0);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('UDP routes STUN and ChannelData only', TIMEOUT, async () => {
  const packets = [];
  const remotes = [];
  const provider = {
    datagram(buffer, remote, socket) {
      packets.push(Buffer.from(buffer));
      remotes.push(remote);
      const reply = Buffer.from('ok');
      socket.send(reply, remote.port, remote.address);
    },
  };
  const listener = new Listener(
    optionsFor({
      protocols: ['stun.turn', 'stun.nat-discovery'],
      transports: ['udp'],
      handlers: {
        'stun.turn': provider,
        'stun.nat-discovery': {
          datagram() {
            packets.push(Buffer.from('nat'));
          },
        },
      },
    }),
  );
  let client = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'udp');
    assert.strictEqual(bound.address, '127.0.0.1');
    client = await bindUdp('udp4', '127.0.0.1');
    const send = (buffer) => {
      client.send(buffer, bound.port, '127.0.0.1');
    };
    send(Buffer.from([0x00, 0x00, 0x00]));
    const wrongCookie = Buffer.alloc(8);
    wrongCookie[0] = 0x01;
    send(wrongCookie);
    send(Buffer.from([0x50, 0x00, 0x00, 0x00]));
    const stun = stunPacket(0x3f);
    const first = waitMessage(client);
    send(stun);
    const stunReply = await first;
    assert.strictEqual(stunReply.toString(), 'ok');
    assert.strictEqual(packets.length, 1);
    assert.ok(packets[0].equals(stun));
    assert.strictEqual(remotes[0].address, '127.0.0.1');
    assert.strictEqual(remotes[0].family, 'IPv4');
    assert.strictEqual(typeof remotes[0].port, 'number');
    assert.strictEqual(typeof remotes[0].size, 'number');
    send(Buffer.from('not-a-stun-datagram'));
    const channel = Buffer.from([0x4f, 0x00, 0x00, 0x01, 0x61]);
    const second = waitMessage(client);
    send(channel);
    const channelReply = await second;
    assert.strictEqual(channelReply.toString(), 'ok');
    assert.strictEqual(packets.length, 2);
    assert.ok(packets[1].equals(channel));
  } finally {
    if (client) await closeUdp(client);
    await listener.close();
  }
});

test('UDP STUN falls through to stun.nat-discovery', TIMEOUT, async () => {
  const seen = [];
  const nat = {
    datagram(buffer, remote, socket) {
      seen.push(Buffer.from(buffer));
      socket.send(Buffer.from('nat'), remote.port, remote.address);
    },
  };
  const turn = {
    datagram() {
      seen.push(Buffer.from('turn'));
    },
  };
  const listener = new Listener(
    optionsFor({
      protocols: ['stun.nat-discovery'],
      transports: ['udp'],
      handlers: { 'stun.nat-discovery': nat, 'stun.turn': turn },
    }),
  );
  let client = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'udp');
    client = await bindUdp('udp4', '127.0.0.1');
    const channel = Buffer.from([0x40, 0x01, 0x00, 0x00]);
    client.send(channel, bound.port, '127.0.0.1');
    const stun = stunPacket(0x01);
    const reply = waitMessage(client);
    client.send(stun, bound.port, '127.0.0.1');
    const message = await reply;
    assert.strictEqual(message.toString(), 'nat');
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].equals(stun));
  } finally {
    if (client) await closeUdp(client);
    await listener.close();
  }
});

test('tls refuses a plain HTTP connection', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const listener = new Listener(
    optionsFor({
      tls: true,
      transports: ['tcp'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await connect(bound.port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const closed = once(socket, 'close');
    socket.end('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await closed;
    const body = Buffer.concat(chunks);
    assert.strictEqual(body.length, 0);
    assert.strictEqual(called, false);
    await assert.rejects(post(bound.port, 'ping'));
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('tls refuses a plain STUN connection', TIMEOUT, async () => {
  let called = false;
  const provider = {
    connection() {
      called = true;
    },
  };
  const listener = new Listener(
    optionsFor({
      tls: true,
      protocols: ['stun.turn'],
      transports: ['tcp'],
      handlers: { 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await connect(bound.port, '127.0.0.1');
    const closed = once(socket, 'close');
    const packet = Buffer.alloc(8);
    packet[0] = 0x00;
    packet.writeUInt32BE(STUN_COOKIE, 4);
    socket.write(packet);
    await closed;
    assert.strictEqual(called, false);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a TLS record byte is destroyed', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const provider = {
    connection() {
      called = true;
    },
  };
  const listener = new Listener(
    optionsFor({
      protocols: ['http/1.1', 'stun.turn'],
      transports: ['tcp'],
      handlers: { 'http/1.1': httpServer, 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await connect(bound.port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const closed = once(socket, 'close');
    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01, 0x00]));
    await closed;
    assert.strictEqual(Buffer.concat(chunks).length, 0);
    assert.strictEqual(called, false);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a silent TCP client hits timeouts.request', TIMEOUT, async () => {
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      timeouts: { bind: 2000, request: 150 },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const started = Date.now();
    socket = await connect(bound.port, '127.0.0.1');
    await once(socket, 'close');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, `closed too soon (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `closed too late (${elapsed}ms)`);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a TCP prefix over 16 KiB is destroyed', TIMEOUT, async () => {
  const httpServer = echoServer();
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await connect(bound.port, '127.0.0.1');
    const payload = Buffer.alloc(PREFIX_LIMIT + 1, 0x41);
    const started = Date.now();
    const closed = once(socket, 'close');
    socket.write(payload);
    await closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `waited ${elapsed}ms`);
    const response = await post(bound.port, 'ping');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'ping');
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('close resolves twice with an open connection', TIMEOUT, async () => {
  const listener = new Listener(
    optionsFor({
      protocols: ['http/1.1', 'stun.turn'],
      transports: ['tcp', 'udp'],
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    assert.ok(endpoint(listener, 'udp'));
    socket = await connect(bound.port, '127.0.0.1');
    const clientClosed = once(socket, 'close');
    const started = Date.now();
    const first = listener.close();
    const second = listener.close();
    await first;
    await second;
    await clientClosed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `close waited ${elapsed}ms`);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a failed bind rejects and releases the other port', TIMEOUT, async () => {
  const taken = await openServer(0);
  const held = await openServer(0);
  const takenPort = taken.address().port;
  const freePort = held.address().port;
  await closeServer(held);
  const listener = new Listener(
    optionsFor({
      ports: [freePort, takenPort],
      transports: ['tcp'],
    }),
  );
  let again = null;
  let probe = null;
  try {
    await assert.rejects(
      () => listener.listen(),
      (error) => {
        assert.strictEqual(error.code, 'EADDRINUSE');
        return true;
      },
    );
    assert.deepStrictEqual(listener.ports, []);
    again = await openServer(freePort);
    assert.strictEqual(again.address().port, freePort);
    probe = net.createServer();
    const blocked = await new Promise((resolve) => {
      probe.once('error', resolve);
      probe.listen(takenPort, '127.0.0.1');
    });
    assert.strictEqual(blocked.code, 'EADDRINUSE');
  } finally {
    if (again) await closeServer(again);
    if (probe) await closeServer(probe);
    await listener.close();
    await closeServer(taken);
  }
});

test('wildcard host binds udp4 and udp6', TIMEOUT, async () => {
  const families = [];
  const provider = {
    datagram(buffer, remote, socket) {
      families.push(remote.family);
      socket.send(Buffer.from('ok'), remote.port, remote.address);
    },
  };
  const listener = new Listener(
    optionsFor({
      host: '0.0.0.0',
      protocols: ['stun.turn'],
      transports: ['udp'],
      handlers: { 'stun.turn': provider },
    }),
  );
  let v4 = null;
  let v6 = null;
  try {
    await listener.listen();
    const ports = listener.ports;
    assert.strictEqual(ports.length, 2);
    assert.strictEqual(ports[0].port, ports[1].port);
    assert.strictEqual(ports[0].transport, 'udp');
    assert.strictEqual(ports[1].transport, 'udp');
    const addresses = [ports[0].address, ports[1].address];
    assert.ok(addresses.includes('0.0.0.0'));
    assert.ok(addresses.includes('::'));
    const port = ports[0].port;
    const stun = stunPacket(0x01);
    v4 = await bindUdp('udp4', '127.0.0.1');
    v6 = await bindUdp('udp6', '::1');
    const reply4 = waitMessage(v4);
    v4.send(stun, port, '127.0.0.1');
    assert.strictEqual((await reply4).toString(), 'ok');
    const reply6 = waitMessage(v6);
    v6.send(stun, port, '::1');
    assert.strictEqual((await reply6).toString(), 'ok');
    assert.deepStrictEqual(families, ['IPv4', 'IPv6']);
  } finally {
    if (v4) await closeUdp(v4);
    if (v6) await closeUdp(v6);
    await listener.close();
  }
});

test('transports default from the listed protocols', TIMEOUT, async () => {
  const both = new Listener(
    optionsFor({ protocols: ['http/1.1', 'stun.turn'] }),
  );
  const httpOnly = new Listener(optionsFor({ protocols: ['http/1.1'] }));
  const discovery = new Listener(
    optionsFor({ protocols: ['stun.nat-discovery'] }),
  );
  try {
    await both.listen();
    await httpOnly.listen();
    await discovery.listen();
    const kinds = both.ports.map((item) => item.transport);
    assert.deepStrictEqual(kinds, ['tcp', 'udp']);
    assert.strictEqual(httpOnly.ports.length, 1);
    assert.strictEqual(httpOnly.ports[0].transport, 'tcp');
    const discoveryKinds = discovery.ports.map((item) => item.transport);
    assert.deepStrictEqual(discoveryKinds, ['tcp', 'udp']);
  } finally {
    await both.close();
    await httpOnly.close();
    await discovery.close();
  }
});

test('HTTP/1.1 over TLS returns the request body', TIMEOUT, async () => {
  const httpServer = echoServer();
  const listener = new Listener(
    tlsOptions({
      protocols: ['http/1.1'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const response = await postTls(bound.port, 'ping', ['http/1.1']);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'ping');
  } finally {
    await listener.close();
  }
});

test('HTTP/2 over TLS returns the request body', TIMEOUT, async () => {
  const listener = new Listener(
    tlsOptions({
      protocols: ['h2', 'http/1.1'],
      handlers: { h2: echoRequest },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const text = await postH2(bound.port, 'pong');
    assert.strictEqual(text, 'pong');
  } finally {
    await listener.close();
  }
});

test('ALPN stun.turn delivers plaintext and tls info', TIMEOUT, async () => {
  let seen = null;
  const provider = {
    connection(socket, info) {
      socket.on('data', (chunk) => {
        seen = { chunk: Buffer.from(chunk), info };
        socket.end();
      });
    },
  };
  const listener = new Listener(
    tlsOptions({
      protocols: ['stun.turn'],
      handlers: { 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await openTls(bound.port, { ALPNProtocols: ['stun.turn'] });
    const closed = once(socket, 'close');
    socket.write('hello-turn');
    await closed;
    assert.ok(Buffer.isBuffer(seen.chunk));
    assert.strictEqual(seen.chunk.toString(), 'hello-turn');
    assert.strictEqual(seen.info.tls, true);
    assert.strictEqual(seen.info.alpn, 'stun.turn');
    assert.strictEqual(seen.info.transport, 'tcp');
    assert.strictEqual(seen.info.servername, 'localhost');
    assert.strictEqual(seen.info.port, bound.port);
    assert.strictEqual(seen.info.remote.address, '127.0.0.1');
    assert.strictEqual(typeof seen.info.remote.port, 'number');
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('TLS without ALPN routes a STUN message', TIMEOUT, async () => {
  let seen = null;
  let httpCalled = false;
  const provider = {
    connection(socket, info) {
      const head = socket.read();
      seen = { head, info };
      socket.end();
    },
  };
  const httpServer = http.createServer((req, res) => {
    httpCalled = true;
    res.end('nope');
  });
  const listener = new Listener(
    tlsOptions({
      protocols: ['http/1.1', 'stun.turn'],
      handlers: { 'http/1.1': httpServer, 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const packet = stunPacket(0x01);
    socket = await openTls(bound.port);
    const closed = once(socket, 'close');
    socket.write(packet);
    await closed;
    assert.strictEqual(httpCalled, false);
    assert.ok(Buffer.isBuffer(seen.head));
    assert.ok(seen.head.equals(packet));
    assert.strictEqual(seen.info.tls, true);
    assert.strictEqual(seen.info.alpn, '');
    assert.strictEqual(seen.info.servername, 'localhost');
    assert.strictEqual(seen.info.transport, 'tcp');
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('TLS without ALPN routes HTTP to http/1.1', TIMEOUT, async () => {
  let stunCalled = false;
  const provider = {
    connection() {
      stunCalled = true;
    },
  };
  const httpServer = echoServer();
  const listener = new Listener(
    tlsOptions({
      protocols: ['http/1.1', 'stun.turn'],
      handlers: { 'http/1.1': httpServer, 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await openTls(bound.port);
    const done = readClosed(socket);
    const head = 'POST / HTTP/1.1\r\nHost: localhost\r\n';
    const tail = 'Content-Length: 3\r\nConnection: close\r\n\r\n';
    socket.write(`${head}${tail}abc`);
    const body = await done;
    const text = body.toString();
    assert.strictEqual(stunCalled, false);
    assert.ok(text.startsWith('HTTP/1.1 200'));
    assert.ok(text.endsWith('abc'));
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a split ClientHello completes HTTP/1.1 over TLS', TIMEOUT, async () => {
  const httpServer = echoServer();
  const listener = new Listener(
    tlsOptions({
      protocols: ['http/1.1'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  let raw = null;
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    raw = await connect(bound.port, '127.0.0.1');
    raw.setNoDelay(true);
    const split = splitSocket(raw, 30, 15);
    socket = tls.connect({
      socket: split.proxy,
      servername: 'localhost',
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    socket.on('error', () => {});
    await once(socket, 'secureConnect');
    assert.ok(split.state.slices > 1);
    const incoming = new Promise((resolve) => {
      const chunks = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString();
        if (!text.includes('ping')) return;
        resolve(text);
      });
    });
    const head = 'POST / HTTP/1.1\r\nHost: localhost\r\n';
    const tail = 'Content-Length: 4\r\nConnection: close\r\n\r\n';
    socket.write(`${head}${tail}ping`);
    const text = await incoming;
    assert.ok(text.startsWith('HTTP/1.1 200'));
    assert.ok(text.endsWith('ping'));
  } finally {
    if (socket) socket.destroy();
    if (raw) raw.destroy();
    await listener.close();
  }
});

test('a ClientHello over 16 KiB is destroyed', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const provider = {
    connection() {
      called = true;
    },
  };
  const listener = new Listener(
    tlsOptions({
      protocols: ['h2', 'http/1.1', 'stun.turn'],
      handlers: {
        h2: () => {
          called = true;
        },
        'http/1.1': httpServer,
        'stun.turn': provider,
      },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    socket = await connect(bound.port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const closed = once(socket, 'close');
    const header = Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01]);
    socket.write(header);
    await closed;
    assert.strictEqual(Buffer.concat(chunks).length, 0);
    assert.strictEqual(called, false);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a null secure context does not call handlers', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const provider = {
    connection() {
      called = true;
    },
  };
  const listener = new Listener(
    tlsOptions({
      secureContext: () => null,
      protocols: ['h2', 'http/1.1', 'stun.turn'],
      handlers: {
        h2: () => {
          called = true;
        },
        'http/1.1': httpServer,
        'stun.turn': provider,
      },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    let tlsError = null;
    let h2Error = null;
    try {
      await postTls(bound.port, 'ping', ['http/1.1']);
    } catch (error) {
      tlsError = error;
    }
    try {
      await postH2(bound.port, 'pong');
    } catch (error) {
      h2Error = error;
    }
    assert.ok(tlsError);
    assert.ok(h2Error);
    assert.strictEqual(isUnrecognized(tlsError), true);
    assert.strictEqual(isUnrecognized(h2Error), true);
    assert.strictEqual(called, false);
  } finally {
    await listener.close();
  }
});

test(
  'a missing certificate is refused before the handshake',
  TIMEOUT,
  async () => {
    let called = false;
    let contextCalls = 0;
    const httpServer = http.createServer((req, res) => {
      called = true;
      res.end('nope');
    });
    const provider = {
      connection() {
        called = true;
      },
    };
    const listener = new Listener(
      tlsOptions({
        secureContext: () => {
          contextCalls += 1;
          return null;
        },
        protocols: ['h2', 'http/1.1', 'stun.turn'],
        handlers: {
          h2: () => {
            called = true;
          },
          'http/1.1': httpServer,
          'stun.turn': provider,
        },
      }),
    );
    let captured = null;
    let socket = null;
    try {
      captured = await captureHello();
      await listener.listen();
      const bound = endpoint(listener, 'tcp');
      socket = await connect(bound.port, '127.0.0.1');
      const received = readClosed(socket);
      socket.write(captured.hello);
      const bytes = await received;
      const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);
      assert.deepStrictEqual(bytes, alert);
      assert.strictEqual(bytes.indexOf(0x16), -1);
      assert.strictEqual(called, false);
      assert.strictEqual(contextCalls, 1);
    } finally {
      if (socket) socket.destroy();
      if (captured) await closeServer(captured.server);
      await listener.close();
    }
  },
);

test('matchDomain applies exact, wildcard, and rooted names', TIMEOUT, () => {
  const exact = ['xxii.chat'];
  const wildcard = ['*.xxii.chat'];
  const rooted = ['.example.com'];
  assert.strictEqual(matchDomain(exact, 'xxii.chat'), true);
  assert.strictEqual(matchDomain(exact, 'XXII.CHAT'), true);
  assert.strictEqual(matchDomain(exact, 'xxii.chat.'), true);
  assert.strictEqual(matchDomain(exact, 'api.xxii.chat'), false);
  assert.strictEqual(matchDomain(wildcard, 'api.xxii.chat'), true);
  assert.strictEqual(matchDomain(wildcard, 'API.XXII.CHAT.'), true);
  assert.strictEqual(matchDomain(wildcard, 'xxii.chat'), false);
  assert.strictEqual(matchDomain(wildcard, 'a.b.xxii.chat'), false);
  assert.strictEqual(matchDomain(rooted, 'example.com'), true);
  assert.strictEqual(matchDomain(rooted, 'example.com.'), true);
  assert.strictEqual(matchDomain(rooted, 'a.b.example.com'), true);
  assert.strictEqual(matchDomain(rooted, 'A.B.Example.COM'), true);
  assert.strictEqual(matchDomain(rooted, 'notexample.com'), false);
  assert.strictEqual(matchDomain([], 'anywhere.test'), true);
  assert.strictEqual(matchDomain(undefined, 'anywhere.test'), true);
});

test('an SNI outside domains is unrecognized_name', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const listener = new Listener(
    tlsOptions({
      domains: ['example.com', '*.example.com'],
      protocols: ['http/1.1'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    let error = null;
    try {
      await postTls(bound.port, 'ping', ['http/1.1']);
    } catch (failure) {
      error = failure;
    }
    assert.ok(error);
    assert.strictEqual(isUnrecognized(error), true);
    assert.strictEqual(called, false);
  } finally {
    await listener.close();
  }
});

test('no server name is unrecognized_name', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const provider = {
    connection() {
      called = true;
    },
  };
  const listener = new Listener(
    tlsOptions({
      domains: ['example.com'],
      protocols: ['http/1.1', 'stun.turn'],
      handlers: { 'http/1.1': httpServer, 'stun.turn': provider },
    }),
  );
  let socket = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const error = await new Promise((resolve, reject) => {
      const client = tls.connect({
        host: '127.0.0.1',
        port: bound.port,
        servername: '',
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      });
      socket = client;
      const timer = setTimeout(() => {
        reject(new Error('TLS hello timed out'));
      }, 2000);
      client.once('secureConnect', () => {
        clearTimeout(timer);
        reject(new Error('handshake completed'));
      });
      client.once('error', (failure) => {
        clearTimeout(timer);
        resolve(failure);
      });
    });
    const code = error.code ?? '';
    const message = error.message ?? '';
    const named = code.includes('UNRECOGNIZED_NAME');
    const alert = message.includes('alert number 112');
    assert.strictEqual(named || alert, true);
    assert.strictEqual(called, false);
  } finally {
    if (socket) socket.destroy();
    await listener.close();
  }
});

test('a Host outside domains gets 421', TIMEOUT, async () => {
  let called = false;
  const httpServer = http.createServer((req, res) => {
    called = true;
    res.end('nope');
  });
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      domains: ['example.com'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const text = await exchange(bound.port, 'other.test');
    assert.ok(text.startsWith('HTTP/1.1 421 Misdirected Request'));
    assert.ok(text.toLowerCase().includes('connection: close'));
    assert.strictEqual(called, false);
  } finally {
    await listener.close();
  }
});

test('a matching Host reaches the handler', TIMEOUT, async () => {
  const seen = [];
  const httpServer = http.createServer((req, res) => {
    seen.push(req.headers.host);
    res.end('ok');
  });
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      domains: ['*.example.com', '.example.com'],
      handlers: { 'http/1.1': httpServer },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const subdomain = await exchange(bound.port, 'api.example.com.');
    const rooted = await exchange(bound.port, 'a.b.example.com.');
    assert.ok(subdomain.startsWith('HTTP/1.1 200'));
    assert.ok(rooted.startsWith('HTTP/1.1 200'));
    assert.strictEqual(seen.length, 2);
  } finally {
    await listener.close();
  }
});

test('Server serves HTTP, HTTP/2, and WebSocket', TIMEOUT, async () => {
  const server = metacomServer();
  serveEcho(server);
  const listener = new Listener(
    tlsOptions({
      protocols: ['h2', 'http/1.1'],
      handlers: { h2: server, 'http/1.1': server },
    }),
  );
  let plain = null;
  let secure = null;
  try {
    await listener.listen();
    assert.strictEqual(server.httpServer.listening, false);
    const bound = endpoint(listener, 'tcp');
    const response = await post(bound.port, 'plain');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'plain');
    plain = new ProtocolClient(`ws://127.0.0.1:${bound.port}/`);
    await once(plain, 'open');
    const call = {
      type: 'call',
      id: '1',
      method: 'system/introspect',
      args: [],
    };
    const incoming = once(plain, 'message');
    plain.send(JSON.stringify(call));
    const frames = await incoming;
    const packet = JSON.parse(frames[0].toString());
    assert.strictEqual(packet.type, 'callback');
    assert.strictEqual(packet.id, '1');
    const text = await postH2(bound.port, 'cipher');
    assert.strictEqual(text, 'cipher');
    secure = await upgradeTls(bound.port);
    assert.strictEqual(secure.socket.alpnProtocol, 'http/1.1');
    assert.strictEqual(secure.status, 'HTTP/1.1 101 Switching Protocols');
  } finally {
    if (plain) plain.close();
    if (secure) secure.socket.destroy();
    await listener.close();
    await stopServer(server);
  }
});

test('server.close finishes a listener-fed WebSocket', TIMEOUT, async () => {
  const server = metacomServer();
  const listener = new Listener(
    optionsFor({
      transports: ['tcp'],
      protocols: ['http/1.1'],
      handlers: { 'http/1.1': server },
    }),
  );
  let plain = null;
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    plain = new ProtocolClient(`ws://127.0.0.1:${bound.port}/`);
    await once(plain, 'open');
    assert.strictEqual(server.httpServer.listening, false);
    await server.close();
    await server.close();
  } finally {
    if (plain) plain.close();
    await listener.close();
    await server.close();
  }
});

test('an h2-only Server accepts ALPN http/1.1', TIMEOUT, async () => {
  const server = metacomServer();
  serveEcho(server);
  const listener = new Listener(
    tlsOptions({
      protocols: ['h2'],
      handlers: { h2: server },
    }),
  );
  try {
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const response = await postTls(bound.port, 'fallback', ['http/1.1']);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'fallback');
    assert.strictEqual(server.httpServer.listening, false);
  } finally {
    await listener.close();
    await stopServer(server);
  }
});

test('close resolves twice for tls and http2', TIMEOUT, async () => {
  const server = metacomServer();
  serveEcho(server);
  const standalone = metacomServer({ host: '127.0.0.1', port: 0 });
  const listener = new Listener(
    tlsOptions({
      protocols: ['h2', 'http/1.1'],
      handlers: { h2: server, 'http/1.1': server },
    }),
  );
  try {
    await standalone.listen();
    const ownPort = standalone.httpServer.address().port;
    await listener.listen();
    const bound = endpoint(listener, 'tcp');
    const text = await postH2(bound.port, 'h2');
    assert.strictEqual(text, 'h2');
    const response = await postTls(bound.port, 'tls', ['http/1.1']);
    assert.strictEqual(response.text, 'tls');
    const first = listener.close();
    const second = listener.close();
    await first;
    await second;
    assert.strictEqual(standalone.httpServer.listening, true);
    assert.strictEqual(standalone.httpServer.address().port, ownPort);
    assert.strictEqual(server.httpServer.listening, false);
  } finally {
    await listener.close();
    await stopServer(server);
    await stopServer(standalone);
  }
});
