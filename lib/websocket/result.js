'use strict';

class Result {
  #value = null;
  #error = null;

  constructor(value = null, error = null) {
    this.#value = value;
    this.#error = error;
  }

  static ok(value = null) {
    return new Result(value);
  }

  static fail(error = new Error('Result failed')) {
    return new Result(null, error);
  }

  get value() {
    return this.#value;
  }

  get error() {
    return this.#error;
  }

  get ok() {
    return this.#error === null;
  }
}

module.exports = { Result };
