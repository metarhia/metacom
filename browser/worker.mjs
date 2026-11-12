import { MetacomProxy } from './metacom.mjs';

const proxy = new MetacomProxy({
  url: 'logical-peer',
  transport: 'rtc-bridge',
  reconnectTimeout: 100,
  bridge: {
    peerId: 'host',
    authorize: (client) =>
      new URL(client.url).searchParams.get('role') === 'owner',
    pingInterval: 100,
    pongTimeout: 1500,
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
