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
      const combined = Buffer.isBuffer(this.#pendingWrites[0])
        ? Buffer.concat(this.#pendingWrites)
        : this.#pendingWrites.join('');
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

module.exports = {
  MockSocket,
};
