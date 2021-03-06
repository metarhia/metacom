import EventEmitter = require('events');

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
  ready(): Promise<void>;
  load(interfaces: Array<string>): Promise<void>;
  httpCall(
    iname: string,
    ver: string
  ): (methodName: string) => (args: object) => Promise<void>;
  socketCall(
    iname: string,
    ver: string
  ): (methodName: string) => (args: object) => Promise<void>;
}
