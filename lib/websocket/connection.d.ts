import { Socket } from 'node:net';

export interface ConnectionOptions {
  isClient?: boolean;
  maxBuffer?: number;
  closeTimeout?: number;
}

export declare class Connection {
  constructor(socket: Socket, head: Buffer, options?: ConnectionOptions);

  send(data: string | Buffer): boolean;
  sendText(message: string): boolean;
  sendBinary(buffer: Buffer): boolean;
  sendPing(payload?: Buffer | string): boolean;
  sendPong(payload?: Buffer | string): boolean;
  sendClose(code?: number, reason?: string): boolean;
  terminate(): void;

  on(
    event: 'message',
    listener: (data: string | Buffer, isBinary: boolean) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'pong', listener: (payload: Buffer) => void): this;
}
