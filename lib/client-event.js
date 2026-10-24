'use strict';

const { ClientTransport } = require('./client-transport.js');

class ClientEventTransport extends ClientTransport {
  static instance = null;

  #port = null;
  #worker = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  async open(options = {}) {
    if (this.active) return;
    const worker = options.worker ?? this.#worker;
    if (!worker) throw new Error('Service Worker not provided');
    this.#worker = worker;
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    port1.addEventListener('message', ({ data }) => {
      if (data === undefined) return;
      this.emit('message', data);
    });
    port1.start();
    this.#worker.postMessage({ type: 'metacom:connect' }, [port2]);
    this.active = true;
    this.emit('open');
  }

  close() {
    this.active = false;
    this.#port.close();
    this.#port = null;
    this.emit('close');
  }

  online() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:online' });
  }

  offline() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:offline' });
  }

  write(data) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage(data);
  }
}

module.exports = { ClientEventTransport };
