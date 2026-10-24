'use strict';

const { ClientTransport } = require('./client-transport.js');

class ClientHttpTransport extends ClientTransport {
  async open() {
    if (this.active) return;
    this.active = true;
    this.emit('open');
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.emit('close');
  }

  write(data) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: data };
    const send = async () => {
      try {
        const res = await fetch(this.url, options);
        const packet = await res.text();
        this.emit('message', packet);
      } catch (error) {
        this.emit('error', error);
      }
    };
    send();
  }
}

module.exports = { ClientHttpTransport };
