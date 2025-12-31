'use strict';
importScripts('metacom.iife.js');

// exists in global scope after importScripts
const { Metacom } = metacomIIFE;

const METACOMS_BY_URL = new Map();

const EXECUTORS = {
  DOWNLOAD: downloadFile,
  UPLOAD: uploadFile,
};

self.addEventListener('message', async ({ data, ports } = {}) => {
  if (!ports[0] || !data || data.type !== 'PORT_INITIALIZATION') {
    return;
  }
  const messagePort = ports[0];
  const { url, metacomLoad } = data;

  let metacom = METACOMS_BY_URL.get(url);

  if (!metacom) {
    metacom = Metacom.create(url);
    METACOMS_BY_URL.set(url, metacom);
  }

  messagePort.onmessage = (event) => {
    const executor = EXECUTORS[event.data.type] || callMethod;
    executor(metacom, messagePort, event.data);
  };

  const introspection = await metacom.load(...metacomLoad);

  messagePort.postMessage({ type: 'INTROSPECTION', payload: introspection });
});

async function callMethod(metacom, messagePort, data) {
  const { unit, method, packet } = data;
  const { id, args } = packet;
  const result = await metacom.api[unit][method](args);
  messagePort.postMessage({
    type: 'CALLBACK',
    payload: {
      result,
      type: 'callback',
      id,
      name: unit + '/' + method,
    },
  });
}

async function uploadFile(metacom, messagePort, data) {
  const { fileArrayBuffer, meta } = data;
  const file = new File([fileArrayBuffer], meta.name, { type: meta.type });
  await metacom.uploadFile(file, { unit: meta.unit, method: meta.method });
  messagePort.postMessage({ type: 'UPLOADED', payload: { done: true, meta } });
}

async function downloadFile(metacom, messagePort, data) {
  const { packet, meta } = data;
  const file = await metacom.downloadFile(packet.name, {
    unit: meta.unit,
    method: meta.method,
  });
  const arrayBuffer = await file.arrayBuffer();
  messagePort.postMessage(
    { type: 'DOWNLOADED', payload: { done: true, meta, arrayBuffer } },
    [arrayBuffer],
  );
}
