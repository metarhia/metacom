'use strict';

const { EventEmitter } = require('events');

class MockSocket extends EventEmitter {
  #isCorked = false;
  #pendingWrites = [];

  constructor() {
    super();
    this.writtenData = [];
    this.ended = false;
    this.destroyed = false;
  }

  cork() {
    this.#isCorked = true;
  }

  uncork() {
    this.#isCorked = false;
    if (this.#pendingWrites.length) {
      let combined = this.#pendingWrites.join('');
      const first = this.#pendingWrites[0];
      if (Buffer.isBuffer(first)) {
        combined = Buffer.concat(this.#pendingWrites);
      }
      this.write(combined);
      this.#pendingWrites.length = 0;
    }
  }

  write(data) {
    if (this.#isCorked) {
      this.#pendingWrites.push(data);
    } else {
      this.writtenData.push(data);
    }
  }

  end(data) {
    if (data !== undefined) this.write(data);
    this.ended = true;
    process.nextTick(() => this.emit('close'));
  }

  destroy() {
    this.destroyed = true;
    process.nextTick(() => this.emit('close'));
  }
}

module.exports = { MockSocket };
