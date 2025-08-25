import type { Result } from './utils/result.js';
import type { Frame } from './frame.js';

export class ParseError extends Error {
  constructor(code: string, message?: string);
  name: 'ParseError';
  code: string;
}

export const PARSE_ERR_CODES: {
  MESSAGE_TOO_BIG: 'MESSAGE_TOO_BIG';
  PROTOCOL_ERROR_COMMON: 'PROTOCOL_ERROR-COMMON';
  PROTOCOL_ERROR_UNMASKED: 'PROTOCOL_ERROR-UNMASKED';
  PROTOCOL_ERROR_RSV: 'PROTOCOL_ERROR-RSV';
  PROTOCOL_ERROR_CTRL_TOO_LONG: 'PROTOCOL_ERROR-CTRL_TOO_LONG';
  INVALID_PAYLOAD: 'INVALID_PAYLOAD';
};

export class FrameParser {
  /**
   * Parses a buffer and returns a Result:
   * - an empty result if there's not enough data
   * - or an object { frame: Frame; bytesUsed: number }
   * - or a ParseError inside the Result (see PARSE_ERR_CODES)
   */
  static parse(
    buffer: Buffer,
  ): Result<{ frame: Frame; bytesUsed: number } | ParseError | null>;

  static checkControlFrame(frame: Frame): Result<boolean | ParseError>;

  static checkDataFrame(frame: Frame): Result<boolean | ParseError>;
}
