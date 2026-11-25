'use strict';

const { Metacom } = require('./metacom.js');
const { MetacomRouter } = require('./router.js');

// Service Worker control messages, the tab port carries metacom packets
const CONTROL = {
  'metacom:connect': (proxy, event) => {
    const clientId = event.source?.id ?? '';
    proxy.attach(event.ports[0], { ...event.data, clientId });
  },
  'metacom:ping': (proxy, event) => {
    const port = proxy.port(event.data.id);
    if (!port) return void event.source?.postMessage({ type: 'metacom:reset' });
    port.postMessage({ type: 'metacom:pong', instance: proxy.instance });
  },
  'metacom:disconnect': (proxy, event) => {
    proxy.detach(event.data.id);
  },
  'metacom:online': () => {
    Metacom.online();
  },
  'metacom:offline': () => {
    Metacom.offline();
  },
};

const getWorkerUrl = () => {
  const { protocol, host } = self.location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}`;
};

class MetacomProxy extends MetacomRouter {
  #scope;
  #listener;
  #tabs = new Set();
  #connected = false;

  constructor(options = {}) {
    const scope = globalThis.self;
    if (!scope) {
      throw new Error('MetacomProxy must run in ServiceWorker context');
    }
    const getClients = async () => {
      if (!scope.clients) return null;
      return scope.clients.matchAll({ includeUncontrolled: true, type: 'all' });
    };
    super({ ...options, url: options.url ?? getWorkerUrl(), getClients });
    this.#scope = scope;
    this.#listener = (event) => this.#control(event);
    scope.addEventListener('message', this.#listener);
    this.on('connect', (id) => this.#tabs.add(id));
    this.on('disconnect', (id) => this.#tabs.delete(id));
    this.server.on('open', () => this.#notify(true));
    this.server.on('close', () => this.#notify(false));
  }

  #control(event) {
    const type = event.data?.type;
    const handler = Object.hasOwn(CONTROL, type) ? CONTROL[type] : null;
    if (handler) handler(this, event);
  }

  // Tab waits for ready before it treats the port as connected
  attach(port, options = {}) {
    if (!port) return;
    const { instance, active: connected } = this;
    port.postMessage({ type: 'metacom:ready', instance, connected });
    super.attach(port, options);
  }

  // Failed reconnect attempts close the transport again and again
  #notify(connected) {
    if (this.#connected === connected) return;
    this.#connected = connected;
    const message = { type: 'metacom:status', connected };
    for (const id of this.#tabs) this.port(id).postMessage(message);
  }

  // Disconnect goes through the port to follow packets sent before it
  receive(port, data) {
    if (data?.type !== 'metacom:disconnect') {
      return void super.receive(port, data);
    }
    if (this.port(data.id) === port) this.detach(data.id);
  }

  close() {
    this.#scope.removeEventListener?.('message', this.#listener);
    super.close();
  }
}

module.exports = { MetacomProxy };
