'use strict';

const path = require('path');

const serveStatic = (channel, protocol) => {
  const { req, res, application } = channel;
  const {
    headers: { host },
  } = req;
  const redirect = `${protocol}://${host}`;
  if (res.writableEnded) return;
  const { url } = req;
  const filePath = url.endsWith('/') ? url + 'index.html' : url;
  const fileExt = path.extname(filePath).substring(1);
  const data = application.getStaticFile(filePath);
  if (data) {
    channel.write(data, 200, fileExt);
  } else {
    if (fileExt === '') {
      channel.redirect(`${redirect}${filePath}/`);
      return;
    }
    const handle404 = application.getStaticFile('/404/index.html');
    handle404 ? channel.redirect(`${redirect}/404/`) : channel.error(404);
  }
};

module.exports = { serveStatic };
