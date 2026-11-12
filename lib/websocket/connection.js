'use strict';

const { isUtf8 } = require('node:buffer');
const { EventEmitter } = require('node:events');

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { Frame, EMPTY_PING, EMPTY_PONG } = require('./frame.js');
const { parse, frameLength, checkControl, checkData } = require('./parser.js');

const MAX_BUFFER_BYTES = 1024 * 1024 * 100;
const CLOSE_TIMEOUT = 1000;
const DESTROY_DELAY_MS = 200;
const MESSAGE_TOO_BIG = 'Message too big';
const UNEXPECTED_CONTINUATION = 'Unexpected CONTINUATION without start';
const UNEXPECTED_DATA_FRAME = 'Unexpected data frame during fragments';

class Connection extends EventEmitter {
  #socket = null;
  #isClient = false;
  #chunks = [];
  #bufferedBytes = 0;
  #neededBytes = 0;
  #maxBuffer = MAX_BUFFER_BYTES;
  #closeTimeout = CLOSE_TIMEOUT;
  #closing = false;
  #closeReceived = false;
  #fragments = null;
  #closeTimer = null;
  #drained = null;

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
      return void this.sendClose(MESSAGE_TOO_BIG);
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
      // Client frames must be masked, server frames must not
      if (frame.masked === this.#isClient) {
        this.#storePending(buffer);
        const type = this.#isClient ? 'MASKED' : 'UNMASKED';
        const closeFrame = Frame.protocolErrorClose(type, this.#isClient);
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
    if (opcode !== OPCODES.CLOSE) return;
    this.#closeReceived = true;
    const { code, reason } = frame.getCloseDetails().value;
    if (!this.#closing) return void this.sendClose(reason, code);
    this.terminate();
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
    if (size <= this.#maxBuffer) return true;
    const error = new Error(MESSAGE_TOO_BIG);
    this.emit('error', error);
    this.sendClose(MESSAGE_TOO_BIG);
    return false;
  }

  #failProtocol(reason) {
    const error = new Error(`Protocol error: ${reason}`);
    this.emit('error', error);
    const frame = Frame.protocolErrorClose('COMMON', this.#isClient);
    this.#close(frame);
  }

  #appendFragment(frame) {
    const { fin, payload } = frame;
    const fragments = this.#fragments;
    const totalSize = fragments.totalSize + payload.length;
    if (!this.#trackMessageSize(totalSize)) return;
    fragments.totalSize = totalSize;
    fragments.payloads.push(payload);
    if (!fin) return;
    const isBinary = fragments.opcode === OPCODES.BINARY;
    const isText = fragments.opcode === OPCODES.TEXT;
    const message = Buffer.concat(fragments.payloads);
    if (isText && !isUtf8(message)) {
      const error = new Error('Invalid UTF-8 in text frame');
      this.emit('error', error);
      const reason = 'Invalid payload data';
      const closeFrame = Frame.errorClose(reason, this.#isClient);
      return void this.#close(closeFrame);
    }
    this.#fragments = null;
    this.emit('message', message, isBinary);
  }

  #handleDataFrame(frame) {
    const { fin, opcode, payload } = frame;
    const isContinuation = opcode === OPCODES.CONTINUATION;
    if (this.#fragments) {
      if (isContinuation) return void this.#appendFragment(frame);
      return void this.#failProtocol(UNEXPECTED_DATA_FRAME);
    }
    if (isContinuation) return void this.#failProtocol(UNEXPECTED_CONTINUATION);
    if (fin) {
      const isBinary = opcode === OPCODES.BINARY;
      return void this.emit('message', payload, isBinary);
    }
    if (!this.#trackMessageSize(payload.length)) return;
    const payloads = [payload];
    const totalSize = payload.length;
    this.#fragments = { opcode, payloads, totalSize };
  }

  send(data) {
    if (typeof data === 'string') return this.sendText(data);
    if (Buffer.isBuffer(data)) return this.sendBinary(data);
    throw new TypeError('send() accepts only string or Buffer');
  }

  // Returns false when the socket buffer is full, as stream write does
  #writeFrame(frame) {
    if (this.#isClient) frame.maskPayload();
    this.#socket.cork();
    this.#socket.write(frame.header);
    this.#socket.write(frame.payload);
    this.#socket.uncork();
    return !this.#socket.writableNeedDrain;
  }

  sendText(message) {
    if (this.#closing) return false;
    return this.#writeFrame(Frame.text(message));
  }

  sendBinary(buffer) {
    if (this.#closing) return false;
    return this.#writeFrame(Frame.binary(buffer));
  }

  // Shared by all writers waiting for the socket buffer to flush
  drain() {
    const socket = this.#socket;
    const isFlushed = !socket.writableNeedDrain || socket.destroyed;
    if (isFlushed) return Promise.resolve();
    if (this.#drained) return this.#drained;
    this.#drained = new Promise((resolve) => {
      const onDone = () => {
        socket.off('drain', onDone);
        socket.off('close', onDone);
        this.#drained = null;
        resolve();
      };
      socket.on('drain', onDone);
      socket.on('close', onDone);
    });
    return this.#drained;
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
    const buffer = this.#isClient ? Frame.emptyClientPingBuffer() : EMPTY_PING;
    return this.#socket.write(buffer);
  }

  #fastPong() {
    const buffer = this.#isClient ? Frame.emptyClientPongBuffer() : EMPTY_PONG;
    return this.#socket.write(buffer);
  }

  #close(frameBuffer) {
    if (this.#closing) return;
    this.#closing = true;
    this.#fragments = null;
    this.#socket.write(frameBuffer);
    this.#closeTimer = setTimeout(() => {
      this.#socket.end();
      setTimeout(() => {
        this.#socket.destroy();
      }, DESTROY_DELAY_MS);
    }, this.#closeTimeout);
  }

  sendClose(reason = 'Normal closure', code) {
    const status = CLOSE_CODES[reason] ?? code;
    const frame = Frame.closeBuffer(status, reason, this.#isClient);
    this.#close(frame);
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
