import { EventEmitter } from 'node:events';
import { ClientRequest, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import WebSocket from 'ws';
import { Semaphore } from 'metautil';

export interface MetacomError extends Error {
  code: string;
}

export class MetaReadable extends EventEmitter {
  id: string;
  name: string;
  size: number;
  constructor(
    id: string,
    name: string,
    size: number,
    options?: {
      highWaterMark?: number;
    },
  );
  push(data: ArrayBufferView): Promise<ArrayBufferView>;
  finalize(writable: Writable): Promise<void>;
  pipe(writable: Writable): Writable;
  toBlob(type?: string): Promise<Blob>;
}

export class MetaWritable extends EventEmitter {
  id: string;
  name: string;
  size: number;
  constructor(id: string, name: string, size: number, transport: Transport);
  write(data: ArrayBufferView): void;
  end(): void;
  terminate(): void;
}

export interface BlobUploader {
  id: string;
  upload(): Promise<void>;
}

export class Metacom extends EventEmitter {
  url: string;
  socket: WebSocket;
  api: object;
  callId: number;
  calls: Map<string, [Function, Function]>;
  constructor(url: string);
  static create(url: string, options?: unknown): Metacom;
  ready(): Promise<void>;
  load(...interfaces: Array<string>): Promise<void>;
  httpCall(
    unit: string,
    ver: string,
  ): (methodName: string) => (args: object) => Promise<void>;
  socketCall(
    unit: string,
    ver: string,
  ): (methodName: string) => (args: object) => Promise<void>;
  getStream(id: string): MetaReadable;
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
}

export interface ErrorOptions {
  id?: string;
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
  session: Session;
}

export class Transport {
  console: Console;
  req: ClientRequest;
  res?: ServerResponse;
  connection?: WebSocket;
  ip: string;
  constructor(
    console: Console,
    req: ClientRequest,
    target: ServerResponse | WebSocket,
  );
  error(code: number, errorOptions?: ErrorOptions): void;
  write(data: string | Buffer, httpCode?: number, ext?: string): void;
  send(obj: object, httpCode?: number): void;
  redirect?(location: string): void;
  options?(): void;
  getCookies?(): object;
  sendSessionCookie(token: string): void;
  removeSessionCookie(): void;
  close(): void;
}

export interface CallPacket {
  type: 'call';
  id: string;
  method: string;
  args: object;
  meta: object;
}

export interface StreamPacket {
  type: 'stream';
  id: string;
  name: string;
  size: number;
}

export class Server {
  application: object;
  options: Options;
  balancer: boolean;
  console: Console;
  semaphore: Semaphore;
  httpServer: any;
  wsServer: any;
  clients: Set<Client>;
  constructor(options: Options, application: object);
  init(): void;
  listen(): Promise<void>;
  message(client: Client, data: string): void;
  rpc(client: Client, packet: CallPacket): Promise<void>;
  binary(client: Client, data: Buffer): void;
  stream(client: Client, packet: StreamPacket): Promise<void>;
  balancing(transport: Transport): void;
  closeClients(): void;
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
