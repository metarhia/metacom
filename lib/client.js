'use strict';

const { Emitter, generateUUID } = require('metautil');

const { WebSocket } = globalThis;

const PING_INTERVAL_MS = 20 * 1000;
const PONG_TIMEOUT_MS = 5 * 1000;
const HANDSHAKE_TIMEOUT_MS = 5 * 1000;

const startInterval = (listener, interval) => {
  const timer = setInterval(listener, interval);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

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
  announce() {}
  // eslint-disable-next-line class-methods-use-this
  online() {}
  // eslint-disable-next-line class-methods-use-this
  offline() {}
}

class ClientWsTransport extends ClientTransport {
  #socket = null;
  #opening = null;

  async open() {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.#socket = socket;
      const onClose = (error) => {
        this.#socket = null;
        if (this.#opening) {
          this.#opening = null;
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
        const response = await fetch(this.url, options);
        const packet = await response.text();
        this.emit('message', packet);
      } catch (error) {
        this.emit('error', error);
      }
    };
    send();
  }
}

class ClientEventTransport extends ClientTransport {
  static instance = null;

  #id = generateUUID();
  #port = null;
  #worker = null;
  #container = null;
  #instance = '';
  #opening = null;
  #handshake = null;
  #pingTimer = null;
  #pongTimer = null;
  #pingInterval = PING_INTERVAL_MS;
  #pongTimeout = PONG_TIMEOUT_MS;
  #handshakeTimeout = HANDSHAKE_TIMEOUT_MS;
  #onContainerMessage = null;
  #onControllerChange = null;
  #onPageHide = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  constructor(url) {
    super(url);
    this.#onContainerMessage = ({ data }) => {
      if (data?.type === 'metacom:reset') this.#drop();
    };
    // First claim reports the worker this tab is already connected to
    this.#onControllerChange = () => {
      const { controller } = this.#container;
      if (!controller || controller === this.#worker) return;
      this.#worker = controller;
      this.#drop();
    };
    this.#onPageHide = () => {
      this.#disconnect();
      this.#drop();
    };
  }

  async open(options = {}) {
    if (this.active) return;
    if (this.#opening) {
      await this.#opening;
      return;
    }
    this.#configure(options);
    if (!this.#worker) throw new Error('Service Worker not provided');
    this.#opening = this.#connect(options.callTimeout);
    try {
      await this.#opening;
    } finally {
      this.#opening = null;
    }
  }

  #configure(options) {
    const { pingInterval, pongTimeout, handshakeTimeout } = options;
    if (pingInterval) this.#pingInterval = pingInterval;
    if (pongTimeout) this.#pongTimeout = pongTimeout;
    if (handshakeTimeout) this.#handshakeTimeout = handshakeTimeout;
    const container = options.container ?? globalThis.navigator?.serviceWorker;
    this.#container = container ?? null;
    const worker = this.#worker ?? options.worker ?? null;
    const isStale = worker !== null && worker.state === 'redundant';
    const controller = this.#container ? this.#container.controller : null;
    this.#worker = isStale && controller ? controller : worker;
  }

  // Worker answers with metacom:ready when it holds the other port
  #connect(callTimeout) {
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      this.#port = port1;
      port1.addEventListener('message', ({ data }) => {
        if (this.#port === port1) this.#receive(data);
      });
      port1.start();
      const timer = setTimeout(() => {
        this.#reject(new Error('Service Worker handshake timeout'));
        this.#release();
      }, this.#handshakeTimeout);
      this.#handshake = { resolve, reject, timer };
      const message = { type: 'metacom:connect', id: this.#id, callTimeout };
      this.#worker.postMessage(message, [port2]);
    });
  }

  #receive(data) {
    if (data === undefined) return;
    const isPacket = typeof data === 'string' || ArrayBuffer.isView(data);
    if (isPacket) return void this.emit('message', data);
    const { type } = data;
    if (type === 'metacom:ready') this.#accept(data);
    else if (type === 'metacom:pong') this.#alive(data.instance);
    else if (type === 'metacom:status') this.#report(data.connected);
  }

  #accept({ instance, connected }) {
    const handshake = this.#handshake;
    if (!handshake) return;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    this.#instance = instance;
    this.active = true;
    this.#bind();
    this.#pingTimer = startInterval(() => this.#ping(), this.#pingInterval);
    this.emit('open');
    handshake.resolve();
    this.#report(connected);
  }

  #reject(error) {
    const handshake = this.#handshake;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    handshake.reject(error);
  }

  #report(connected) {
    this.emit('status', { connected });
  }

  // Ping is posted to the worker itself to extend its lifetime
  #ping() {
    this.#worker.postMessage({ type: 'metacom:ping', id: this.#id });
    if (this.#pongTimer) return;
    this.#pongTimer = setTimeout(() => this.#drop(), this.#pongTimeout);
  }

  // Restarted worker has another instance id and no port of this tab
  #alive(instance) {
    clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
    if (instance !== this.#instance) this.#drop();
  }

  #bind() {
    const container = this.#container;
    if (container) {
      container.addEventListener('message', this.#onContainerMessage);
      container.addEventListener('controllerchange', this.#onControllerChange);
    }
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', this.#onPageHide);
  }

  #unbind() {
    const container = this.#container;
    if (container) {
      container.removeEventListener('message', this.#onContainerMessage);
      const onChange = this.#onControllerChange;
      container.removeEventListener('controllerchange', onChange);
    }
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.#onPageHide);
  }

  #release() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
    if (this.#handshake) this.#reject(new Error('Connection closed'));
    this.#unbind();
    if (this.#port) this.#port.close();
    this.#port = null;
    this.active = false;
  }

  // Connection to the worker is lost, Metacom reconnects on close
  #drop() {
    if (!this.active) return;
    this.#release();
    this.emit('close');
  }

  #disconnect() {
    this.#worker.postMessage({ type: 'metacom:disconnect', id: this.#id });
  }

  close() {
    if (!this.#port) return;
    const wasActive = this.active;
    this.#disconnect();
    this.#release();
    if (wasActive) this.emit('close');
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

const TRANSPORTS = {
  ws: ClientWsTransport,
  http: ClientHttpTransport,
  event: ClientEventTransport,
};

module.exports = {
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  TRANSPORTS,
};
