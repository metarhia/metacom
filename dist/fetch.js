const http = require('http');
const https = require('https');
const transport = { http, https };

export function fetch(url, options) {
  const dest = new URL(url);
  return new Promise((resolve, reject) => {
    const protocol = transport[dest.protocol.slice(0, -1)];
    const req = protocol.request(url, options, async res => {
      const buffers = [];
      for await (const chunk of res) {
        buffers.push(chunk);
      }
      resolve(Buffer.concat(buffers).toString());
    });
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}
