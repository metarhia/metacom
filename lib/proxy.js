'use strict';

const { Metacom } = require('./metacom.js');
const { MetacomRouter } = require('./router.js');

const getWorkerUrl = () => {
  const { protocol, host } = self.location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}`;
};

class MetacomProxy extends MetacomRouter {
  #scope;
  #listener;

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
  }

  #control(event) {
    if (!event.data) return;
    const { type, id } = event.data;
    if (type === 'metacom:connect') {
      this.attach(event.ports[0], {
        ...event.data,
        client: event.source?.id ?? '',
      });
    } else if (type === 'metacom:ping') {
      const port = this.port(id);
      if (port) {
        port.postMessage({ type: 'metacom:pong', instance: this.instance });
      } else {
        event.source?.postMessage({ type: 'metacom:reset' });
      }
    } else if (type === 'metacom:disconnect') {
      this.detach(id);
    } else if (type === 'metacom:online') {
      Metacom.online();
    } else if (type === 'metacom:offline') {
      Metacom.offline();
    }
  }

  close() {
    this.#scope.removeEventListener?.('message', this.#listener);
    super.close();
  }
}

module.exports = { MetacomProxy };
