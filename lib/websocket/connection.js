'use strict';

const { isUtf8 } = require('node:buffer');
const { EventEmitter } = require('node:events');

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { Frame, EMPTY_PING, EMPTY_PONG } = require('./frame.js');
const { parse, frameLength, checkControl, checkData } = require('./parser.js');

const MAX_BUFFER = 1024 * 1024 * 100;
const CLOSE_TIMEOUT = 1000;

class Connection extends EventEmitter {
  #socket = null;
  #isClient = false;
  #chunks = [];
  #bufferedBytes = 0;
  #neededBytes = 0;
  #maxBuffer = MAX_BUFFER;
  #closeTimeout = CLOSE_TIMEOUT;
  #closing = false;
  #closeSent = false;
  #closeReceived = false;
  #fragments = null;
  #closeTimer = null;

  constructor(socket, head, options = {}) {
    super();
    this.#socket = socket;
    const { isClient, maxBuffer, closeTimeout } = options;
    if (isClient !== undefined) this.#isClient = isClient;
    if (maxBuffer !== undefined) this.#maxBuffer = maxBuffer;
    if (closeTimeout !== undefined) this.#closeTimeout = closeTimeout;
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
    if (head && head.length > 0) this.#receive(head);
  }

  #receive(data) {
    if (this.#closeReceived && this.#closing) return;
    this.#chunks.push(data);
    this.#bufferedBytes += data.length;
    if (this.#bufferedBytes > this.#maxBuffer) {
      const error = new Error('Buffer overflow, closing connection');
      this.emit('error', error);
      if (this.#isClient) {
        return void this.sendClose('Message too big');
      }
      const frame = Frame.errorClose('Message too big');
      return void this.#close(frame);
    }
    // Skip concatenation and parsing until a whole frame has arrived
    if (this.#bufferedBytes < this.#neededBytes) return;
    this.#processFrame();
  }

  #storePending(buffer) {
    this.#bufferedBytes = buffer.length;
    if (buffer.length === 0) {
      if (this.#chunks.length > 0) this.#chunks = [];
      this.#neededBytes = 0;
      return;
    }
    this.#chunks = [buffer];
    this.#neededBytes = frameLength(buffer);
  }

  #processFrame() {
    let buffer = this.#chunks[0];
    if (this.#chunks.length !== 1) buffer = Buffer.concat(this.#chunks);
    while (true) {
      const { value, error } = parse(buffer);
      if (error) {
        this.#storePending(buffer);
        return void this.#processFrameParserError(error);
      }
      if (!value) break;

      const { frame, bytesUsed } = value;
      buffer = buffer.subarray(bytesUsed);
      if (!this.#isClient && !frame.masked) {
        this.#storePending(buffer);
        const closeFrame = Frame.protocolErrorClose('UNMASKED');
        return void this.#close(closeFrame);
      }
      if (this.#isClient && frame.masked) {
        this.#storePending(buffer);
        const closeFrame = Frame.protocolErrorClose('MASKED', this.#isClient);
        return void this.#close(closeFrame);
      }

      if (frame.masked) frame.unmaskPayload();
      if (this.#closing && !frame.isControlFrame) continue;
      if (frame.isControlFrame) {
        this.#processControlFrame(frame);
      } else {
        this.#processDataFrame(frame);
      }
    }
    this.#storePending(buffer);
  }

  #processControlFrame(frame) {
    const { error } = checkControl(frame);
    if (error) return void this.#processFrameParserError(error);
    const { opcode } = frame;
    if (opcode === OPCODES.PING) return void this.sendPong(frame.payload);
    if (opcode === OPCODES.PONG) return void this.emit('pong', frame.payload);
    if (opcode === OPCODES.CLOSE) {
      this.#closeReceived = true;
      const { code, reason } = frame.getCloseDetails().value;
      if (!this.#closeSent) {
        return void this.sendClose(reason, code);
      }
      return void this.terminate();
    }
  }

  #processDataFrame(frame) {
    const { error } = checkData(frame);
    if (error) return void this.#processFrameParserError(error);
    this.#handleDataFrame(frame);
  }

  #processFrameParserError(error) {
    const { code } = error;
    this.emit('error', error);
    let close = Frame.errorClose;
    if (Frame.isProtocolErrorType(code)) close = Frame.protocolErrorClose;
    const frame = close(code, this.#isClient);
    this.#close(frame);
  }

  #trackMessageSize(size) {
    const tooBig = size > this.#maxBuffer;
    if (tooBig) {
      const error = new Error('Message too big');
      this.emit('error', error);
      if (this.#isClient) {
        this.sendClose('Message too big');
      } else {
        const frame = Frame.errorClose('Message too big');
        this.#close(frame);
      }
    }
    return !tooBig;
  }

  #handleDataFrame(frame) {
    const { opcode, payload } = frame;
    if (!this.#fragments) {
      if (opcode === OPCODES.CONTINUATION) {
        const error = new Error(
          'Protocol error: Unexpected CONTINUATION without start',
        );
        this.emit('error', error);
        const frame = Frame.protocolErrorClose('COMMON', this.#isClient);
        return void this.#close(frame);
      }
      if (frame.fin) {
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
      const totalSize = this.#fragments.totalSize + payload.length;
      if (!this.#trackMessageSize(totalSize)) return;
      this.#fragments.totalSize = totalSize;
      this.#fragments.payloads.push(frame.payload);
      if (!frame.fin) return;
      const isBinary = this.#fragments.opcode === OPCODES.BINARY;
      const isText = this.#fragments.opcode === OPCODES.TEXT;
      const fullPayload = Buffer.concat(this.#fragments.payloads);
      if (isText && !isUtf8(fullPayload)) {
        const error = new Error('Invalid UTF-8 in text frame');
        this.emit('error', error);
        const frame = Frame.errorClose('Invalid payload data', this.#isClient);
        return void this.#close(frame);
      }
      this.#fragments = null;
      this.emit('message', fullPayload, isBinary);
    } else {
      const error = new Error(
        'Protocol error: Unexpected data frame during fragments',
      );
      this.emit('error', error);
      const frame = Frame.protocolErrorClose('COMMON', this.#isClient);
      return void this.#close(frame);
    }
  }

  send(data) {
    if (typeof data === 'string') return this.sendText(data);
    if (Buffer.isBuffer(data)) return this.sendBinary(data);
    throw new TypeError('send() accepts only string or Buffer');
  }

  #writeFrame(frame) {
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
  }

  sendText(message) {
    if (this.#closing) return false;
    this.#writeFrame(Frame.text(message));
    return true;
  }

  sendBinary(buffer) {
    if (this.#closing) return false;
    this.#writeFrame(Frame.binary(buffer));
    return true;
  }

  sendPing(payload) {
    if (this.#closing) return false;
    if (!payload) return this.#fastPing();
    this.#writeFrame(Frame.ping(payload));
    return true;
  }

  sendPong(payload) {
    if (!payload) return this.#fastPong();
    this.#writeFrame(Frame.pong(payload));
    return true;
  }

  #fastPing() {
    const buf = this.#isClient ? Frame.emptyClientPingBuffer() : EMPTY_PING;
    return this.#socket.write(buf);
  }

  #fastPong() {
    const buf = this.#isClient ? Frame.emptyClientPongBuffer() : EMPTY_PONG;
    return this.#socket.write(buf);
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

  sendClose(reason = 'Normal closure', code) {
    const status = CLOSE_CODES[reason] ?? code;
    const frame = Frame.close(status, reason);
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
