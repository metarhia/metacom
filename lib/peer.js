'use strict';

const { Emitter, jsonParse } = require('metautil');
const { ClientRtcTransport } = require('./client.js');
const { MetacomRouter } = require('./router.js');

class MetacomPeer extends Emitter {
  #router;
  #options;
  #sessions = new Map();
  #closed = true;

  constructor(options) {
    super();
    this.#options = options;
    this.#router = new MetacomRouter({ ...options, localStreams: true });
    this.#router.on('error', (error) => this.#report(error));
  }

  get active() {
    for (const session of this.#sessions.values()) {
      if (session.transport.active) return true;
    }
    return false;
  }

  register(unit, methods) {
    this.#router.register(unit, methods);
  }

  broadcast(name, data) {
    this.#router.broadcast(name, data);
  }

  open() {
    if (!this.#closed) return Promise.resolve();
    const peers = Array.isArray(this.#options.rtc)
      ? this.#options.rtc
      : [this.#options.rtc];
    const ids = new Set();
    for (const rtc of peers) {
      if (!rtc || ids.has(rtc.peerId)) {
        return Promise.reject(new Error('Unique RTC peers required'));
      }
      ids.add(rtc.peerId);
    }
    this.#closed = false;
    for (const rtc of peers) {
      this.#connect(rtc).catch((error) => this.#report(error));
    }
    return Promise.resolve();
  }

  async #connect(rtc) {
    const transport = new ClientRtcTransport(rtc.peerId);
    const session = { transport, timer: null, rtc };
    const messageListeners = new Set();
    this.#sessions.set(rtc.peerId, session);
    const port = {
      postMessage: (data) => {
        if (typeof data === 'object' && !ArrayBuffer.isView(data)) return true;
        return transport.write(data);
      },
      drain: () => transport.drain(),
      addEventListener: (name, listener) => {
        if (name !== 'message') return;
        const onMessage = (data) => {
          const packet = typeof data === 'string' ? jsonParse(data) : data;
          listener({ data: packet?.type === 'metacom:stream' ? packet : data });
        };
        messageListeners.add(onMessage);
        transport.on('message', onMessage);
      },
      start: () => {},
      close: () => {
        for (const listener of messageListeners) {
          transport.off('message', listener);
        }
        messageListeners.clear();
        transport.close();
      },
    };
    transport.on('open', () => {
      this.#router.attach(port, { id: rtc.peerId });
      this.emit('connect', rtc.peerId);
    });
    transport.on('close', () => {
      this.#router.detach(rtc.peerId);
      if (this.#closed || session.timer) return;
      session.timer = setTimeout(() => {
        session.timer = null;
        transport.open({ rtc }).catch((error) => this.#report(error));
      }, this.#options.reconnectTimeout ?? 2000);
      this.emit('disconnect', rtc.peerId);
    });
    await transport.open({ rtc });
  }

  #report(error) {
    if (this.listenerCount('error')) this.emit('error', error);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { transport, timer } of this.#sessions.values()) {
      clearTimeout(timer);
      transport.close();
    }
    this.#sessions.clear();
    this.#router.close();
  }
}

module.exports = { MetacomPeer };
