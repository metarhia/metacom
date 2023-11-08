'use strict';

const crypto = require('node:crypto');

const EOL = '\r\n';
const UPGRADE = [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Accept: ',
].join(EOL);
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MASK_LENGTH = 4;
const PING_TIMEOUT = 5000;
const PING = Buffer.from([0x89, 0]);
const OPCODE_SHORT = 0x81;
const LEN_16_BIT = 126;
const MAX_16_BIT = 65536;
const LEN_64_BIT = 127;
const MAX_64_BIT = 0x7fffffffffffffffn + 1n;

class Frame {
  #frame = null;
  #masked = null;
  #dataOffset = null;
  #mask = null;
  #length = null;

  constructor(frame) {
    this.#frame = frame;
    const length = BigInt(this.#frame[1] & 0x7f);
    this.#masked = true;
    switch (length) {
      case 127n:
        this.#dataOffset = 2 + 8 + MASK_LENGTH;
        this.#mask = frame.subarray(2 + 8, 10 + MASK_LENGTH);
        this.#length = frame.readBigUInt64BE(2);
        break;
      case 126n:
        this.#dataOffset = 2 + 2 + MASK_LENGTH;
        this.#mask = frame.subarray(2 + 2, 4 + MASK_LENGTH);
        this.#length = BigInt(this.#frame.readUInt16BE(2));
        break;
      default:
        this.#dataOffset = 2 + MASK_LENGTH;
        this.#mask = frame.subarray(2, 2 + MASK_LENGTH);
        this.#length = length;
    }
  }

  unmask() {
    if (!this.#masked) return;
    for (let i = 0n; i < this.#length; ++i) {
      this.#frame[BigInt(this.#dataOffset) + i] ^=
        this.#mask[i & 0x0000000000000003n];
    }
  }

  toString() {
    return this.#frame.toString(
      'utf8',
      this.#dataOffset,
      Number(BigInt(this.#dataOffset) + this.#length),
    );
  }

  get frame() {
    return this.#frame;
  }

  static from(data) {
    if (Buffer.isBuffer(data)) {
      if (data.length === 0) throw new Error('Empty frame!');
      if ((data[1] & 0x80) !== 0x80) throw new Error('1002: protocol error');
      return new Frame(data);
    }

    if (typeof data === 'string') {
      if (data.length === 0) throw new Error('Empty string!');
      const payload = Buffer.from(data);
      const length = payload.length;
      let meta = Buffer.alloc(2);
      meta[0] = 0x81; // FIN = 1, RSV = 0b000, opcode = 0b0001 (text frame)
      if (length < LEN_16_BIT) {
        meta[1] = length;
      } else if (length < MAX_16_BIT) {
        const len = Buffer.alloc(2);
        len.writeUint16BE(length, 0);
        meta[1] = LEN_16_BIT;
        meta = Buffer.concat([meta, len]);
      } else if (length < MAX_64_BIT) {
        const len = Buffer.alloc(8);
        len.writeBigUInt64BE(BigInt(length), 0);
        meta[1] = LEN_64_BIT;
        this.meta = Buffer.concat([meta, len]);
      } else {
        throw new Error('string is too long to encode in one frame!');
      }
      const frame = Buffer.concat([meta, payload]);
      return new Frame(Buffer.from(frame));
    }

    throw new Error('Unsupported');
  }
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    socket.on('data', (data) => {
      this.receive(data);
    });
    socket.on('error', (error) => {
      console.log(error.code);
    });
    setInterval(() => {
      socket.write(PING);
    }, PING_TIMEOUT);
  }

  send(text) {
    const frame = Frame.from(text);
    this.socket.write(frame.frame);
  }

  receive(data) {
    console.log('data: ', data[0], data.length);
    if (data[0] !== OPCODE_SHORT) return;
    const frame = Frame.from(data);
    frame.unmask();
    const text = frame.toString();
    console.log('Message:', text);
    this.send(`Echo "${text}"`);
  }

  accept(key) {
    const hash = crypto.createHash('sha1');
    hash.update(key + MAGIC);
    const packet = UPGRADE + hash.digest('base64');
    this.socket.write(packet + EOL + EOL);
  }
}

const init = (server) => {
  server.on('upgrade', (req, socket, head) => {
    const ws = new Connection(socket);
    const key = req.headers['sec-websocket-key'];
    ws.accept(key);
    ws.receive(head);
  });
};

module.exports = { init };
