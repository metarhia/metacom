'use strict';

const { EventEmitter } = require('node:events');

const { OPCODES, DATA_OPCODES, CLOSE_CODES } = require('./constants.js');
const { Frame } = require('./frame.js');
const { FrameParser, isValidUTF8 } = require('./frameParser.js');

const MAX_BUFFER = 1024 * 1024 * 100;
const CLOSE_TIMEOUT = 1000;

class Connection extends EventEmitter {
  #socket;
  #isClient;
  #recvBuffer;
  #maxBuffer;
  #closeTimeout;
  #closing = false;
  #closeSent = false;
  #closeReceived = false;
  #fragments = null;
  #closeTimer = null;

  constructor(socket, head, options = {}) {
    super();
    this.#socket = socket;
    this.#recvBuffer = null;

    const {
      isClient = false,
      maxBuffer = MAX_BUFFER,
      closeTimeout = CLOSE_TIMEOUT,
    } = options;
    this.#isClient = isClient;
    this.#maxBuffer = maxBuffer;
    this.#closeTimeout = closeTimeout;
    this.#init(head);
  }

  #init(head) {
    this.#socket.on('data', (data) => this.#receive(data));
    this.#socket.on('error', (error) => {
      if (this.#socket.destroyed) return;
      this.emit('error', error);
      this.terminate();
    });
    this.#socket.on('close', () => {
      if (this.#closeTimer) clearTimeout(this.#closeTimer);
      this.emit('close');
    });

    // received data before upgrade
    if (head && head.length > 0) this.#receive(head);
  }

  #receive(data) {
    if (this.#closeReceived && this.#closing) return;

    this.#recvBuffer = this.#recvBuffer
      ? Buffer.concat([this.#recvBuffer, data])
      : data;

    if (this.#recvBuffer.length > this.#maxBuffer) {
      this.emit('error', new Error('Buffer overflow, closing connection'));
      if (this.#isClient) {
        return void this.sendClose(
          CLOSE_CODES.MESSAGE_TOO_BIG,
          'Message too big',
        );
      }
      return void this.#close(Frame.errorClose('MESSAGE_TOO_BIG'));
    }

    this.#processFrame();
  }

  #processFrame() {
    while (true) {
      const result = FrameParser.parse(this.#recvBuffer);
      const { value, error } = result;
      if (error) return void this.#processFrameParserError(error);
      if (!value) break;

      const { frame, bytesUsed } = result.value;
      if (!this.#isClient && !frame.masked) {
        return void this.#close(Frame.protocolErrorClose('UNMASKED'));
      }
      if (this.#isClient && frame.masked) {
        return void this.#close(
          Frame.protocolErrorClose('MASKED', this.#isClient),
        );
      }

      if (frame.masked) frame.unmaskPayload();
      this.#recvBuffer = this.#recvBuffer.subarray(bytesUsed);
      if (this.#closing && !frame.isControlFrame) continue;
      if (frame.isControlFrame) {
        this.#processControlFrame(frame);
      } else {
        this.#processDataFrame(frame);
      }
    }
  }

  #processControlFrame(frame) {
    const { error } = FrameParser.checkControlFrame(frame);
    if (error) return void this.#processFrameParserError(error);

    const { opcode } = frame;
    if (opcode === OPCODES.PING) return void this.sendPong(frame.payload);
    if (opcode === OPCODES.PONG) return void this.emit('pong', frame.payload);
    if (opcode === OPCODES.CLOSE) {
      this.#closeReceived = true;
      const { code, reason } = frame.getCloseDetails().value;
      if (!this.#closeSent) {
        return void this.sendClose(code, reason);
      } else {
        return void this.terminate();
      }
    }
  }

  #processDataFrame(frame) {
    const { error } = FrameParser.checkDataFrame(frame);
    if (error) return void this.#processFrameParserError(error);

    const { opcode } = frame;
    if (DATA_OPCODES.has(opcode)) {
      this.#handleDataFrame(frame);
    }
  }

  #processFrameParserError(error) {
    const { code } = error;
    const [type, subtype] = code.split('-');
    this.emit('error', error);
    if (type === 'PROTOCOL_ERROR') {
      this.#close(Frame.protocolErrorClose(subtype, this.#isClient));
    } else {
      this.#close(Frame.errorClose(type, this.#isClient));
    }
  }

  #trackMessageSize(size) {
    const tooBig = size > this.#maxBuffer;
    if (tooBig) {
      this.emit('error', new Error('Message too big'));
      if (this.#isClient) {
        this.sendClose(CLOSE_CODES.MESSAGE_TOO_BIG, 'Message too big');
      } else {
        this.#close(Frame.errorClose('MESSAGE_TOO_BIG'));
      }
    }
    return !tooBig;
  }

  #handleDataFrame(frame) {
    const { opcode, payload } = frame;
    if (!this.#fragments) {
      // Continuation frame without a started fragmented message
      if (opcode === OPCODES.CONTINUATION) {
        this.emit(
          'error',
          new Error('Protocol error: Unexpected CONTINUATION without start'),
        );
        return void this.#close(
          Frame.protocolErrorClose('COMMON', this.#isClient),
        );
      }
      if (frame.fin) {
        // single frame
        const isBinary = opcode === OPCODES.BINARY;
        this.emit('message', frame.payload, isBinary);
      } else {
        if (!this.#trackMessageSize(payload.length)) return;
        this.#fragments = {
          opcode,
          payloads: [payload],
          totalSize: payload.length,
        };
      }
    } else if (opcode === OPCODES.CONTINUATION) {
      // continue fragments
      const totalSize = this.#fragments.totalSize + payload.length;
      if (!this.#trackMessageSize(totalSize)) return;
      this.#fragments.totalSize = totalSize;
      this.#fragments.payloads.push(frame.payload);
      if (!frame.fin) return;
      const isBinary = this.#fragments.opcode === OPCODES.BINARY;
      const isText = this.#fragments.opcode === OPCODES.TEXT;
      const fullPayload = Buffer.concat(this.#fragments.payloads);
      if (isText && !isValidUTF8(fullPayload)) {
        this.emit('error', new Error('Invalid UTF-8 in text frame'));
        return void this.#close(
          Frame.errorClose('INVALID_PAYLOAD', this.#isClient),
        );
      }
      this.#fragments = null;
      this.emit('message', fullPayload, isBinary);
    } else {
      this.emit(
        'error',
        new Error('Protocol error: Unexpected data frame during fragments'),
      );
      this.#close(Frame.protocolErrorClose('COMMON', this.#isClient));
    }
  }

  send(data) {
    if (typeof data === 'string') return this.sendText(data);
    if (Buffer.isBuffer(data)) return this.sendBinary(data);
    throw new TypeError('send() accepts only string or Buffer');
  }

  sendText(message) {
    if (this.#closing) return false;
    const frame = Frame.text(message);
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
    return true;
  }

  sendBinary(buffer) {
    if (this.#closing) return false;
    const frame = Frame.binary(buffer);
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
    return true;
  }

  sendPing(payload) {
    if (this.#closing) return false;
    if (!payload) return this.#fastPing();
    const frame = Frame.ping(payload);
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
    return true;
  }

  sendPong(payload) {
    if (!payload) return this.#fastPong();
    const frame = Frame.pong(payload);
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
    return true;
  }

  #fastPing() {
    return this.#socket.write(Frame.emptyPingBuffer(this.#isClient));
  }

  #fastPong() {
    return this.#socket.write(Frame.emptyPongBuffer(this.#isClient));
  }

  #close(frameBuffer) {
    if (this.#closing) return;
    this.#closing = true;
    this.#closeSent = true;
    this.#fragments = null;

    this.#socket.write(frameBuffer);

    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
    }
    this.#closeTimer = setTimeout(() => {
      this.#socket.end();
      setTimeout(() => {
        this.#socket.destroy();
      }, 200);
    }, this.#closeTimeout);
  }

  sendClose(code = 1000, reason = '') {
    const frame = Frame.close(code, reason);
    if (this.#isClient) frame.maskPayload();
    this.#close(frame.toBuffer());
  }

  terminate() {
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    if (!this.#socket.destroyed) this.#socket.destroy();
  }
}

module.exports = { Connection, CLOSE_TIMEOUT };
