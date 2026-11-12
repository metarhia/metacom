import { MetacomProxy } from './metacom.mjs';

const proxy = new MetacomProxy({
  url: 'example-peer',
  transport: 'rtc-bridge',
  bridge: {
    peerId: 'host',
    authorize: (client) =>
      new URL(client.url).searchParams.get('role') === 'owner',
  },
});
proxy.register('local', { sum: ({ a, b }) => a + b });
proxy.open().catch(() => {});
self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
