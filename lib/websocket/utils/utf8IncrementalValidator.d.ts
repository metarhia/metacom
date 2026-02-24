/**
 * Utf8IncrementalValidator
 * Zero-allocation, streaming UTF-8 validator for fragmented WebSocket TEXT messages.
 * - Maintains only a few integers of state.
 * - Enforces overlong, surrogate, and max code point rules.
 * - Returns boolean; call with { fin: true } on final fragment to ensure no dangling sequence.
 */
export declare class Utf8IncrementalValidator {
  constructor();

  /** Reset validator state to accept a new message */
  reset(): void;

  /**
   * Validate next chunk.
   * @param buf Buffer | Uint8Array
   * @param fin - set true for the last fragment of the message
   * @returns true if valid so far; false if invalid (validator becomes closed for further use)
   */
  push(buf: Buffer | Uint8Array, fin?: boolean): boolean;
}
