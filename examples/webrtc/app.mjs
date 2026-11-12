import { Metacom, MetacomPeer, MetacomRtcBridge } from './metacom.mjs';
import { broadcastSignaling } from './signaling.mjs';

const params = new URL(location.href).searchParams;
const role = params.get('role');
const signaling = broadcastSignaling('metacom-example');
const status = document.getElementById('status');
const rtc = (localId, peerId, peerRole) => ({
  localId,
  peerId,
  role: peerRole,
  signaling,
  configuration: { iceServers: [] },
});
let host;
let client;
let bridge;
let registration;

const worker = async () => {
  registration = await navigator.serviceWorker.register(
    new URL('./worker.mjs', import.meta.url),
    { type: 'module' },
  );
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, {
        once: true,
      });
    });
  }
  return navigator.serviceWorker.controller;
};

const run = async () => {
  if (!role) return;
  status.textContent = `Starting ${role}…`;
  if (role === 'host') {
    host = new MetacomPeer({
      rtc: rtc('host', params.get('peer') ?? 'caller', 'answerer'),
    });
    host.register('demo', { echo: (args) => args });
    status.textContent = 'Listening for the selected peer…';
    await host.open();
    status.textContent = 'Peer connected.';
    return;
  }
  if (role === 'owner') {
    bridge = MetacomRtcBridge.attach(
      await worker(),
      rtc('owner', 'host', 'offerer'),
    );
    await bridge.ready;
    globalThis.example.result = { bridge: true };
    status.textContent = 'Worker RTC bridge connected. Keep this tab open.';
    return;
  }
  const options =
    role === 'worker-client'
      ? { worker: await worker() }
      : {
          transport: 'webrtc',
          rtc: rtc('caller', 'host', 'offerer'),
        };
  client = await Metacom.connect('example-peer', options);
  await client.load('demo');
  const result = await client.api.demo.echo({ hello: role });
  if (role === 'worker-client') {
    await client.load('local');
    result.sum = await client.api.local.sum({ a: 2, b: 3 });
  }
  globalThis.example.result = result;
  status.textContent = JSON.stringify(result, null, 2);
};

globalThis.example = {
  result: null,
  ready: run(),
  async close() {
    client?.close();
    bridge?.close();
    host?.close();
    signaling.close();
    await registration?.unregister();
  },
};
globalThis.example.ready.catch((error) => {
  status.textContent = error.message;
});
window.addEventListener('pagehide', () => {
  globalThis.example.close();
});
