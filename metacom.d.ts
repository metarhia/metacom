import { EventEmitter } from 'node:events';
import {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { Emitter } from 'metautil';

export class MetacomError extends Error {
  code: number;
  constructor(options: { message: string; code: number });
}

export interface ReadableOptions {
  highWaterMark?: number;
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
    options?: ReadableOptions,
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

export interface Transport {
  send(obj: object): void;
  write(data: string | ArrayBufferView): void;
}

export interface MetacomPacket {
  type: string;
  id?: string;
  method?: string;
  args?: object;
  name?: string;
  data?: unknown;
  result?: unknown;
  error?: { message: string; code: number };
  status?: 'end' | 'terminate';
  size?: number;
}

export class MetaWritable extends Emitter {
  id: string;
  name: string;
  size: number;
  transport: Transport;
  constructor(id: string, name: string, size: number, transport: Transport);
  write(data: ArrayBufferView): boolean;
  end(): void;
  terminate(): void;
}

export interface BlobUploader {
  id: string;
  upload(): Promise<void>;
}

export interface TransportCapabilities {
  duplex: boolean;
  streams: boolean;
  events: boolean;
}

export interface TransportAdapter {
  Client: new (url: string) => ClientTransport;
  Server: (new (...args: unknown[]) => ServerTransport) & {
    capabilities: TransportCapabilities;
  };
  capabilities: TransportCapabilities;
  attach?: (
    server: Server,
    options: TransportAttachOptions,
    onConnection: (transport: ServerTransport) => void,
  ) => unknown;
}

export interface TransportAttachOptions {
  headers: Record<string, string>;
  path?: string;
  verifyClient?: (info: { req: IncomingMessage }) => boolean;
}

export function registerTransport(
  name: string,
  adapter: TransportAdapter,
): void;
export function getTransport(name: string): TransportAdapter;
export function allTransports(): IterableIterator<[string, TransportAdapter]>;

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

export class ClientWsTransport extends ClientTransport {}

export class ClientHttpTransport extends ClientTransport {}

export class ClientEventTransport extends ClientTransport {
  static instance: ClientEventTransport | null;
  static getInstance(url: string): ClientEventTransport;
}

export function buildHeaders(
  cors?: { origin?: string } | null,
): Record<string, string>;

export class Metacom extends Emitter {
  static connections: Set<Metacom>;
  static isOnline: boolean;
  static online(): void;
  static offline(): void;
  static initialize(): void;
  static connect(url: string, options?: MetacomOptions): Promise<Metacom>;
  static transport: {
    ws: typeof ClientWsTransport;
    http: typeof ClientHttpTransport;
    event: typeof ClientEventTransport;
  };

  url: string;
  api: Record<string, Emitter>;
  readonly active: boolean;

  constructor(url: string, transport: Transport, options?: MetacomOptions);
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
  proxy?: (data: string) => void;
}

export class MetacomProxy extends Emitter {
  constructor(options?: MetacomOptions);
  open(): Promise<void>;
  close(): void;
}

export class ServerTransport extends Emitter {
  source: string;
  constructor(source: string);
  close(): void;
  error(code?: number, options?: ErrorOptions): void;
  send(obj: object, code?: number): void;
  write(data: string | Buffer, code?: number): void;
}

export class ServerHttpTransport extends ServerTransport {
  static capabilities: TransportCapabilities;
  req: IncomingMessage;
  res: ServerResponse;
  headers: Record<string, string>;
  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    options?: TransportOptions,
  );
  write(data: string | Buffer, httpCode?: number): void;
  options(): void;
  getCookies(): Record<string, string>;
  sendSessionCookie(token: string): void;
  removeSessionCookie(): void;
}

export class ServerWsTransport extends ServerTransport {
  static capabilities: TransportCapabilities;
  connection: Connection;
  constructor(req: IncomingMessage, connection: Connection);
  write(data: string | Buffer): void;
}

export class ServerEventTransport extends ServerTransport {
  static capabilities: TransportCapabilities;
  port: MessagePort;
  constructor(port: MessagePort);
  write(data: string | Buffer): void;
}

export interface ApplicationContext {
  console: Console;
  auth: Auth;
  static: {
    constructor: { name: string };
    serve(path: string, transport: Transport): void;
  };
  getMethod(unit: string, version: string, methodName: string): object | null;
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
  SNICallback?: (
    servername: string,
    callback: (error: Error | null, context?: object) => void,
  ) => void;
  timeouts?: { bind: number };
  retry?: number;
  websocketPath?: string;
}

export interface ErrorOptions {
  id?: string;
  error?: Error;
}

export interface TransportOptions {
  headers?: Record<string, string>;
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
  source: string;
  session: Session | null;
  streams: Map<string, MetaReadable | MetaWritable>;
  constructor(transport: ServerTransport, context: ApplicationContext);
  error(code: number, options?: ErrorOptions): void;
  send(obj: object, options?: { code?: number; method?: string }): void;
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

export class Server extends Emitter {
  httpServer: HttpServer | HttpsServer;
  wsServer: WebsocketServer | null;
  constructor(context: ApplicationContext, options: Options);
  listen(): Promise<Server>;
  close(): Promise<void>;
}

export interface State {
  [key: string]: unknown;
}

export class Session {
  token: string;
  state: State;
  constructor(token: string, data: State, context: ApplicationContext);
}

export class Context {
  client: Client;
  uuid: string;
  state: Record<string, unknown>;
  session: Session | null;
  constructor(client: Client);
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

export function createProxy<T extends object>(
  data: T,
  save?: (data: T) => void,
): T;

export function chunkEncode(id: string, payload: Uint8Array): Uint8Array;
export function chunkDecode(chunk: Uint8Array): {
  id: string;
  payload: Uint8Array;
};

export declare const MAGIC: string;
export declare const CLOSE_TIMEOUT: number;

export declare const OPCODES: {
  readonly CONTINUATION: 0x00;
  readonly TEXT: 0x01;
  readonly BINARY: 0x02;
  readonly CLOSE: 0x08;
  readonly PING: 0x09;
  readonly PONG: 0x0a;
};

export declare const CLOSE_CODES: {
  readonly NORMAL_CLOSE: 1000;
  readonly GOING_AWAY: 1001;
  readonly PROTOCOL_ERROR: 1002;
  readonly UNSUPPORTED_DATA: 1003;
  readonly RESERVED: 1004;
  readonly NO_CODE_RECEIVED: 1005;
  readonly CONNECTION_CLOSED_ABNORMALLY: 1006;
  readonly INVALID_PAYLOAD: 1007;
  readonly POLICY_VIOLATED: 1008;
  readonly MESSAGE_TOO_BIG: 1009;
  readonly MANDATORY_EXTENSION: 1010;
  readonly INTERNAL_SERVER_ERROR: 1011;
  readonly TLS_HANDSHAKE: 1015;
};

export interface VerifyClientInfo {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
}

export interface WebsocketServerOptions {
  server: HttpServer | HttpsServer;
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
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

export interface ConnectionOptions {
  isClient?: boolean;
  maxBuffer?: number;
  closeTimeout?: number;
}

export interface Result<T> {
  readonly value: T | null;
  readonly error: Error | null;
  readonly ok: boolean;
  unwrap(defaultValue?: T): T;
  map<U>(fn: (value: T) => U): Result<U>;
}

export interface CloseDetails {
  code: number | null;
  reason: string;
}

export interface ParsedFrame {
  frame: Frame;
  bytesUsed: number;
}

export declare class Frame {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
  mask: Buffer | null;
  constructor(
    fin: boolean,
    opcode: number,
    masked: boolean,
    payload: Buffer,
    mask?: Buffer | null,
    rsv?: number,
  );
  static text(message: string, fin?: boolean, masked?: boolean): Frame;
  static binary(
    buffer: Buffer | ArrayBufferView,
    fin?: boolean,
    masked?: boolean,
  ): Frame;
  static ping(payload?: Buffer | string): Frame;
  static pong(payload?: Buffer | string): Frame;
  static emptyClientPingBuffer(): Buffer;
  static emptyClientPongBuffer(): Buffer;
  static errorClose(type: string, isClient?: boolean): Buffer;
  static protocolErrorClose(type: string, isClient?: boolean): Buffer;
  static isProtocolErrorType(type: string): boolean;
  static close(code?: number | null, reason?: string): Frame;
  unmaskPayload(): void;
  maskPayload(): void;
  toString(): string | null;
  getCloseDetails(): Result<CloseDetails>;
  get header(): Buffer;
  toBuffer(): Buffer;
  get isControlFrame(): boolean;
}

export declare class ParseError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export declare function parse(buffer: Buffer): Result<ParsedFrame | null>;
export declare function expectedFrameLength(buffer: Buffer): number;
export declare function checkControlFrame(frame: Frame): Result<boolean>;
export declare function checkDataFrame(frame: Frame): Result<boolean>;

export declare class Connection extends EventEmitter {
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
    listener: (data: Buffer, isBinary: boolean) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'pong', listener: (payload: Buffer) => void): this;
}
