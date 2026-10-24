'use strict';

const { Emitter } = require('metautil');

class ClientTransport extends Emitter {
  active = false;

  constructor(url) {
    super();
    this.url = url;
  }

  send(obj) {
    this.write(JSON.stringify(obj));
  }

  // eslint-disable-next-line class-methods-use-this
  online() {}
  // eslint-disable-next-line class-methods-use-this
  offline() {}
}

module.exports = { ClientTransport };
