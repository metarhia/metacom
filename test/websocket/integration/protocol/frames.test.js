'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { WebsocketServer } = require('../../../../lib/websocket/server.js');
const { ProtocolClient } = require('../../utils/protocolClient.js');
const {
  CLOSE_CODES,
  OPCODES,
} = require('../../../../lib/websocket/constants.js');

async function startServer(onConn) {
  const httpServer = http.createServer();
  const tinyWsServer = new WebsocketServer({
    server: httpServer,
    closeTimeout: 0,
    pingInterval: 60_000,
  });
  if (onConn) tinyWsServer.on('connection', onConn);
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  return { httpServer, port };
}

// micro-delay to preserve TCP chunking behavior without slowing tests
const delay = () => new Promise((r) => process.nextTick(r));

test('frames: unmasked data frame from client -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendText('oops', { mask: false });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  assert.ok(
    String(result.reason).toLowerCase().includes('unmasked'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: RSV bits set -> close 1002 with RSV reason', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // Craft a single masked TEXT frame with RSV bits set (0x70)
      const fin = 0x80;
      const rsv = 0x70;
      const opcode = 0x1; // TEXT
      const b0 = fin | rsv | opcode;
      const payload = Buffer.from([0x41]);
      const maskKey = Buffer.from([0, 0, 0, 0]); // trivial mask
      const b1 = 0x80 | payload.length; // masked + length
      const buf = Buffer.concat([Buffer.from([b0, b1]), maskKey, payload]);
      client.socket.write(buf);
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  assert.ok(
    String(result.reason).toLowerCase().includes('rsv'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: control frame too long (ping >125) -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(OPCODES.PING, Buffer.alloc(126), { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  assert.ok(
    String(result.reason).toLowerCase().includes('too long'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: fragmented control (ping with FIN=0) -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(OPCODES.PING, Buffer.from([0x01]), {
        fin: false,
        mask: true,
      });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  assert.ok(
    String(result.reason).toLowerCase().includes('protocol error'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: unknown data opcode (0x3) -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(0x3, Buffer.from([0x00]), { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

test('frames: invalid UTF-8 in single text frame -> close 1007', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // Overlong encoding for '/' (U+002F) could be 0xC0 0xAF (invalid)
      const invalid = Buffer.from([0xc0, 0xaf]);
      client.sendFrame(OPCODES.TEXT, invalid, { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.INVALID_PAYLOAD);
  assert.ok(
    String(result.reason).toLowerCase().includes('invalid payload'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: CLOSE with 1 byte payload -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(OPCODES.CLOSE, Buffer.from([0x03]), { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

test('frames: CLOSE with invalid code 999 -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(999, 0);
      client.sendFrame(OPCODES.CLOSE, payload, { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

test('frames: CLOSE with invalid UTF-8 in reason -> close 1007', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      const reason = Buffer.from([0xc0, 0xaf]);
      const payload = Buffer.alloc(2 + reason.length);
      payload.writeUInt16BE(1000, 0);
      reason.copy(payload, 2);
      client.sendFrame(OPCODES.CLOSE, payload, { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.INVALID_PAYLOAD);
  await new Promise((r) => httpServer.close(r));
});

test('frames: CLOSE with empty payload -> client sees 1005', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(OPCODES.CLOSE, Buffer.alloc(0), { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, 1005);
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: fragmented text with invalid UTF-8 in continuation -> close 1007', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // Start of a 3-byte sequence (E2 82 ..)
      // but complete with invalid cont byte 0x20
      client.sendFrame(OPCODES.TEXT, Buffer.from([0xe2, 0x82]), {
        fin: false,
        mask: true,
      });
      client.sendFrame(OPCODES.CONTINUATION, Buffer.from([0x20]), {
        fin: true,
        mask: true,
      });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.INVALID_PAYLOAD);
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: send BINARY during TEXT fragmentation -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      client.sendFrame(OPCODES.TEXT, Buffer.from([0x41]), {
        fin: false,
        mask: true,
      });
      client.sendFrame(OPCODES.BINARY, Buffer.from([0x00]), {
        fin: true,
        mask: true,
      });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

test('frames: reserved control opcode 0xB -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // 0xB has control bit set but is not a valid control opcode
      client.sendFrame(0x0b, Buffer.alloc(0), { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

test('frames: normal close handshake (1000 "bye")', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      const reason = Buffer.from('bye');
      const payload = Buffer.alloc(2 + reason.length);
      payload.writeUInt16BE(1000, 0);
      reason.copy(payload, 2);
      client.sendFrame(OPCODES.CLOSE, payload, { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, 1000);
  assert.strictEqual(result.reason, 'bye');
  await new Promise((r) => httpServer.close(r));
});

test('frames: CONTINUATION without started message -> close 1002', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // Send CONTINUATION (0x0) as first frame
      client.sendFrame(OPCODES.CONTINUATION, Buffer.from([0x41]), {
        fin: true,
        mask: true,
      });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.PROTOCOL_ERROR);
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: interleaved ping during TEXT fragmentation -> pong echoed and message assembled', async () => {
  // Echo server to verify assembled message
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.on('message', (msg, isBinary) => {
      conn.send(isBinary ? msg : String(msg));
    });
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const pongPayload = Buffer.from('X');

  const outcome = await new Promise((resolve) => {
    let gotPong = false;
    let gotMsg = null;
    client.on('pong', (buf) => {
      if (Buffer.compare(buf, pongPayload) === 0) gotPong = true;
      if (gotPong && gotMsg !== null) resolve({ gotPong, msg: gotMsg });
    });
    client.on('message', (buf) => {
      gotMsg = buf.toString();
      if (gotPong) resolve({ gotPong, msg: gotMsg });
      client.close();
    });
    client.on('open', () => {
      client.sendFrame(OPCODES.TEXT, Buffer.from('Hello '), {
        fin: false,
        mask: true,
      });
      client.ping(pongPayload, { mask: true });
      client.sendFrame(OPCODES.CONTINUATION, Buffer.from('world'), {
        fin: true,
        mask: true,
      });
    });
  });

  assert.strictEqual(outcome.gotPong, true);
  assert.strictEqual(outcome.msg, 'Hello world');
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: TEXT length boundaries 125 and 126 are accepted and echoed', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.on('message', (msg) => conn.send(String(msg)));
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const r125 = await new Promise((resolve) => {
    client.on('message', (buf) => resolve(buf.toString()));
    client.on('open', () => {
      const s = 'a'.repeat(125);
      client.sendText(s, { mask: true });
    });
  });
  assert.strictEqual(r125.length, 125);

  const r126 = await new Promise((resolve) => {
    client.on('message', (buf) => resolve(buf.toString()));
    const s = 'b'.repeat(126);
    client.sendText(s, { mask: true });
  });
  assert.strictEqual(r126.length, 126);

  client.close();
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: 64-bit length with unsafe high bits -> close 1009 MESSAGE_TOO_BIG', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      // Build FIN+TEXT with LEN=127 and high part beyond safe mask
      const b0 = 0x80 | 0x1; // FIN + TEXT
      const b1 = 0x80 | 0x7f; // MASK + 127
      const hdr = Buffer.alloc(2 + 8);
      hdr[0] = b0;
      hdr[1] = b1;
      // High with bit outside safe (mask in parser is 0xffe00000)
      hdr.writeUInt32BE(0x00200000, 2);
      hdr.writeUInt32BE(0x00000000, 6);
      client.socket.write(hdr);
      // no mask/payload needed; parser rejects on length alone
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, CLOSE_CODES.MESSAGE_TOO_BIG);
  assert.ok(
    String(result.reason).toLowerCase().includes('too big'),
    `unexpected reason: ${result.reason}`,
  );

  await new Promise((r) => httpServer.close(r));
});

test('frames: user close (3001 "user") echoed back', async () => {
  const { httpServer, port } = await startServer((conn) =>
    conn.on('error', () => {}),
  );
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('open', () => {
      const reason = Buffer.from('user');
      const payload = Buffer.alloc(2 + reason.length);
      payload.writeUInt16BE(3001, 0);
      reason.copy(payload, 2);
      client.sendFrame(OPCODES.CLOSE, payload, { mask: true });
    });
    client.on('close', (code, reason) => resolve({ code, reason }));
  });

  assert.strictEqual(result.code, 3001);
  assert.strictEqual(result.reason, 'user');
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: chunked TCP — split header and payload (TEXT) — echoed back', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.on('message', (msg) => conn.send(String(msg)));
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const payload = Buffer.from('Chunked!'); // 8 bytes
  const fin = 0x80;
  const opcode = 0x1; // TEXT
  const b0 = fin | opcode; // 0x81
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  const b1 = 0x80 | payload.length; // MASK + len (<126)

  const received = await new Promise((resolve) => {
    client.on('message', (buf) => {
      resolve(buf.toString());
      client.close();
    });
    client.on('open', async () => {
      // Write header/payload in small chunks with tiny delays
      // to simulate segmentation
      client.socket.write(Buffer.from([b0]));
      await delay();
      client.socket.write(Buffer.from([b1]));
      await delay();
      // split mask into 2 writes
      client.socket.write(mask.subarray(0, 2));
      await delay();
      client.socket.write(mask.subarray(2));
      await delay();
      // payload by 3 chunks
      client.socket.write(masked.subarray(0, 3));
      await delay();
      client.socket.write(masked.subarray(3, 6));
      await delay();
      client.socket.write(masked.subarray(6));
    });
  });

  assert.strictEqual(received, payload.toString());
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: chunked TCP — 16-bit length (126) with split header — echoed back', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.on('message', (msg) => conn.send(String(msg)));
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const str = 'a'.repeat(126);
  const payload = Buffer.from(str);
  const fin = 0x80;
  const opcode = 0x1; // TEXT
  const b0 = fin | opcode; // 0x81
  const b1 = 0x80 | 126; // MASK + 126 (16-bit length follows)
  const lenHi = (payload.length >>> 8) & 0xff;
  const lenLo = payload.length & 0xff;
  const mask = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

  const received = await new Promise((resolve) => {
    client.on('message', (buf) => {
      resolve(buf.toString());
      client.close();
    });
    client.on('open', async () => {
      client.socket.write(Buffer.from([b0]));
      await delay();
      client.socket.write(Buffer.from([b1]));
      await delay();
      // write 16-bit length split into two writes
      client.socket.write(Buffer.from([lenHi]));
      await delay();
      client.socket.write(Buffer.from([lenLo]));
      await delay();
      // mask in two parts
      client.socket.write(mask.subarray(0, 2));
      await delay();
      client.socket.write(mask.subarray(2));
      await delay();
      // payload in ~5 chunks to keep test fast
      const step = 32;
      for (let i = 0; i < masked.length; i += step) {
        client.socket.write(masked.subarray(i, i + step));
        await delay();
      }
    });
  });

  assert.strictEqual(received, str);
  await new Promise((r) => httpServer.close(r));
});

test('frames: server responses are not masked (pong)', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const ok = await new Promise((resolve) => {
    client.on('frame', (opcode, payload, meta) => {
      if (opcode === OPCODES.PONG) {
        resolve(meta && meta.masked === false);
        client.close();
      }
    });
    client.on('open', () => {
      client.ping(Buffer.from('z'), { mask: true });
    });
  });

  assert.strictEqual(ok, true);
  await new Promise((r) => httpServer.close(r));
});

test('frames: server-initiated close (1000 "srv")', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.sendClose(1000, 'srv');
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const result = await new Promise((resolve) => {
    client.on('close', (code, reason) => resolve({ code, reason }));
    client.on('open', () => {});
  });

  assert.strictEqual(result.code, 1000);
  assert.strictEqual(result.reason, 'srv');
  await new Promise((r) => httpServer.close(r));
});

// eslint-disable-next-line max-len
test('frames: server ping -> client replies pong, server receives', async () => {
  const { httpServer, port } = await startServer((conn) => {
    conn.on('error', () => {});
    conn.on('pong', (buf) => {
      if (buf && buf.toString() === 'ok') conn.sendClose(1000, 'done');
    });
    process.nextTick(() => conn.sendPing(Buffer.from('ok')));
  });
  const client = new ProtocolClient(`ws://localhost:${port}`);

  const ok = await new Promise((resolve) => {
    client.on('open', () => {});
    client.on('frame', (opcode, payload) => {
      if (opcode === OPCODES.PING) {
        client.sendFrame(OPCODES.PONG, payload, { mask: true });
      }
    });
    client.on('close', (code, reason) => {
      resolve(code === 1000 && reason === 'done');
    });
  });

  assert.strictEqual(ok, true);
  await new Promise((r) => httpServer.close(r));
});
