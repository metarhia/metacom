'use strict';

const path = require('path');

const serveStatic = (channel) => {
  const { req, res, ip, application } = channel;
  if (res.writableEnded) return;
  const { url, method } = req;
  application.console.log(`${ip}\t${method}\t${url}`);
  const filePath = url === '/' ? '/index.html' : url;
  const fileExt = path.extname(filePath).substring(1);
  const data = application.getStaticFile(filePath);
  if (data) channel.write(data, 200, fileExt);
  else channel.error(404);
};

module.exports = { serveStatic };
