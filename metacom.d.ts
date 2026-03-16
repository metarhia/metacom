import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import WebSocket from 'ws';

export class MetacomError extends Error {
  code: number;
  constructor(options: { message: string; code: number });
}

export class MetaReadable extends EventEmitter {
  id: string;
  name: string;
  size: number;
  queue: Array<ArrayBufferView>;
  streaming: boolean;
  status: string;
  bytesRead: number;
  highWaterMark: number;
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
  close(): Promise<void>;
  terminate(): Promise<void>;
  read(): Promise<ArrayBufferView | null>;
  [Symbol.asyncIterator](): AsyncIterableIterator<ArrayBufferView>;
}

export class MetaWritable extends EventEmitter {
  id: string;
  name: string;
  size: number;
  constructor(id: string, name: string, size: number, transport: Metacom);
  write(data: ArrayBufferView): boolean;
  end(): void;
  terminate(): void;
}

export interface BlobUploader {
  id: string;
  upload(): Promise<void>;
}

export class MetacomUnit extends EventEmitter {
  emit(name: string, ...args: Array<unknown>): boolean;
  post(...args: Array<unknown>): void;
}

export class Metacom extends EventEmitter {
  static connections: Set<Metacom>;
  static isOnline: boolean;
  static online(): void;
  static offline(): void;
  static initialize(): void;
  static create(url: string, options?: MetacomOptions): Metacom;

  url: string;
  socket: WebSocket;
  api: Record<string, MetacomUnit>;
  calls: Map<string, [Function, Function, NodeJS.Timeout]>;
  streams: Map<string, MetaReadable | MetaWritable>;
  active: boolean;
  connected: boolean;
  opening: Promise<void> | null;
  lastActivity: number;
  callTimeout: number;
  reconnectTimeout: number;
  generateId: () => string;

  constructor(url: string, options?: MetacomOptions);
  open(options?: MetacomOptions): Promise<void>;
  close(): void;
  load(...units: Array<string>): Promise<void>;
  scaffold(
    unit: string,
    ver?: string,
  ): (methodName: string) => (args?: object) => Promise<unknown>;
  getStream(id: string): MetaReadable;
  createStream(name: string, size: number): MetaWritable;
  createBlobUploader(blob: Blob): BlobUploader;
  handlePacket(data: string): Promise<void>;
  binary(input: ArrayBuffer | Uint8Array | Blob): Promise<void>;
  send(data: object): void;
  write(data: string | ArrayBufferView): void;
}

export interface MetacomOptions {
  callTimeout?: number;
  reconnectTimeout?: number;
  generateId?: () => string;
  worker?: ServiceWorker;
}

export class MetacomProxy extends EventEmitter {
  ports: Set<MessagePort>;
  pending: Map<string, MessagePort>;
  connection: Metacom;
  callTimeout: number;
  reconnectTimeout: number;
  generateId: () => string;

  constructor(options?: MetacomOptions);
  open(options?: object): Promise<void>;
  close(): void;
  handleEvent(event: MessageEvent): Promise<void>;
  handleMessage(event: MessageEvent, port: MessagePort): Promise<void>;
  handlePacket(data: string | Uint8Array): void;
  broadcast(data: unknown, excludePort?: MessagePort): void;
}

export interface Options {
  host: string;
  port: number;
  kind?: 'server' | 'balancer';
  protocol?: string;
  ports?: Array<number>;
  cors?: { origin: string };
  nagle?: boolean;
  key?: string;
  cert?: string;
  SNICallback?: Function;
  timeouts?: { bind: number };
  retry?: number;
  generateId?: () => string;
}

export interface ErrorOptions {
  id?: string;
  error?: Error;
  httpCode?: number;
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
  streams: Map<string, MetaReadable | MetaWritable>;
  error(code: number, options?: ErrorOptions): void;
  send(obj: object, code?: number): void;
  createContext(): Context;
  emit(name: string, data?: unknown): boolean;
  sendEvent(name: string, data?: unknown): void;
  getStream(id: string): MetaReadable | MetaWritable;
  createStream(name: string, size: number): MetaWritable;
  initializeSession(token: string, data?: object): boolean;
  finalizeSession(): boolean;
  startSession(token: string, data?: object): boolean;
  restoreSession(token: string): boolean;
  close(): void;
  destroy(): void;
}

export class Transport extends EventEmitter {
  server: Server;
  req: IncomingMessage;
  ip: string;
  headers: Record<string, string>;
  constructor(server: Server, req: IncomingMessage);
  error(code?: number, errorOptions?: ErrorOptions): void;
  log(code: number): void;
  send(obj: object, code?: number): void;
  write(data: string | Buffer, code?: number, ext?: string): void;
  close(): void;
}

export class HttpTransport extends Transport {
  res: ServerResponse;
  constructor(server: Server, req: IncomingMessage, res: ServerResponse);
  write(
    data: string | Buffer,
    httpCode?: number,
    ext?: string,
    options?: { start?: number; end?: number; size?: number },
  ): void;
  redirect(location: string): void;
  options(): void;
  getCookies(): Record<string, string>;
  sendSessionCookie(token: string): void;
  removeSessionCookie(): void;
}

export class WsTransport extends Transport {
  connection: WebSocket;
  constructor(server: Server, req: IncomingMessage, connection: WebSocket);
  write(data: string | Buffer): void;
}

export interface CallPacket {
  type: 'call';
  id: string;
  method: string;
  args: object;
}

export interface StreamPacket {
  type: 'stream';
  id: string;
  name?: string;
  size?: number;
  status?: 'end' | 'terminate';
}

export class Server {
  application: object;
  options: Options;
  balancer: boolean;
  console: Console;
  headers: Record<string, string>;
  httpServer: any;
  wsServer: any;
  clients: Set<Client>;
  retry: number;
  generateId: () => string;
  constructor(application: object, options: Options);
  init(): void;
  listen(): Promise<Server>;
  message(client: Client, data: Buffer | string): void;
  rpc(client: Client, packet: CallPacket): Promise<void>;
  stream(client: Client, packet: StreamPacket): Promise<void>;
  binary(client: Client, data: Uint8Array): void;
  request(client: Client, transport: HttpTransport, data: Buffer): void;
  hook(
    client: Client,
    proc: object,
    packet: CallPacket,
    verb: string,
    headers: object,
  ): Promise<void>;
  balancing(transport: HttpTransport): void;
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

export function chunkEncode(id: string, payload: Uint8Array): Uint8Array;
export function chunkDecode(chunk: Uint8Array): { id: string; payload: Uint8Array };
