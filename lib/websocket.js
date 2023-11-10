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
const MAX_64_BIT_PAYLOAD = Number.MAX_SAFE_INTEGER;
const HEAD_LENGTH = 2;
const EXTENDED_PAYLOAD_16_LENGTH = 2;
const EXTENDED_PAYLOAD_64_LENGTH = 8;

class Frame {
  #frame = null;
  #masked = null;
  #dataOffset = null;
  #mask = null;
  #length = null;

  constructor(frame) {
    this.#frame = frame;
    const length = this.#frame[1] & 0x7f;
    this.#masked = (frame[1] & 0x80) === 0x80;
    if (length < 126) {
      this.#dataOffset = HEAD_LENGTH + MASK_LENGTH;
      this.#mask = frame.subarray(HEAD_LENGTH, HEAD_LENGTH + MASK_LENGTH);
      this.#length = length;
    } else if (length === 126) {
      this.#dataOffset = HEAD_LENGTH + EXTENDED_PAYLOAD_16_LENGTH + MASK_LENGTH;
      this.#mask = frame.subarray(
        HEAD_LENGTH + EXTENDED_PAYLOAD_16_LENGTH,
        HEAD_LENGTH + EXTENDED_PAYLOAD_16_LENGTH + MASK_LENGTH,
      );
      this.#length = this.#frame.readUInt16BE(2);
    } else {
      this.#dataOffset = HEAD_LENGTH + EXTENDED_PAYLOAD_64_LENGTH + MASK_LENGTH;
      this.#mask = frame.subarray(
        HEAD_LENGTH + EXTENDED_PAYLOAD_64_LENGTH,
        HEAD_LENGTH + EXTENDED_PAYLOAD_64_LENGTH + MASK_LENGTH,
      );
      this.#length = (frame.readUInt32BE(2) << 32) + frame.readUInt32BE(4);
    }
  }
  unmask() {
    if (!this.#masked) return;
    for (let i = 0; i < this.#length; ++i) {
      this.#frame[this.#dataOffset + i] ^= this.#mask[i & 3];
    }
  }

  toString() {
    return this.#frame.toString(
      'utf8',
      this.#dataOffset,
      this.#dataOffset + this.#length,
    );
  }

  get frame() {
    return this.#frame;
  }

  static from(data) {
    if (Buffer.isBuffer(data)) {
      if (data.length === 0) throw new Error('Empty frame!');
      if ((data[1] & 0x80) !== 0x80) throw new Error('1002: protocol error');
      //
      // The maximum safe integer in JavaScript is 2^53 - 1. An error is returned
      // if payload length is greater than this number.
      //
      if ((data[2] & 0x7f) === 127) {
        const upperInt = data.readUInt32BE(2);
        if (upperInt > MAX_64_BIT_PAYLOAD >> 32)
          throw new Error(
            '1009: Unsupported WebSocket frame: payload length > 2^53 - 1',
          );
      }
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
      } else if (length < MAX_64_BIT_PAYLOAD) {
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
