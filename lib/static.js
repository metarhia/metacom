'use strict';

const path = require('path');

const serveStatic = (channel) => {
  const { req, res, application } = channel;
  if (res.writableEnded) return;
  const { url } = req;
  const filePath = url.endsWith('/') ? url + 'index.html' : url;
  const fileExt = path.extname(filePath).substring(1);
  const data = application.getStaticFile(filePath);
  if (data) {
    channel.write(data, 200, fileExt);
  } else if (fileExt !== 'html') {
    const check = application.getStaticFile(`${filePath}/index.html`);
    check ? channel.redirect(`${filePath}/`) : channel.error(404);
  } else {
    channel.error(404);
  }
};

module.exports = { serveStatic };
