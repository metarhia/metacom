'use strict';

const { isMainThread, workerData } = require('node:worker_threads');
const { MetacomPeer } = require('../../lib/peer.js');

const main = () => {
  const peer = new MetacomPeer({ port: workerData.port });
  peer.register('echo', {
    run: async (args) => args,
    reverse: async ({ list }) => list.reverse(),
    fail: async () => {
      throw Object.assign(new Error('Denied'), { code: 403 });
    },
    ask: async (args) => peer.call('main', 'double', args.value),
  });
  peer.open();
  peer.send('worker', 'ready', { at: new Date(0) });
};

// node --test also loads fixtures as test files, only a Worker has a port
if (!isMainThread) main();
