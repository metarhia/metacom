import { Metacom, MetacomPeer, MetacomRtcBridge } from './metacom.mjs';

const signalingChannel = new BroadcastChannel('metacom-browser-test');
const signaling = {
  send: (message) => signalingChannel.postMessage(message),
  subscribe(listener) {
    const receive = ({ data }) => listener(data);
    signalingChannel.addEventListener('message', receive);
    return () => signalingChannel.removeEventListener('message', receive);
  },
};

const rtc = (localId, peerId, role) => ({
  localId,
  peerId,
  role,
  signaling,
  configuration: { iceServers: [] },
  handshakeTimeout: 15000,
  pingInterval: 100,
  pongTimeout: 1500,
});

const bytes = () =>
  Uint8Array.from({ length: 100000 }, (_, index) => index % 251);
const equalBytes = (actual, expected) => {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error('Browser stream bytes differ');
  }
};

let host;
let client;
let owner;
let registration;

globalThis.lab = {
  hostReady: null,
  startHost(localId, peerIds, role = 'answerer') {
    host = new MetacomPeer({
      rtc: peerIds.map((id) => rtc(localId, id, role)),
      reconnectTimeout: 100,
    });
    host.register('test', {
      echo: (args) => args,
      fail: () => {
        const error = new Error('Browser failure');
        error.code = 409;
        throw error;
      },
      notify: ({ marker }, context) => {
        context.emit('test/changed', marker);
      },
      upload: async ({ id }, context) => {
        const actual = new Uint8Array(
          await (await context.getStream(id).toBlob()).arrayBuffer(),
        );
        equalBytes(actual, bytes());
        return actual.length;
      },
      download: async ({ id }, context) => {
        const payload = bytes();
        const stream = context.createStream('browser', payload.length, id);
        if (!stream.write(payload)) await stream.toPromise('drain');
        stream.end();
        return id;
      },
    });
    this.hostReady = host.open();
    this.hostReady.catch(() => {});
  },
  async connect(localId, peerId, role = 'offerer') {
    client = await Metacom.connect('logical-peer', {
      transport: 'webrtc',
      rtc: rtc(localId, peerId, role),
      reconnectTimeout: 100,
    });
  },
  async exercise(marker) {
    await client.load('test');
    const payload = { marker, text: '😀'.repeat(50000) };
    const reply = await client.api.test.echo(payload);
    if (reply.marker !== marker || reply.text !== payload.text) {
      throw new Error('RPC mismatch');
    }
    try {
      await client.api.test.fail();
      throw new Error('RPC did not fail');
    } catch (error) {
      if (error.code !== 409) throw error;
    }
    const event = new Promise((resolve) => {
      const listener = (data) => {
        if (data !== marker) return;
        client.api.test.off('changed', listener);
        resolve(data);
      };
      client.api.test.on('changed', listener);
    });
    await client.api.test.notify({ marker });
    const eventData = await event;
    if (eventData !== marker) throw new Error('Event mismatch');
    const uploader = client.createBlobUploader(new Blob([bytes()]));
    const upload = client.api.test.upload({ id: uploader.id });
    await uploader.upload();
    const uploaded = await upload;
    if (uploaded !== bytes().length) throw new Error('Upload mismatch');
    const readable = client.createReadable();
    await client.api.test.download({ id: readable.id });
    equalBytes(
      new Uint8Array(await (await readable.toBlob()).arrayBuffer()),
      bytes(),
    );
    return { marker, bytes: bytes().length, active: client.active };
  },
  async startWorker() {
    registration = await navigator.serviceWorker.register('/worker.mjs', {
      type: 'module',
    });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {
          once: true,
        });
      });
    }
    return registration.scope;
  },
  async attachOwner() {
    owner = MetacomRtcBridge.attach(
      navigator.serviceWorker.controller,
      rtc('owner', 'host', 'offerer'),
    );
    await owner.ready;
  },
  async connectWorker() {
    await this.startWorker();
    client = await Metacom.connect('logical-peer', {
      worker: navigator.serviceWorker.controller,
      reconnectTimeout: 100,
      pingInterval: 100,
      pongTimeout: 1500,
    });
    await client.load('local');
    const localSum = await client.api.local.sum({ a: 2, b: 3 });
    if (localSum !== 5) {
      throw new Error('Worker local RPC mismatch');
    }
  },
  ownerClosed() {
    return owner?.closed ?? true;
  },
  connected() {
    return client?.active ?? false;
  },
  updateWorker() {
    return registration.update();
  },
  closeOwner() {
    owner?.close();
  },
  closeHost() {
    host?.close();
  },
  async close() {
    client?.close();
    owner?.close();
    host?.close();
    signalingChannel.close();
    for (const entry of await navigator.serviceWorker.getRegistrations()) {
      await entry.unregister();
    }
  },
};
