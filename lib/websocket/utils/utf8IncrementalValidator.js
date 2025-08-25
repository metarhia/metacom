'use strict';

/**
 * Utf8IncrementalValidator
 * Zero-allocation, streaming UTF-8 validator for fragmented
 * WebSocket TEXT messages.
 * - Maintains only a few integers of state.
 * - Enforces overlong, surrogate, and max code point rules.
 * - Returns boolean; call with { fin: true } on final fragment to ensure
 * no dangling sequence.
 */
class Utf8IncrementalValidator {
  constructor() {
    this.need = 0; // how many continuation bytes still required
    // 0 = none, 1 = check range for the first continuation byte
    this.firstContCheck = 0;
    this.minSecond = 0x80; // range for the first continuation byte when needed
    this.maxSecond = 0xbf;
    this.ok = true; // sticky error flag (optional, not required by push return)
  }

  reset() {
    this.need = 0;
    this.firstContCheck = 0;
    this.minSecond = 0x80;
    this.maxSecond = 0xbf;
    this.ok = true;
  }

  /**
   * Validate next chunk.
   * @param {Buffer|Uint8Array} buf
   * @param {boolean} [fin=false] - set true for the last fragment
   * of the message
   * @returns {boolean} true if valid so far; false if invalid
   * (validator becomes closed for further use)
   */
  push(buf, fin = false) {
    if (!this.ok) return false;

    let i = 0;
    const len = buf.length;
    let need = this.need;
    let firstContCheck = this.firstContCheck;
    let minSecond = this.minSecond;
    let maxSecond = this.maxSecond;

    while (i < len) {
      const b = buf[i];

      if (need > 0) {
        // Expect a continuation byte 10xxxxxx
        if ((b & 0xc0) !== 0x80) {
          this.ok = false;
          return false;
        }
        // If we have a pending constraint for the first continuation byte
        // (E0/ED/F0/F4 cases), enforce it
        if (firstContCheck === 1) {
          if (b < minSecond || b > maxSecond) {
            this.ok = false;
            return false;
          }
          firstContCheck = 0; // consumed the constrained first continuation
        }
        need -= 1;
        i += 1;
        continue;
      }

      // Leading byte
      if (b <= 0x7f) {
        // ASCII
        i += 1;
        continue;
      }

      if ((b & 0xe0) === 0xc0) {
        // 2-byte: C2..DF 80..BF
        if (b < 0xc2) {
          // C0/C1 are overlong
          this.ok = false;
          return false;
        }
        need = 1;
        firstContCheck = 0;
        i += 1;
        continue;
      }

      if ((b & 0xf0) === 0xe0) {
        // 3-byte: E0 A0..BF 80..BF  |  E1..EC 80..BF 80..BF
        // |  ED 80..9F 80..BF  |  EE..EF 80..BF 80..BF
        need = 2;
        if (b === 0xe0) {
          firstContCheck = 1;
          minSecond = 0xa0;
          maxSecond = 0xbf;
        } else if (b === 0xed) {
          firstContCheck = 1;
          minSecond = 0x80;
          maxSecond = 0x9f; // forbid surrogates
        } else {
          firstContCheck = 0;
        }
        i += 1;
        continue;
      }

      if ((b & 0xf8) === 0xf0) {
        // 4-byte: F0 90..BF 80..BF 80..BF | F1..F3 80..BF 80..BF 80..BF
        // | F4 80..8F 80..BF 80..BF
        if (b > 0xf4) {
          this.ok = false;
          return false;
        }
        need = 3;
        if (b === 0xf0) {
          firstContCheck = 1;
          minSecond = 0x90;
          maxSecond = 0xbf;
        } else if (b === 0xf4) {
          firstContCheck = 1;
          minSecond = 0x80;
          maxSecond = 0x8f; // cap at U+10FFFF
        } else {
          firstContCheck = 0;
        }
        i += 1;
        continue;
      }

      // Invalid leading byte
      this.ok = false;
      return false;
    }

    // Persist state
    this.need = need;
    this.firstContCheck = firstContCheck;
    this.minSecond = minSecond;
    this.maxSecond = maxSecond;

    if (fin) {
      if (need !== 0) {
        this.ok = false;
        return false; // dangling sequence at message end
      }
    }

    return true;
  }
}

module.exports = { Utf8IncrementalValidator };
