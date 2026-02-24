import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Server as HttpSServer } from 'https';
import { EventEmitter } from 'node:events';

import type { Connection } from './connection.js';

export interface WebsocketServerOptions {
  server: HttpServer | HttpSServer;
  pingInterval?: number;
  maxBuffer?: number;
  closeTimeout?: number;
}

export declare class WebsocketServer extends EventEmitter {
  constructor(options: WebsocketServerOptions);

  on(
    event: 'connection',
    listener: (ws: Connection, req: IncomingMessage) => void,
  ): this;

  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
