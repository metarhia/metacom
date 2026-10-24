import {
  ApplicationContext,
  Client,
  ClientEventTransport,
  ClientHttpTransport,
  ClientTransport,
  ClientWsTransport,
  Context,
  Metacom,
  MetacomError,
  MetacomProxy,
  MetaReadable,
  MetaWritable,
  Server,
  ServerHttpTransport,
  ServerTransport,
  ServerWsTransport,
  Session,
} from './metacom.js';
import type {
  BlobUploader,
  CallPacket,
  MetacomOptions,
  Options,
  ParsedFrame,
  Result,
  StreamPacket,
  TransportAdapter,
  TransportCapabilities,
} from './metacom.js';

// Compile-time checks for public API surface
type Assert<T extends true> = T;

type _ClientTransportOpen = Assert<
  ClientTransport['open'] extends (options?: MetacomOptions) => Promise<void>
    ? true
    : false
>;

type _ServerTransportCapabilities = Assert<
  (typeof ServerHttpTransport)['capabilities'] extends TransportCapabilities
    ? true
    : false
>;

type _ParseNullable = Assert<
  Result<ParsedFrame | null>['value'] extends ParsedFrame | null ? true : false
>;

type _MetacomActive = Assert<Metacom['active'] extends boolean ? true : false>;

type _SessionState = Assert<Session['state'] extends object ? true : false>;

type _StreamPacket = Assert<
  StreamPacket['type'] extends 'stream' ? true : false
>;

type _CallPacket = Assert<CallPacket['type'] extends 'call' ? true : false>;

type _TransportRegistry = Assert<
  TransportAdapter['capabilities'] extends TransportCapabilities ? true : false
>;

// Runtime smoke imports (tree-shaking safe, never executed)
const _exports: Record<string, unknown> = {
  Client,
  ClientEventTransport,
  ClientHttpTransport,
  ClientTransport,
  ClientWsTransport,
  Context,
  Metacom,
  MetacomError,
  MetacomProxy,
  MetaReadable,
  MetaWritable,
  Server,
  ServerHttpTransport,
  ServerTransport,
  ServerWsTransport,
  Session,
};

void _exports;

declare const app: ApplicationContext;
declare const opts: Options;

async function _usage(): Promise<void> {
  const server = new Server(app, opts);
  await server.listen();

  const metacom = await Metacom.connect('ws://localhost:8000');
  const uploader: BlobUploader = metacom.createBlobUploader(new Blob(['test']));
  await uploader.upload();
  await metacom.load('system');
  metacom.close();
}

void _usage;
