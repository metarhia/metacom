import { EventEmitter } from 'events';
import { Writable } from 'stream';

export interface MetacomError extends Error {
  code: string;
}

export class Metacom extends EventEmitter {
  url: string;
  socket: WebSocket;
  api: object;
  callId: number;
  calls: Map<number, [Function, Function]>;
  constructor(url: string);
  static create(url: string, options?: unknown): Metacom;
  ready(): Promise<void>;
  load(...interfaces: Array<string>): Promise<void>;
  httpCall(
    iname: string,
    ver: string
  ): (methodName: string) => (args: object) => Promise<void>;
  socketCall(
    iname: string,
    ver: string
  ): (methodName: string) => (args: object) => Promise<void>;
}

export class MetacomReadable extends EventEmitter {
  streamId: number;
  name: string;
  size: number;
  push(data: ArrayBufferView): Promise<ArrayBufferView>;
  finalize(writable: Writable): Promise<void>;
  pipe(writable: Writable): Writable;
  toBlob(type?: string): Promise<Blob>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}

export class MetacomWritable extends EventEmitter {
  streamId: number;
  name: string;
  size: number;
  write(data: ArrayBufferView): void;
  end(): void;
  terminate(): void;
}
