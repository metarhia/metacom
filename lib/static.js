'use strict';

const path = require('path');

const index = (url) => path.join(url, 'index.html');

const serveStatic = (channel) => {
  const { req, res, application } = channel;
  if (res.writableEnded) return;
  const { url } = req;
  const filePath = url.endsWith('/') ? index(url) : url;
  const fileExt = path.extname(filePath).substring(1);
  const data = application.getStaticFile(filePath);
  if (data) {
    channel.write(data, 200, fileExt);
    return;
  }
  if (fileExt !== 'html') {
    if (application.getStaticFile(index(filePath))) {
      channel.redirect(filePath + '/');
      return;
    }
  }
  channel.error(404);
};

module.exports = { serveStatic };
