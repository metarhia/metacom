import {
  ApplicationContext,
  Client,
  ClientEventTransport,
  ClientHttpTransport,
  ClientRtcTransport,
  ClientTransport,
  ClientWsTransport,
  Context,
  Metacom,
  MetacomError,
  MetacomProxy,
  MetacomPeer,
  MetacomRtcBridge,
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
  ProxyContext,
  ProxyHandler,
  Result,
  StreamPacket,
  TransportAdapter,
  TransportCapabilities,
  RtcSignaling,
} from './metacom.js';

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

type _MetacomDeliver = Assert<
  Metacom['deliver'] extends (data: string, timeout?: number) => boolean
    ? true
    : false
>;

type _MetacomReadable = Assert<
  ReturnType<Metacom['createReadable']> extends MetaReadable ? true : false
>;

type _ProxyServer = Assert<
  MetacomProxy['server'] extends Metacom ? true : false
>;

type _ProxyRegister = Assert<
  MetacomProxy['register'] extends (
    unit: string,
    methods: Record<string, ProxyHandler>,
  ) => void
    ? true
    : false
>;

type _ProxyContextServer = Assert<
  ProxyContext['server'] extends Metacom ? true : false
>;

type _ClientStreamId = Assert<
  Client['createStream'] extends (
    name: string,
    size: number,
    id?: string,
  ) => MetaWritable
    ? true
    : false
>;

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
  MetacomPeer,
  MetacomRtcBridge,
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
  const rtc = new ClientRtcTransport('peer');
  await rtc.open({
    rtc: {
      localId: 'caller',
      peerId: 'host',
      role: 'offerer',
      signaling: {
        send() {},
        subscribe() {
          return () => {};
        },
      },
    },
  });
  rtc.close();
  const uploader: BlobUploader = metacom.createBlobUploader(new Blob(['test']));
  await uploader.upload();
  await metacom.load('system');
  metacom.close();
}

void _usage;

async function _rtcExamples(worker: ServiceWorker, signaling: RtcSignaling) {
  const host = new MetacomPeer({
    rtc: {
      localId: 'host',
      peerId: 'caller',
      role: 'answerer',
      signaling,
    },
  });
  host.register('demo', {
    echo: (args, context) => {
      context.emit('demo/changed', args);
      return args;
    },
    download: ({ id }, context) => {
      const stream = context.createStream('bytes', 1, id);
      stream.write(new Uint8Array([7]));
      stream.end();
    },
  });
  await host.open();
  const bridge = MetacomRtcBridge.attach(worker, {
    localId: 'caller',
    peerId: 'host',
    role: 'offerer',
    signaling,
  });
  await bridge.ready;
  bridge.close();
  host.close();
}

void _rtcExamples;
