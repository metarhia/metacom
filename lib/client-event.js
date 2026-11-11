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
      const isPacket = typeof data === 'string' || ArrayBuffer.isView(data);
      if (isPacket) this.emit('message', data);
      else this.#handleControl(data);
    });
    port1.start();
    const { callTimeout } = options;
    const message = { type: 'metacom:connect', callTimeout };
    this.#worker.postMessage(message, [port2]);
    this.active = true;
    this.emit('open');
  }

  #handleControl({ type, connected }) {
    if (type === 'metacom:status') this.emit('status', { connected });
  }

  close() {
    if (!this.#port) return;
    this.active = false;
    this.#port.close();
    this.#port = null;
    this.emit('close');
  }

  announce(id) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage({ type: 'metacom:stream', id });
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
