# Metacom Communication Protocol for Metarhia

[![ci status](https://github.com/metarhia/metacom/workflows/Testing%20CI/badge.svg)](https://github.com/metarhia/metacom/actions?query=workflow%3A%22Testing+CI%22+branch%3Amaster)
[![snyk](https://snyk.io/test/github/metarhia/metacom/badge.svg)](https://snyk.io/test/github/metarhia/metacom)
[![npm version](https://badge.fury.io/js/metacom.svg)](https://badge.fury.io/js/metacom)
[![npm downloads/month](https://img.shields.io/npm/dm/metacom.svg)](https://www.npmjs.com/package/metacom)
[![npm downloads](https://img.shields.io/npm/dt/metacom.svg)](https://www.npmjs.com/package/metacom)

Metacom protocol specification:
https://github.com/metarhia/Contracts/blob/master/doc/Metacom.md

```js
import { Metacom } from 'metacom';
// const { Metacom } = require('metacom'); // for backend

const metacom = Metacom.create('ws://domainname.com:8000');
const { api } = metacom;
try {
  await metacom.load('auth'); // Load `auth` interface
  await api.auth.status(); // Check session status
} catch (err) {
  await api.auth.signIn({ login: 'marcus', password: 'marcus' });
}
await metacom.load('example'); // Load `example` interface
const result = api.example.methodName({ arg1, arg2 });
```

## Streams over Websocket

### Example: big file upload

Create `uploadFile` function on the client:

```js
const metacom = Metacom.create('ws://example.com/api');

const uploadFile = async (file) => {
  // createBlobUploader creates streamId and inits file reader for convenience
  const uploader = metacom.createBlobUploader(file);
  // Prepare backend file consumer
  await metacom.api.files.upload({
    streamId: uploader.streamId,
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
const metacom = Metacom.create('ws://example.com/api');

const downloadFile = async (name) => {
  // Init backend file producer to get streamId
  const { streamId } = await metacom.api.files.download({ name });
  // Get metacom readable stream
  const readable = await metacom.getStream(streamId);
  // Convert stream to blob to make a file on the client
  const blob = await readable.toBlob();
  return new File([blob], name);
};
```

Create API method to init file source:

```js
// api/files/download.js
async ({ name }) => {
  const filePath = `./application/resources/${name}`;
  // Create nodejs readable stream to read a file
  const readable = node.fs.createReadStream(filePath);
  // Get file size
  const { size } = await node.fsp.stat(filePath);
  // Create metacom writable stream
  const writable = context.client.createStream(name, size);
  // Pipe nodejs readable to metacom writable
  readable.pipe(writable);
  return { streamId: writable.streamId };
};
```

## License & Contributors

Copyright (c) 2018-2024 [Metarhia contributors](https://github.com/metarhia/metacom/graphs/contributors).
Metacom is [MIT licensed](./LICENSE).\
Metacom is a part of [Metarhia](https://github.com/metarhia) technology stack.
