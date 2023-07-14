import { EventEmitter } from 'node:events';
import { ClientRequest, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import WebSocket from 'ws';
import { Semaphore } from 'metautil';

export interface MetacomError extends Error {
  code: string;
}

export class MetaReadable extends EventEmitter {
  streamId: number;
  name: string;
  size: number;
  push(data: ArrayBufferView): Promise<ArrayBufferView>;
  finalize(writable: Writable): Promise<void>;
  pipe(writable: Writable): Writable;
  toBlob(type?: string): Promise<Blob>;
}

export class MetaWritable extends EventEmitter {
  streamId: number;
  name: string;
  size: number;
  write(data: ArrayBufferView): void;
  end(): void;
  terminate(): void;
}

export interface BlobUploader {
  streamId: number;
  upload(): Promise<void>;
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
    ver: string,
  ): (methodName: string) => (args: object) => Promise<void>;
  socketCall(
    iname: string,
    ver: string,
  ): (methodName: string) => (args: object) => Promise<void>;
  getStream(streamId: number): MetaReadable;
  createStream(name: string, size: number): MetaWritable;
  createBlobUploader(blob: Blob): BlobUploader;
}

export interface Options {
  concurrency: number;
  host: string;
  port: number;
  kind: 'server' | 'balancer';
  protocol: string;
  ports: Array<number>;
  queue: object;
  cors?: {
    origin?: string;
    origins?: string[];
    credentials?: boolean;
  };
}

export interface ErrorOptions {
  callId?: number;
  error?: Error;
  pass?: boolean;
}

export interface Auth {
  generateToken(): string;
  saveSession(token: string, data: object): Promise<void>;
  createSession(token: string, data: object, fields?: object): Promise<void>;
  readSession(token: string): Promise<object | null>;
  deleteSession(token: string): Promise<void>;
  registerUser(login: string, password: string): Promise<object>;
  getUser(login: string): Promise<object>;
}

export class Client extends EventEmitter {
  ip: string | undefined;
  callId: number;
  eventId: number;
  streamId: number;
  auth: Auth;
  events: { close: Array<Function> };
  redirect(location: string): void;
  startSession(token: string, data: object): boolean;
  restoreSession(token: string): boolean;
  getStream(streamId: number): MetaReadable;
  createStream(name: string, size: number): MetaWritable;
}

export class Channel {
  server: Server;
  auth: Auth;
  console: Console;
  req: ClientRequest;
  res: ServerResponse;
  ip: string;
  client: Client;
  session?: Session;
  eventId: number;
  streamId: number;
  streams: Map<number, MetaReadable>;
  token: string;
  constructor(application: object, req: ClientRequest, res: ServerResponse);
  message(data: string): void;
  binary(data: Buffer): void;
  handleRpcPacket(packet: object): void;
  handleStreamPacket(packet: object): Promise<void>;
  createContext(): Context;
  rpc(
    callId: number,
    interfaceName: string,
    methodName: string,
    args: [],
  ): Promise<void>;
  hook(
    proc: object,
    interfaceName: string,
    methodName: string,
    args: Array<any>,
  ): Promise<void>;
  error(code: number, errorOptions?: ErrorOptions): void;
  sendEvent(name: string, data: object): void;
  getStream(streamId: number): MetaWritable;
  createStream(name: string, size: number): MetaWritable;
  resumeCookieSession(): Promise<void>;
  destroy(): void;
}

export class HttpChannel extends Channel {
  write(data: any, httpCode?: number, ext?: string): void;
  send(obj: object, httpCode?: number): void;
  redirect(location: string): void;
  options(): void;
  sendSessionCookie(token: string): void;
  removeSessionCookie(): void;
}

export class WsChannel extends Channel {
  connection: WebSocket;
  constructor(application: object, req: ClientRequest, connection: WebSocket);
  write(data: any): void;
  send(obj: object): void;
}

export class Server {
  options: Options;
  application: object;
  console: Console;
  semaphore: Semaphore;
  server?: any;
  ws?: any;
  channels?: Map<Client, Channel>;
  constructor(options: Options, application: object);
  bind(): void;
  listener(req: ClientRequest, res: ServerResponse): void;
  request(channel: Channel): void;
  closeChannels(): void;
  close(): Promise<void>;
}

export interface State {
  [key: string]: any;
}

export interface Session {
  token: string;
  state: State;
}

export interface Context {
  client: Client;
  uuid: string;
  state: State;
  session: Session;
}
