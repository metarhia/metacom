'use strict';

class Result {
  #value;
  #error;

  constructor({ value, error }) {
    this.#value = value;
    this.#error = error;
  }

  static from(input) {
    const res =
      input instanceof globalThis.Error
        ? { value: null, error: input }
        : { value: input, error: null };
    return new this(res);
  }

  static empty() {
    return new this({ value: null, error: null });
  }

  get value() {
    return this.#value;
  }

  get error() {
    return this.#error;
  }
}

module.exports = { Result };
