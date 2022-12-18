'use strict';

const metautil = require('metautil');

const serveStatic = (channel) => {
  const { req, res, application } = channel;
  if (res.writableEnded) return;
  const { url } = req;
  const [urlPath, params] = metautil.split(url, '?');
  const folder = urlPath.endsWith('/');
  const filePath = urlPath + (folder ? 'index.html' : '');
  const fileExt = metautil.fileExt(filePath);
  const data = application.getStaticFile(filePath);
  if (data) {
    channel.write(data, 200, fileExt);
    return;
  }
  if (!folder && application.getStaticFile(urlPath + '/index.html')) {
    const query = params ? '?' + params : '';
    channel.redirect(urlPath + '/' + query);
    return;
  }
  channel.error(404);
};

module.exports = { serveStatic };
