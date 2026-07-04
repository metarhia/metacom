import { Result } from './result.js';

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
  static emptyClientPingBuffer(): Buffer;
  static emptyClientPongBuffer(): Buffer;
  static close(code?: number | null, reason?: string): Frame;
  static errorClose(type: string, isClient?: boolean): Buffer;
  static protocolErrorClose(type: string, isClient?: boolean): Buffer;

  unmaskPayload(): void;
  maskPayload(): void;
  toString(): string;
  toBuffer(): Buffer;
  get header(): Buffer;
  get isControlFrame(): boolean;
  getCloseDetails(): Result<{ code: number | null; reason: string }>;
}
