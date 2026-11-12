'use strict';

const { Emitter, generateUUID, delay, jsonParse } = require('metautil');
const { RtcConnection } = require('./rtc.js');
const { RtcChannelEndpoint } = require('./rtc-channel.js');

const { WebSocket } = globalThis;

const PING_INTERVAL_MS = 20 * 1000;
const PONG_TIMEOUT_MS = 5 * 1000;
const HANDSHAKE_TIMEOUT_MS = 5 * 1000;
const BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_INTERVAL_MS = 10;

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

  static create(url) {
    return new this(url);
  }

  send(obj) {
    this.write(JSON.stringify(obj));
  }

  // eslint-disable-next-line class-methods-use-this
  drain() {
    return Promise.resolve();
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
      const rejectOpen = () => {
        if (!this.#opening) return;
        this.#opening = null;
        this.#socket = null;
        reject(new Error('Connection closed'));
        // Node.js 22 reports a refused handshake with error and no close.
        // close() in that turn re-enters and overflows the stack.
        if (socket.readyState !== WebSocket.CONNECTING) return;
        queueMicrotask(() => {
          if (socket.readyState === WebSocket.CONNECTING) socket.close();
        });
      };
      const onClose = (event) => {
        if (this.#opening) return void rejectOpen();
        this.#socket = null;
        if (!this.active) return;
        this.active = false;
        this.emit('close', event);
      };
      const onOpen = () => {
        if (!this.#opening) return;
        this.active = true;
        this.emit('open');
        this.#opening = null;
        resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
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
    return this.#socket.bufferedAmount < BUFFER_HIGH_WATER_BYTES;
  }

  // Browser WebSocket has no drain event, bufferedAmount is polled
  async drain() {
    while (this.#isBuffered()) await delay(DRAIN_INTERVAL_MS);
  }

  #isBuffered() {
    const socket = this.#socket;
    if (!socket) return false;
    return socket.bufferedAmount >= BUFFER_HIGH_WATER_BYTES;
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
    this.#post(data);
  }

  // Failed request is answered with callback error to reject the call
  async #post(data) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: data };
    try {
      const response = await fetch(this.url, options);
      const type = response.headers.get('Content-Type') ?? '';
      if (type.startsWith('application/json')) {
        const packet = await response.text();
        return void this.emit('message', packet);
      }
      const message = response.statusText || 'Invalid response';
      const code = response.ok ? 502 : response.status;
      this.#reply(data, { message, code });
    } catch (error) {
      this.#reply(data, { message: error.message, code: 503 });
    }
  }

  #reply(data, error) {
    const request = jsonParse(data);
    const id = request?.id ?? '';
    const packet = { type: 'callback', id, error };
    this.emit('message', JSON.stringify(packet));
  }
}

class ClientRtcTransport extends ClientTransport {
  static capabilities = { duplex: true, streams: true, events: true };
  #connection = new RtcConnection();
  #endpoint = null;
  #opening = null;
  #cycle = 0;

  constructor(url) {
    super(url);
    this.#connection.on('close', (error) => this.#release(error));
  }

  open(options = {}) {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const cycle = ++this.#cycle;
    this.#opening = this.#connection
      .open(options.rtc)
      .then((channel) => {
        if (cycle !== this.#cycle) throw new Error('RTC connection closed');
        const maxMessageSize =
          this.#connection.peerConnection.sctp?.maxMessageSize;
        const endpoint = new RtcChannelEndpoint(channel, {
          ...options.rtc,
          maxMessageSize,
        });
        this.#endpoint = endpoint;
        endpoint.on('message', (data) => this.emit('message', data));
        endpoint.on('close', (error) => {
          this.#release(error);
          this.#connection.close();
        });
        this.active = true;
        this.emit('open');
      })
      .catch((error) => {
        this.#connection.close();
        throw error;
      })
      .finally(() => {
        if (cycle === this.#cycle) this.#opening = null;
      });
    return this.#opening;
  }

  #release(error) {
    if (!this.active && !this.#opening) return;
    this.#cycle++;
    this.#opening = null;
    this.active = false;
    const endpoint = this.#endpoint;
    this.#endpoint = null;
    endpoint?.close();
    this.emit('close', error);
  }

  close() {
    this.#connection.close();
    this.#release();
  }

  write(data) {
    if (!this.active) throw new Error('RTC transport is not connected');
    return this.#endpoint.write(data);
  }

  drain() {
    return this.#endpoint?.drain() ?? Promise.resolve();
  }

  announce(id) {
    this.send({ type: 'metacom:stream', id });
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

  // Tab has one connection to the worker
  static create(url) {
    return ClientEventTransport.getInstance(url);
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
  webrtc: ClientRtcTransport,
};

module.exports = {
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  ClientRtcTransport,
  TRANSPORTS,
};
