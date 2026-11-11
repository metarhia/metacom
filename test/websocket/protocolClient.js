'use strict';

const { EventEmitter } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');

const TWO_32 = 4294967296;

const parseStatusCode = (statusLine) => {
  if (!statusLine) return null;
  const parts = statusLine.split(' ');
  const code = parseInt(parts[1], 10);
  return Number.isFinite(code) ? code : null;
};

const buildUpgradeRequest = (host, port, path, key) => {
  const lines = [
    `GET ${path || '/'} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ];
  return lines.join('\r\n');
};

const createFrameHeader = (finOp, mask, length) => {
  const maskBit = mask ? 0x80 : 0x00;
  const maskBytes = mask ? 4 : 0;
  if (length < 126) {
    const header = Buffer.alloc(2 + maskBytes);
    header[0] = finOp;
    header[1] = maskBit | length;
    return header;
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4 + maskBytes);
    header[0] = finOp;
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10 + maskBytes);
  header[0] = finOp;
  header[1] = maskBit | 127;
  const high = Math.trunc(length / TWO_32);
  const low = length >>> 0;
  header.writeUInt32BE(high, 2);
  header.writeUInt32BE(low, 6);
  return header;
};

class ProtocolClient extends EventEmitter {
  #handlers = null;

  constructor(url) {
    super();
    const parsedUrl = new URL(url);
    const port = parsedUrl.port || 80;
    const host = parsedUrl.hostname || 'localhost';

    this._buffer = Buffer.alloc(0);
    this._opened = false;
    this._closeSent = false;
    this._fragments = null; // { opcode, chunks: Buffer[] }

    this.#handlers = {
      0x0: this.#handleContinuation,
      0x1: this.#handleText,
      0x2: this.#handleBinary,
      0x8: this.#handleClose,
      0x9: this.#handlePing,
      0xa: this.#handlePong,
    };

    this.socket = ProtocolClient.#createSocket(parsedUrl, host, port);
    this.#attachSocketListeners();
  }

  static #createSocket(url, host, port) {
    const socket = net.connect({ port, host }, () => {
      // Reduce Nagle latency for faster test handshakes/frames
      socket.setNoDelay(true);
      const key = crypto.randomBytes(16).toString('base64');
      const request = buildUpgradeRequest(host, port, url.pathname, key);
      socket.write(request);
    });
    return socket;
  }

  #attachSocketListeners() {
    this.socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      if (!this._opened && !this.#consumeHandshake()) return;
      this.#consumeFrames();
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

  #consumeHandshake() {
    const index = this._buffer.indexOf('\r\n\r\n');
    if (index === -1) return false;
    const header = this._buffer.subarray(0, index).toString();
    const statusLine = header.split('\r\n', 1)[0] || '';
    const code = parseStatusCode(statusLine);
    if (code !== 101) {
      this.socket.destroy();
      this.emit('close');
      return false;
    }
    this._opened = true;
    this._buffer = this._buffer.subarray(index + 4);
    this.emit('open');
    return true;
  }

  #consumeFrames() {
    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let length = secondByte & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this._buffer.length < offset + 2) break;
        length = this._buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this._buffer.length < offset + 8) break;
        const high = this._buffer.readUInt32BE(offset);
        const low = this._buffer.readUInt32BE(offset + 4);
        length = high * TWO_32 + low;
        offset += 8;
      }

      const maskBytes = masked ? 4 : 0;
      if (this._buffer.length < offset + maskBytes + length) break;

      const payloadStart = offset + maskBytes;
      const frameEnd = payloadStart + length;
      const payload = this._buffer.subarray(payloadStart, frameEnd);
      if (masked) {
        const mask = this._buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 0x03];
        }
      }

      this._buffer = this._buffer.subarray(frameEnd);

      this.#dispatchFrame({ opcode, fin, masked, payload });
    }
  }

  #dispatchFrame({ opcode, fin, masked, payload }) {
    const handler = this.#handlers && this.#handlers[opcode];
    if (handler) {
      handler.call(this, { opcode, fin, masked, payload });
      return;
    }
    this.emit('frame', opcode, payload, { fin, masked });
  }

  #handleContinuation({ fin, masked, payload }) {
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
  }

  #handleText({ opcode, fin, masked, payload }) {
    if (!fin) {
      this._fragments = { opcode, chunks: [payload] };
      return;
    }
    this.emit('frame', opcode, payload, { fin, masked });
    this.emit('message', payload);
  }

  #handleBinary({ opcode, fin, masked, payload }) {
    if (!fin) {
      this._fragments = { opcode, chunks: [payload] };
      return;
    }
    this.emit('frame', opcode, payload, { fin, masked });
  }

  #handlePing({ opcode, fin, masked, payload }) {
    this.emit('frame', opcode, payload, { fin, masked });
    this.emit('ping', payload);
  }

  #handlePong({ opcode, fin, masked, payload }) {
    this.emit('frame', opcode, payload, { fin, masked });
    this.emit('pong', payload);
  }

  #handleClose({ opcode, fin, masked, payload }) {
    let code = 1005; // no status
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (payload.length > 2) reason = payload.subarray(2).toString();
    }
    this.emit('frame', opcode, payload, { fin, masked });
    this.socket.end();
    this.emit('close', code, reason);
  }

  _sendFrame(opcode, payload, { fin = true, mask = true } = {}) {
    const finOp = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
    const payloadBuffer = Buffer.from(payload || '');
    const length = payloadBuffer.length;
    const header = createFrameHeader(finOp, mask, length);

    if (!mask) {
      const plainFrame = Buffer.concat([header, payloadBuffer]);
      return void this.socket.write(plainFrame);
    }
    const maskKey = crypto.randomBytes(4);
    const maskOffset = header.length - 4;
    maskKey.copy(header, maskOffset);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      masked[i] = payloadBuffer[i] ^ maskKey[i % 4];
    }
    const maskedFrame = Buffer.concat([header, masked]);
    this.socket.write(maskedFrame);
  }

  sendFrame(opcode, payload, options) {
    this._sendFrame(opcode, payload, options);
  }

  sendText(text, options) {
    this._sendFrame(0x1, Buffer.from(`${text}`), options);
  }

  sendBinary(buffer, options) {
    this._sendFrame(0x2, Buffer.from(buffer || Buffer.alloc(0)), options);
  }

  ping(payload = Buffer.alloc(0), options) {
    this._sendFrame(0x9, Buffer.from(payload), options);
  }

  send(data, options) {
    if (typeof data === 'string') return this.sendText(data, options);
    if (Buffer.isBuffer(data)) return this.sendBinary(data, options);
    if (data && ArrayBuffer.isView(data)) {
      const { buffer, byteOffset, byteLength } = data;
      const view = Buffer.from(buffer, byteOffset, byteLength);
      return this.sendBinary(view, options);
    }
    if (data instanceof ArrayBuffer) {
      return this.sendBinary(Buffer.from(data), options);
    }
    return this.sendText(`${data}`, options);
  }

  close(code = 1000, reason = '') {
    if (this.socket.destroyed || this._closeSent) return;
    const reasonBuffer = Buffer.from(`${reason}`);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this._closeSent = true;
    this.socket.end();
  }

  static attemptHandshake(options) {
    const { port } = options;
    const host = options.host ?? 'localhost';
    const path = options.path ?? '/';
    const headers = options.headers ?? {};
    const method = options.method ?? 'GET';
    const httpVersion = options.httpVersion ?? '1.1';
    const includeHost = options.includeHost ?? true;
    const timeoutMs = options.timeoutMs ?? 400;
    return new Promise((resolve) => {
      const socket = net.connect({ host, port }, () => {
        // Lower latency and enforce a hard timeout at the socket level
        socket.setNoDelay(true);
        socket.setTimeout(timeoutMs, () => socket.destroy());
        const lines = [];
        lines.push(`${method} ${path} HTTP/${httpVersion}`);
        if (includeHost) lines.push(`Host: ${host}:${port}`);
        for (const name in headers) lines.push(`${name}: ${headers[name]}`);
        lines.push('\r\n');
        socket.write(lines.join('\r\n'));
      });

      let buffer = Buffer.alloc(0);
      let closed = false;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        const index = buffer.indexOf('\r\n\r\n');
        const end = index !== -1 ? index : buffer.length;
        const head = buffer.subarray(0, end).toString();
        const responseLines = head.split(/\r?\n/);
        const statusLine = responseLines[0];
        const headerLines = responseLines.slice(1);
        const parsedHeaders = {};
        for (const line of headerLines) {
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) parsedHeaders[match[1].toLowerCase()] = match[2];
        }
        resolve({
          statusLine: statusLine || '',
          headers: parsedHeaders,
          raw: head,
          socketClosed: closed,
        });
      };

      const timer = setTimeout(() => {
        socket.destroy();
      }, timeoutMs);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.indexOf('\r\n\r\n') !== -1) {
          clearTimeout(timer);
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
