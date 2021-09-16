import { EventEmitter } from 'events';
import { ClientRequest, ServerResponse } from 'http';
import WebSocket from 'ws';
import { Semaphore } from 'metautil';
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

export interface ServerConfig {
  concurrency: number;
  host: string;
  balancer: boolean;
  protocol: string;
  ports: Array<number>;
  queue: object;
}

export class Session {
  constructor(token: string, channel: Channel, data: any);
}

export class Channel {
  application: object;
  req: ClientRequest;
  res: ServerResponse;
  ip: string;
  client: Metacom;
  session?: Session;
  constructor(application: object, req: ClientRequest, res: ServerResponse);
  message(data: string): void;
  prc(
    callId: number,
    interfaceName: string,
    methodName: string,
    args: []
  ): Promise<void>;
  restoreSession(): Promise<Session | null>;
  destroy(): void;
  error(code: number, err?: Error, callId?: number): void;
}

export class HttpChannel extends Channel {
  write(data: any, httpCode?: number, ext?: string): void;
  send(obj: object, httpCode?: number): void;
  redirect(location: string): void;
  options(): void;
  hook(
    proc: object,
    interfaceName: string,
    methodName: string,
    args: Array<any>
  ): Promise<void>;
  startSession(): Session;
  deleteSession(): void;
}

export class WsChannel extends Channel {
  connection: WebSocket;
  constructor(application: object, req: ClientRequest, connection: WebSocket);
  write(data: any): void;
  send(obj: object): void;
  redirect(location: string): void;
  options(): void;
  hook(
    proc: object,
    interfaceName: string,
    methodName: string,
    args: Array<any>
  ): Promise<void>;
  startSession(): Session;
  deleteSession(): void;
}

export class Server {
  config: ServerConfig;
  application: object;
  semaphore: Semaphore;
  balancer: boolean;
  port: number;
  server?: any;
  ws?: any;
  protocol: string;
  host: string;
  constructor(config: ServerConfig, application: object);
  bind(): void;
  listener(req: ClientRequest, res: ServerResponse): void;
  request(channel: Channel): void;
  closeChannels(): void;
  close(): Promise<void>;
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
