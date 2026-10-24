'use strict';

const { ClientTransport } = require('./client-transport.js');

const { WebSocket } = globalThis;

class ClientWsTransport extends ClientTransport {
  #socket = null;
  #opening = null;

  async open() {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.#socket = socket;
      const onClose = (error) => {
        this.#socket = null;
        if (this.#opening) {
          this.#opening = null;
          this.emit('error', error);
          return void reject(new Error('Connection closed'));
        }
        this.active = false;
        this.emit('close', error);
      };
      const onOpen = () => {
        this.active = true;
        this.emit('open');
        this.#opening = null;
        resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('error', onClose, { once: true });
      socket.addEventListener('message', ({ data }) => {
        this.emit('message', data);
      });
    });
    this.#opening = opening;
    return opening;
  }

  close() {
    if (!this.active) return;
    this.#socket.close();
  }

  write(data) {
    if (!this.active) throw new Error('Not connected');
    this.#socket.send(data);
  }
}

module.exports = { ClientWsTransport };
