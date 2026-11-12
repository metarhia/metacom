# Metacom Communication Protocol for Metarhia

[![ci status](https://github.com/metarhia/metacom/workflows/Testing%20CI/badge.svg)](https://github.com/metarhia/metacom/actions?query=workflow%3A%22Testing+CI%22+branch%3Amaster)
[![snyk](https://snyk.io/test/github/metarhia/metacom/badge.svg)](https://snyk.io/test/github/metarhia/metacom)
[![npm version](https://badge.fury.io/js/metacom.svg)](https://badge.fury.io/js/metacom)
[![npm downloads/month](https://img.shields.io/npm/dm/metacom.svg)](https://www.npmjs.com/package/metacom)
[![npm downloads](https://img.shields.io/npm/dt/metacom.svg)](https://www.npmjs.com/package/metacom)

Metacom protocol specification:
https://github.com/metarhia/Contracts/blob/master/doc/Metacom.md

## Client usage

```js
const { Metacom } = require('metacom'); // for Node.js
import { Metacom } from 'metacom'; // for browser
// const { Metacom } = require('metacom'); // for backend
const metacom = await Metacom.connect('ws://domainname.com:8000');
const { api } = metacom;
try {
  await metacom.load('auth'); // Load `auth` interface
  await api.auth.status(); // Check session status
} catch (error) {
  await api.auth.signIn({ login: 'marcus', password: 'marcus' });
}
await metacom.load('example'); // Load `example` interface
const result = api.example.methodName({ arg1, arg2 });
```

## Streams over Websocket

### Example: big file upload

Create `uploadFile` function on the client:

```js
const metacom = await Metacom.connect('ws://example.com/api');

const uploadFile = async (file) => {
  // createBlobUploader creates streamId and inits file reader for convenience
  const uploader = metacom.createBlobUploader(file);
  // Prepare backend file consumer
  await metacom.api.files.upload({
    streamId: uploader.id,
    name: file.name,
  });
  // Start uploading stream and wait for its end
  await uploader.upload();
  return { uploadedFile: file };
};
```

Create API method to init file destination:

```js
// api/files/upload.js
async ({ streamId, name }) => {
  const filePath = `./application/resources/${name}`;
  // Get incoming stream by streamId sent from client
  const readable = context.client.getStream(streamId);
  // Create nodejs stream to write file on server
  const writable = node.fs.createWriteStream(filePath);
  // Pipe metacom readable to nodejs writable
  readable.pipe(writable);
  return { result: 'Stream initialized' };
};
```

### Example: big file download

Create `downloadFile` function on the client:

```js
const metacom = await Metacom.connect('ws://example.com/api');

const downloadFile = async (name) => {
  // Create readable stream, its id is generated on the client
  const readable = metacom.createReadable();
  // Init backend file producer and pass streamId to it
  await metacom.api.files.download({ name, streamId: readable.id });
  // Convert stream to blob to make a file on the client
  const blob = await readable.toBlob();
  return new File([blob], name);
};
```

Create API method to init file source:

```js
// api/files/download.js
async ({ name, streamId }) => {
  const filePath = `./application/resources/${name}`;
  // Create nodejs readable stream to read a file
  const readable = node.fs.createReadStream(filePath);
  // Get file size
  const { size } = await node.fsp.stat(filePath);
  // Create metacom writable stream with id received from client
  const writable = context.client.createStream(name, size, streamId);
  // Pipe nodejs readable to metacom writable
  readable.pipe(writable);
  return { name, size };
};
```

`streamId` is optional for direct connections: without it the server
generates the id and the client reads the stream with
`metacom.getStream(streamId)`. Through the service worker proxy the id must
be created on the client, the worker routes streams by ids it has seen.

## WebRTC transport

Tabs and windows can communicate using a reliable, ordered RTCDataChannel.
Select it explicitly with `transport: 'webrtc'`. The URL is a logical endpoint
identifier; signaling and ICE configuration are supplied by your application.

Run `npm run build` and `node examples/webrtc/server.js`, then open
<http://127.0.0.1:8008/>. Open **Host for a tab**, then **Tab caller** in another
tab. For the worker topology, open **Host for a worker**, **Worker owner tab**,
then one or more **Worker client tab** pages. Keep each topology's host open.
The [example sources](examples/webrtc/) also show worker authorization and
cleanup. Local examples use host ICE candidates without external servers.

In the host tab:

```js
import { MetacomPeer } from './metacom.mjs';
import { broadcastSignaling } from './signaling.mjs';

const signaling = broadcastSignaling('my-app');
const host = new MetacomPeer({
  rtc: {
    localId: 'host',
    peerId: 'caller',
    role: 'answerer',
    signaling,
  },
});
host.register('demo', { echo: (args) => args });
await host.open();
host.on('connect', (peerId) => console.log('Connected:', peerId));
```

In the caller tab:

```js
import { Metacom } from './metacom.mjs';
import { broadcastSignaling } from './signaling.mjs';

const signaling = broadcastSignaling('my-app');
const client = await Metacom.connect('host', {
  transport: 'webrtc',
  rtc: {
    localId: 'caller',
    peerId: 'host',
    role: 'offerer',
    signaling,
  },
});
await client.load('demo');
console.log(await client.api.demo.echo({ hello: 'world' }));
// When finished: client.close(); signaling.close();
```

Start the answerer before the offerer. `MetacomPeer.open()` starts accepting its
configured peers; use `connect`/`disconnect` events and `active` to observe
connections. Pass an array of RTC options to host several distinct peer IDs.
Each peer has its own transport and routes; an absent peer retries without
closing established connections. `host.close()` releases all its connections.
An optional `upstream: Metacom` forwards unhandled methods and merges interface
descriptions. The host owns that upstream connection's routing and lifetime;
do not attach it to another router concurrently.

Host handlers receive a context with `peerId`, nullable upstream `server`,
`emit(name, data)`, `broadcast(name, data)`, `getStream(id)`, and
`createStream(name, size, id?)`. Use the caller's `createReadable().id` when
creating a download. For local uploads, call `context.getStream(id)` before the
first upload chunk; unclaimed uploads are forwarded when an upstream is present.
Existing Metacom stream APIs and packet formats remain the same.

The signaling adapter implements `send(message)` and
`subscribe(listener) => unsubscribe`. Messages are plain objects containing
`protocol: 'metacom:rtc'`, `version: 1`, `source`, `target`, `generation`, and
either `description: { type, sdp }` or `candidate`. Each reconnect gets a fresh
generation. The application must authenticate signaling and authorize the peer
IDs it exposes. BroadcastChannel is a same-origin example, not an authentication
mechanism. For a known popup or parent window, the example's alternative adapter
validates both the sender window and its origin:

```js
import { windowSignaling } from './signaling.mjs';

const signaling = windowSignaling(window.opener, location.origin);
// The other window supplies its reference to this window and the same origin.
// Install the answerer first, then start the offerer using that adapter.
```

Both adapters carry discovery/negotiation messages; RPC, events, and streams use
the data channel. For remote peers, provide an authenticated signaling service
and `rtc.configuration: { iceServers: [...] }` with your STUN/TURN settings and
credentials. No public signaling or ICE servers are configured automatically.

The transport fragments complete messages into versioned binary frames of at
most 16 KiB, bounded by the negotiated SCTP limit. Defaults are 16 MiB per
message, 4096 fragments, a 10-second assembly timeout, a 32 MiB send queue, and
a 256 KiB buffered high-water mark. `rtc.maxMessageBytes`, `maxFragments`,
`assemblyTimeout`, `maxQueueBytes`, and `highWaterBytes` configure those bounds.
`write()` returns false under backpressure; await `drain()` before continuing.
Closing settles drain waiters and discards queued frames. Malformed fragments
close the transport. `rtc.handshakeTimeout` defaults to 10 seconds; the existing
Metacom reconnect, call timeout, queue, and restore options still apply.
Calls already sent are not replayed automatically after disconnection.

### Service worker WebRTC upstream

The supported path is:

```text
local tabs -> event transport -> service worker MetacomProxy
          -> MessagePort -> owner tab -> RTCDataChannel -> peer host
```

The worker selects `transport: 'rtc-bridge'` and supplies
`bridge: { peerId, authorize(client, request) }`. Call `proxy.open()` when setting
up its message listeners. Attachments must come from controlled same-origin
clients and pass the explicit authorization callback. In the owner tab, wait for
an active controller, then call
`MetacomRtcBridge.attach(controller, rtcOptions)` and await the returned handle's
`ready` promise. `handle.close()` releases the bridge; `handle.closed` reports
its state. The runnable example contains both sides of this setup.

The owner holds the peer connection. The bridge uses generation and worker
instance IDs, heartbeats, bounded message-port queues, and credits that are
acknowledged after downstream drain. Its fixed bounds are 16 MiB per packet,
32 MiB queued per direction, and 1024 queued packets. Worker `bridge` options
and owner RTC options support `handshakeTimeout`, `pingInterval`, and
`pongTimeout`; bridge defaults are 15 seconds, 1 second, and 5 seconds.

Owner closure, worker restart, or controller replacement releases the obsolete
bridge. Attach a fresh owner handle and port after recovery. Browser lifecycle
rules can terminate the worker; heartbeats do not guarantee persistence. Keep
the owner tab open while using its connection. Automatic owner election,
automatic transport fallback, all-tabs-closed operation, direct service worker
RTC endpoints, a native Node WebRTC runtime, and automatic Node RTC server
registration are outside this implementation. WS/HTTP upstreams remain explicit
configuration choices.

See [browser test instructions and verified environments](browser/README.md).

## Service worker proxy

Multiple tabs can share one server connection held by a service worker. A
tab uses `Metacom` as usual, the worker forwards packets and routes replies
to the tab that sent the call or created the stream.

Service worker:

```js
import { MetacomProxy } from './metacom.js';

const proxy = new MetacomProxy({
  // Runs after each connect, before queued calls are sent
  restore: async (server) => {
    await server.load('auth');
    await server.api.auth.restore({ token });
  },
});

// Methods handled in the worker, the rest of the unit is proxied
proxy.register('chat', {
  send: async ({ room, text }, context) => {
    const message = await storage.append(room, text);
    context.broadcast('chat/message', message);
    return { id: message.id };
  },
});

self.addEventListener('activate', (event) => {
  event.waitUntil(proxy.open());
});
```

Create `MetacomProxy` during the initial script evaluation: it subscribes to
the worker `message` event.

Tab:

```js
const registration = await navigator.serviceWorker.ready;
const worker = registration.active;
const metacom = await Metacom.connect(url, { worker });
await metacom.load('chat');
await metacom.api.chat.send({ room, text });
metacom.on('status', ({ connected }) => {
  // Worker reached or lost the server
});
```

| Behaviour     | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| Identity      | Server sees one client and one session for all tabs          |
| Calls         | Reply goes to the tab that sent the call                     |
| Events        | Server events are delivered to all tabs                      |
| Streams       | Routed by stream id created in the tab                       |
| Offline calls | Queued in memory, sent after reconnect, 503 if queue is full |
| Offline load  | Local methods at once, server methods added after reconnect  |
| Heartbeat     | Tab pings worker, reconnects if worker is restarted          |
| Closed tabs   | Worker drops their routes and terminates their uploads       |

Proxy options, all optional:

| Option             | Default                 | Description                    |
| ------------------ | ----------------------- | ------------------------------ |
| `url`              | `ws(s)://<worker host>` | Server url, `ws` or `http`     |
| `callTimeout`      | `7000`                  | Route lifetime for a call, ms  |
| `reconnectTimeout` | `2000`                  | Delay between connect attempts |
| `queueSize`        | `1000`                  | Calls kept while offline       |
| `restore`          |                         | `async (server) => {}` hook    |
| `generateId`       | `generateUUID`          | Id generator for worker calls  |
| `sweepInterval`    | `10000`                 | Cleanup period, ms             |

Handler context:

| Field                           | Description                          |
| ------------------------------- | ------------------------------------ |
| `context.server`                | Worker `Metacom` connected to server |
| `context.emit(name, data)`      | Event for the calling tab            |
| `context.broadcast(name, data)` | Event for all other tabs             |

`proxy.broadcast(name, data)` sends an event to all tabs. Proxy emits
`connect` and `disconnect` with tab id, and `error`.

Tab options for `Metacom.connect(url, { worker })`: `callTimeout`,
`generateId`, `pingInterval` (20000), `pongTimeout` (5000),
`handshakeTimeout` (5000).

## License & Contributors

Copyright (c) 2018-2026 [Metarhia contributors](https://github.com/metarhia/metacom/graphs/contributors).
Metacom is [MIT licensed](./LICENSE).\
Metacom is a part of [Metarhia](https://github.com/metarhia) technology stack.
