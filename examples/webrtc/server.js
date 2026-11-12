'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const routes = {
  '/': 'examples/webrtc/index.html',
  '/app.mjs': 'examples/webrtc/app.mjs',
  '/worker.mjs': 'examples/webrtc/worker.mjs',
  '/signaling.mjs': 'examples/webrtc/signaling.mjs',
  '/metacom.mjs': 'metacom.mjs',
  '/metautil.js': 'node_modules/metautil/metautil.mjs',
};
const root = path.resolve(__dirname, '../..');
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = routes[pathname];
  if (!file) {
    res.writeHead(404);
    return void res.end();
  }
  try {
    res.setHeader(
      'Content-Type',
      pathname === '/' ? 'text/html' : 'text/javascript',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(await fs.readFile(path.join(root, file)));
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});
server.listen(8008, '127.0.0.1', () => {
  console.log('Open http://127.0.0.1:8008/ for the WebRTC examples');
});
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
