import { Result } from './utils/result.js';

export interface FrameParseResult {
  frame: Frame;
  bytesUsed: number;
}

export declare class Frame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
  mask: Buffer | null;
  rsv: number;

  constructor(
    fin: boolean,
    opcode: number,
    masked: boolean,
    payload: Buffer,
    mask: Buffer | null,
    rsv: number,
  );

  static text(message: string, fin?: boolean, masked?: boolean): Frame;

  static binary(
    buffer: Buffer | ArrayBuffer | ArrayBufferView,
    fin?: boolean,
    masked?: boolean,
  ): Frame;

  static ping(payload?: string | Buffer): Frame;

  static pong(payload?: string | Buffer): Frame;

  static emptyPingBuffer(isClient?: boolean): Buffer;

  static emptyPongBuffer(isClient?: boolean): Buffer;

  static close(code?: number | null, reason?: string): Frame;

  static normalClose(isClient?: boolean): Buffer;
  static errorClose(type: string, subtype?: string, isClient?: boolean): Buffer;
  static protocolErrorClose(type: string, isClient?: boolean): Buffer;

  unmaskPayload(): void;

  maskPayload(): void;

  toString(): string;

  toBuffer(): Buffer;

  get header(): Buffer;

  get isControlFrame(): boolean;
  get isValidControlFrame(): boolean;
  get isValidDataFrame(): boolean;

  getCloseDetails(): Result<{ code: number | null; reason: string }>;
}
