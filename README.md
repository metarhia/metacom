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
