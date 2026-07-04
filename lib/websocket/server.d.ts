import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Server as HttpSServer } from 'https';
import { EventEmitter } from 'node:events';

import type { Connection } from './connection.js';

export interface VerifyClientInfo {
  req: IncomingMessage;
  socket: import('net').Socket;
  head: Buffer;
}

export interface WebsocketServerOptions {
  server: HttpServer | HttpSServer;
  pingInterval?: number;
  maxBuffer?: number;
  closeTimeout?: number;
  path?: string;
  verifyClient?: (info: VerifyClientInfo) => boolean;
}

export declare class WebsocketServer extends EventEmitter {
  constructor(options: WebsocketServerOptions);

  on(
    event: 'connection',
    listener: (ws: Connection, req: IncomingMessage) => void,
  ): this;

  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
