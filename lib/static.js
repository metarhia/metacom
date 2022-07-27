'use strict';

const path = require('path');
const metautil = require('metautil');

const index = (url) => path.join(url, 'index.html');

const serveStatic = (channel) => {
  const { req, res, application } = channel;
  if (res.writableEnded) return;
  const { url } = req;
  const [urlPath, params] = metautil.split(url, '?');
  const filePath = urlPath.endsWith('/') ? index(urlPath) : urlPath;
  const fileExt = path.extname(filePath).substring(1);
  const data = application.getStaticFile(filePath);
  if (data) {
    channel.write(data, 200, fileExt);
    return;
  }
  if (fileExt !== 'html') {
    if (application.getStaticFile(index(filePath))) {
      const query = params ? '?' + params : '';
      channel.redirect(filePath + '/' + query);
      return;
    }
  }
  channel.error(404);
};

module.exports = { serveStatic };
