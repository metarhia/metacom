import {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'node:http';
import { Readable, Writable } from 'node:stream';
import { Emitter } from 'metautil';
import WebSocket, { WebSocketServer } from 'ws';

export class MetacomError extends Error {
  code: number;
  constructor(options: { message: string; code: number });
}

export class MetaReadable extends Emitter {
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

export class MetaWritable extends Emitter {
  id: string;
  name: string;
  size: number;
  transport: ClientTransport | ServerTransport;
  constructor(
    id: string,
    name: string,
    size: number,
    transport: ClientTransport | ServerTransport,
  );
  write(data: ArrayBufferView): boolean;
  end(): void;
  terminate(): void;
}

export interface BlobUploader {
  id: string;
  upload(): Promise<void>;
}

export class ClientTransport extends Emitter {
  url: string;
  active: boolean;
  constructor(url: string);
  open(options?: MetacomOptions): Promise<void>;
  close(): void;
  send(obj: object): void;
  write(data: string | ArrayBufferView): void;
  online(): void;
  offline(): void;
}

export class Metacom extends Emitter {
  static connections: Set<Metacom>;
  static isOnline: boolean;
  static online(): void;
  static offline(): void;
  static initialize(): void;
  static connect(url: string, options?: MetacomOptions): Promise<Metacom>;
  static transport: {
    ws: new (url: string) => ClientTransport;
    http: new (url: string) => ClientTransport;
    event: {
      getInstance(url: string): ClientTransport;
    };
  };

  url: string;
  api: Record<string, Emitter>;
  readonly active: boolean;

  constructor(
    url: string,
    transport: ClientTransport,
    options?: MetacomOptions,
  );
  open(): Promise<void>;
  close(): void;
  load(...units: Array<string>): Promise<void>;
  getStream(id: string): MetaReadable | MetaWritable;
  createStream(name: string, size: number): MetaWritable;
  createBlobUploader(blob: Blob): BlobUploader;
  send(obj: object): void;
  write(data: string | ArrayBufferView): void;
}

export interface MetacomOptions {
  callTimeout?: number;
  reconnectTimeout?: number;
  worker?: ServiceWorker;
  packetHandler?: (data: string) => void | Promise<void>;
  binaryHandler?: (
    input: ArrayBuffer | ArrayBufferView | Blob,
  ) => void | Promise<void>;
}

export class MetacomProxy extends Emitter {
  ports: Set<MessagePort>;
  pending: Map<string, MessagePort>;
  connection: Metacom;
  callTimeout: number;
  reconnectTimeout: number;

  constructor(options?: MetacomOptions);
  open(): Promise<void>;
  close(): void;
}

export interface ApplicationContext {
  console: Console;
  auth: Auth;
  static: {
    constructor: { name: string };
    serve(path: string, transport: ServerHttpTransport): void;
  };
  getMethod(unit: string, version: string, methodName: string): object | null;
  getHook(unit: string): object | null;
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

export type EventName = PropertyKey;

export class Client extends Emitter {
  ip: string | undefined;
  session: Session | null;
  streams: Map<string, MetaReadable | MetaWritable>;
  error(code: number, options?: ErrorOptions): void;
  send(obj: object, code?: number): void;
  createContext(): Context;
  emit(name: EventName, data: unknown): Promise<void>;
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

export interface TransportOptions {
  headers?: Record<string, string>;
  console?: Console;
}

export class ServerTransport extends Emitter {
  static transport: {
    http: typeof ServerHttpTransport;
    ws: typeof ServerWsTransport;
    event: typeof ServerEventTransport;
  };
  req: IncomingMessage;
  ip: string;
  headers: Record<string, string>;
  console: Console;
  constructor(req: IncomingMessage, options?: TransportOptions);
  error(code?: number, errorOptions?: ErrorOptions): void;
  log(code: number): void;
  send(obj: object, code?: number): void;
  write(data: string | Buffer, code?: number, ext?: string): void;
  close(): void;
}

export class ServerHttpTransport extends ServerTransport {
  res: ServerResponse;
  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    options?: TransportOptions,
  );
  write(
    data: string | Buffer,
    httpCode?: number,
    ext?: string,
    options?: {
      start?: number;
      end?: number;
      size?: number | string;
      contentEncoding?: string;
    },
  ): void;
  redirect(location: string): void;
  options(): void;
  getCookies(): Record<string, string>;
  sendSessionCookie(token: string): void;
  removeSessionCookie(): void;
}

export class ServerWsTransport extends ServerTransport {
  connection: WebSocket;
  constructor(
    req: IncomingMessage,
    connection: WebSocket,
    options?: TransportOptions,
  );
  write(data: string | Buffer): void;
}

export class ServerEventTransport extends ServerTransport {
  connection: MessagePort;
  constructor(
    req: IncomingMessage,
    port: MessagePort,
    options?: TransportOptions,
  );
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
  context: ApplicationContext;
  options: Options;
  balancer: boolean;
  console: Console;
  headers: Record<string, string>;
  httpServer: HttpServer;
  wsServer: WebSocketServer | null;
  clients: Set<Client>;
  retry: number;
  constructor(context: ApplicationContext, options: Options);
  addClient(transport: ServerTransport): Client;
  handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleWsConnection(req: IncomingMessage, connection: WebSocket): void;
  handleEventConnection(req: IncomingMessage, port: MessagePort): void;
  init(): void;
  listen(): Promise<Server>;
  message(client: Client, data: Buffer | string): void;
  rpc(client: Client, packet: CallPacket): Promise<void>;
  stream(client: Client, packet: StreamPacket): Promise<void>;
  binary(client: Client, data: Uint8Array): void;
  request(
    client: Client,
    transport: ServerHttpTransport,
    data: string | Buffer,
  ): void;
  hook(
    client: Client,
    proc: object,
    packet: CallPacket,
    verb: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void>;
  balancing(transport: ServerHttpTransport): void;
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
  state: Record<string, unknown>;
  session: Session | null;
}

export function createProxy<T extends object>(
  data: T,
  save?: (data: T) => void,
): T;

export function chunkEncode(id: string, payload: Uint8Array): Uint8Array;
export function chunkDecode(chunk: Uint8Array): {
  id: string;
  payload: Uint8Array;
};
