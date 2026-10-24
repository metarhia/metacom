'use strict';

const http = require('node:http');

const { Emitter } = require('metautil');
const { ClientTransport } = require('./client-transport.js');

const HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const buildHeaders = (cors) => {
  if (!cors?.origin) return HEADERS;
  return Object.assign({}, HEADERS, {
    'Access-Control-Allow-Origin': cors.origin,
  });
};

class ServerTransport extends Emitter {
  constructor(source) {
    super();
    this.source = source;
  }

  // eslint-disable-next-line class-methods-use-this
  close() {}

  error(code = 500, { id = '', error = null } = {}) {
    const status = http.STATUS_CODES[code] || 'Unknown error';
    const info = error ? error.message : status;
    const packet = { type: 'callback', id, error: { message: info, code } };
    this.send(packet, code);
  }

  send(obj, code = 200) {
    this.write(JSON.stringify(obj), code);
  }
}

module.exports = {
  ClientTransport,
  ServerTransport,
  buildHeaders,
};
