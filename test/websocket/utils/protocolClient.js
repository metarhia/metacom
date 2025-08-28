'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('node:events');

const TWO_32 = 4294967296;

function parseStatusCode(statusLine) {
  if (!statusLine) return null;
  const parts = statusLine.split(' ');
  const code = parseInt(parts[1], 10);
  return Number.isFinite(code) ? code : null;
}

// Minimal low-level client for protocol tests.
// Events: 'open', 'message'(Buffer), 'frame'(opcode, Buffer), 'ping'(Buffer),
// 'pong'(Buffer), 'close'(code, reason)
// Methods: send(data), sendFrame(opcode, payload, { fin=true, mask=true }),
// sendText, sendBinary, ping, close
class ProtocolClient extends EventEmitter {
  constructor(url) {
    super();
    const u = new URL(url);
    const port = u.port || 80;
    const host = u.hostname || 'localhost';

    this._buffer = Buffer.alloc(0);
    this._opened = false;
    this._closeSent = false;
    this._fragments = null; // { opcode, chunks: Buffer[] }

    this.socket = net.connect({ port, host }, () => {
      // Reduce Nagle latency for faster test handshakes/frames
      this.socket.setNoDelay(true);
      const key = crypto.randomBytes(16).toString('base64');
      const req = [
        `GET ${u.pathname || '/'} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n');
      this.socket.write(req);
    });

    this.socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);

      if (!this._opened) {
        const idx = this._buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const header = this._buffer.subarray(0, idx).toString();
        const statusLine = header.split('\r\n', 1)[0] || '';
        const code = parseStatusCode(statusLine);
        if (code !== 101) {
          this.socket.destroy();
          this.emit('close');
          return;
        }
        this._opened = true;
        this._buffer = this._buffer.subarray(idx + 4);
        this.emit('open');
      }

      while (this._buffer.length >= 2) {
        const b0 = this._buffer[0];
        const b1 = this._buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (this._buffer.length < offset + 2) break;
          len = this._buffer.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (this._buffer.length < offset + 8) break;
          const high = this._buffer.readUInt32BE(offset);
          const low = this._buffer.readUInt32BE(offset + 4);
          len = high * TWO_32 + low;
          offset += 8;
        }

        const maskLen = masked ? 4 : 0;
        if (this._buffer.length < offset + maskLen + len) break;

        let payload = this._buffer.subarray(
          offset + maskLen,
          offset + maskLen + len,
        );
        if (masked) {
          const mask = this._buffer.subarray(offset, offset + 4);
          const un = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            un[i] = payload[i] ^ mask[i % 4];
          }
          payload = un;
        }

        this._buffer = this._buffer.subarray(offset + maskLen + len);

        if (opcode === 0x0) {
          // CONTINUATION
          if (this._fragments) {
            this._fragments.chunks.push(payload);
            if (fin) {
              const full = Buffer.concat(this._fragments.chunks);
              const startOpcode = this._fragments.opcode;
              this._fragments = null;
              this.emit('frame', startOpcode, full, { fin, masked });
              if (startOpcode === 0x1) this.emit('message', full);
            }
          }
          continue;
        }

        if (opcode === 0x1 || opcode === 0x2) {
          // TEXT / BINARY
          if (!fin) {
            this._fragments = { opcode, chunks: [payload] };
            continue;
          }
          this.emit('frame', opcode, payload, { fin, masked });
          if (opcode === 0x1) this.emit('message', payload);
          continue;
        }

        if (opcode === 0x9) {
          // PING
          this.emit('frame', opcode, payload, { fin, masked });
          this.emit('ping', payload);
          continue;
        }

        if (opcode === 0xa) {
          // PONG
          this.emit('frame', opcode, payload, { fin, masked });
          this.emit('pong', payload);
          continue;
        }

        if (opcode === 0x8) {
          // CLOSE
          let code = 1005; // no status
          let reason = '';
          if (payload.length >= 2) {
            code = payload.readUInt16BE(0);
            if (payload.length > 2) reason = payload.subarray(2).toString();
          }
          this.emit('frame', opcode, payload, { fin, masked });
          this.socket.end();
          this.emit('close', code, reason);
          continue;
        }

        this.emit('frame', opcode, payload, { fin, masked });
      }
    });

    const onEndOrClose = () => {
      this.emit('close');
    };
    this.socket.on('end', onEndOrClose);
    this.socket.on('close', onEndOrClose);
    this.socket.on('error', () => {
      this.socket.destroy();
      this.emit('close');
    });
  }

  _sendFrame(opcode, payload, { fin = true, mask = true } = {}) {
    const finOp = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
    const payloadBuf = Buffer.from(payload || '');
    const len = payloadBuf.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2 + (mask ? 4 : 0));
      header[0] = finOp;
      header[1] = (mask ? 0x80 : 0x00) | len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4 + (mask ? 4 : 0));
      header[0] = finOp;
      header[1] = (mask ? 0x80 : 0x00) | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10 + (mask ? 4 : 0));
      header[0] = finOp;
      header[1] = (mask ? 0x80 : 0x00) | 127;
      const high = Math.trunc(len / TWO_32);
      const low = len >>> 0;
      header.writeUInt32BE(high, 2);
      header.writeUInt32BE(low, 6);
    }

    let out;
    if (mask) {
      const maskKey = crypto.randomBytes(4);
      const maskOffset = header.length - 4;
      maskKey.copy(header, maskOffset);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ maskKey[i % 4];
      out = Buffer.concat([header, masked]);
    } else {
      out = Buffer.concat([header, payloadBuf]);
    }

    this.socket.write(out);
  }

  sendFrame(opcode, payload, opts) {
    this._sendFrame(opcode, payload, opts);
  }

  sendText(str, opts) {
    this._sendFrame(0x1, Buffer.from(String(str)), opts);
  }

  sendBinary(buf, opts) {
    this._sendFrame(0x2, Buffer.from(buf || Buffer.alloc(0)), opts);
  }

  ping(payload = Buffer.alloc(0), opts) {
    this._sendFrame(0x9, Buffer.from(payload), opts);
  }

  // Convenience: send string as text, Buffer/TypedArray/ArrayBuffer as binary;
  // others stringified
  send(data, opts) {
    if (typeof data === 'string') return this.sendText(data, opts);
    if (Buffer.isBuffer(data)) return this.sendBinary(data, opts);
    if (data && ArrayBuffer.isView(data)) {
      const view = data; // TypedArray/DataView
      return this.sendBinary(
        Buffer.from(view.buffer, view.byteOffset, view.byteLength),
        opts,
      );
    }
    if (data instanceof ArrayBuffer) {
      return this.sendBinary(Buffer.from(data), opts);
    }
    return this.sendText(String(data), opts);
  }

  close(code = 1000, reason = '') {
    if (this.socket.destroyed || this._closeSent) return;
    const reasonBuf = Buffer.from(String(reason));
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this._closeSent = true;
    this.socket.end();
  }

  // Attempts an HTTP Upgrade handshake with custom headers.
  // Options: { host, port, path, headers, method, httpVersion,
  // includeHost, timeoutMs }
  // Returns { statusLine, headers, raw, socketClosed }
  static attemptHandshake({
    host = 'localhost',
    port,
    path = '/',
    headers = {},
    method = 'GET',
    httpVersion = '1.1',
    includeHost = true,
    timeoutMs = 400,
  }) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port }, () => {
        // Lower latency and enforce a hard timeout at the socket level
        socket.setNoDelay(true);
        socket.setTimeout(timeoutMs, () => socket.destroy());
        const lines = [];
        lines.push(`${method} ${path} HTTP/${httpVersion}`);
        if (includeHost) lines.push(`Host: ${host}:${port}`);
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        lines.push('\r\n');
        socket.write(lines.join('\r\n'));
      });

      let buf = Buffer.alloc(0);
      let closed = false;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        const idx = buf.indexOf('\r\n\r\n');
        const head = idx !== -1 ? buf.slice(0, idx).toString() : buf.toString();
        const [statusLine, ...headerLines] = head.split(/\r?\n/);
        const headersObj = {};
        for (const line of headerLines) {
          const m = line.match(/^([^:]+):\s*(.*)$/);
          if (m) headersObj[m[1].toLowerCase()] = m[2];
        }
        resolve({
          statusLine: statusLine || '',
          headers: headersObj,
          raw: head,
          socketClosed: closed,
        });
      };

      const t = setTimeout(() => {
        socket.destroy();
      }, timeoutMs);

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.indexOf('\r\n\r\n') !== -1) {
          clearTimeout(t);
          finish();
          socket.destroy();
        }
      });

      const end = () => {
        closed = true;
        finish();
      };
      socket.on('end', end);
      socket.on('close', end);
      socket.on('error', end);
    });
  }
}

module.exports = { ProtocolClient };
