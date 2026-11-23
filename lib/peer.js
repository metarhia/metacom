'use strict';

const { Emitter } = require('metautil');
const { ClientRtcTransport } = require('./client.js');
const { emitError, parseMethod } = require('./utils.js');
const { MetacomError } = require('./metacom.js');
const { MetacomRouter } = require('./router.js');

const PORT_CALL_TIMEOUT_MS = 7 * 1000;
const PORT_NOT_FOUND = { message: 'Not Found', code: 404 };

const encodeFailure = (error) => {
  const message = error?.message ?? `${error}`;
  const code = error?.code;
  const isCode = typeof code === 'number' || typeof code === 'string';
  return { message, code: isCode ? code : 500 };
};

// Symmetric link on one MessagePort: packets are posted as objects,
// so structured clone keeps Date, Map, Set, undefined, and typed arrays
class PortLink {
  #peer;
  #port;
  #callTimeout;
  #units = new Map();
  #calls = new Map();
  #subscribers = new Map();
  #sequence = 0;
  #closed = true;
  #onMessage = null;
  #onClose = null;

  constructor(peer, options) {
    this.#peer = peer;
    this.#port = options.port;
    this.#callTimeout = options.callTimeout || PORT_CALL_TIMEOUT_MS;
    this.#onMessage = (event) => this.#receive(event.data);
    this.#onClose = () => this.#lost();
  }

  get active() {
    return !this.#closed;
  }

  register(unit, methods) {
    const handlers = this.#units.get(unit) ?? new Map();
    const names = Object.keys(methods);
    for (let i = 0; i < names.length; i++) {
      handlers.set(names[i], methods[names[i]]);
    }
    this.#units.set(unit, handlers);
  }

  open() {
    if (!this.#closed) return;
    this.#closed = false;
    this.#port.addEventListener('message', this.#onMessage);
    this.#port.addEventListener('close', this.#onClose);
    this.#port.start?.();
  }

  call(unit, name, args, options = {}) {
    if (this.#closed) return Promise.reject(new Error('Link closed'));
    const id = String(++this.#sequence);
    const method = `${unit}/${name}`;
    const timeout = options.timeout || this.#callTimeout;
    const promise = this.#expect(id, timeout);
    try {
      this.#port.postMessage({ type: 'call', id, method, args });
    } catch (error) {
      this.#settle(id)?.reject(error);
    }
    return promise;
  }

  // Kept apart from call so the pending timer does not retain args
  #expect(id, timeout) {
    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        this.#calls.delete(id);
        reject(new Error('Request timeout'));
      };
      const timer = setTimeout(onTimeout, timeout);
      this.#calls.set(id, { resolve, reject, timer });
    });
  }

  #settle(id) {
    const pending = this.#calls.get(id);
    if (!pending) return null;
    this.#calls.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  send(unit, event, data) {
    if (this.#closed) return;
    const name = `${unit}/${event}`;
    this.#port.postMessage({ type: 'event', name, data });
  }

  subscribe(unit, event, handler) {
    const name = `${unit}/${event}`;
    const found = this.#subscribers.get(name);
    const handlers = found ?? [];
    if (handlers.includes(handler)) return;
    handlers.push(handler);
    if (!found) this.#subscribers.set(name, handlers);
  }

  unsubscribe(unit, event, handler) {
    const name = `${unit}/${event}`;
    const handlers = this.#subscribers.get(name);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index === -1) return;
    handlers.splice(index, 1);
    if (handlers.length === 0) this.#subscribers.delete(name);
  }

  close() {
    if (this.#closed) return;
    this.#shutdown();
    this.#port.close?.();
  }

  #shutdown() {
    this.#closed = true;
    this.#port.removeEventListener('message', this.#onMessage);
    this.#port.removeEventListener('close', this.#onClose);
    const pending = new Array(this.#calls.size).fill('');
    let index = 0;
    for (const id of this.#calls.keys()) {
      pending[index] = id;
      index += 1;
    }
    for (let i = 0; i < pending.length; i++) {
      this.#settle(pending[i]).reject(new Error('Link closed'));
    }
    this.#subscribers.clear();
    this.#peer.emit('close');
  }

  #lost() {
    if (!this.#closed) this.#shutdown();
  }

  #receive(data) {
    if (this.#closed || typeof data !== 'object' || data === null) return;
    const { type } = data;
    if (type === 'call') this.#serve(data);
    else if (type === 'callback') this.#settleCall(data);
    else if (type === 'event') this.#publish(data);
  }

  #settleCall(packet) {
    const pending = this.#settle(packet.id);
    if (!pending) return;
    if (packet.error) pending.reject(new MetacomError(packet.error));
    else pending.resolve(packet.result);
  }

  #publish(packet) {
    const handlers = this.#subscribers.get(packet.name);
    if (!handlers) return;
    const snapshot = handlers.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const handler = snapshot[i];
      try {
        handler(packet.data);
      } catch (error) {
        emitError(this.#peer, error);
      }
    }
  }

  async #serve(packet) {
    const { id, method, args } = packet;
    const route = typeof method === 'string' ? parseMethod(method) : {};
    const handlers = this.#units.get(route.unit);
    const handler = handlers ? handlers.get(route.name) : undefined;
    if (!handler) return void this.#reply({ id, error: PORT_NOT_FOUND });
    try {
      const context = { peer: this.#peer };
      const result = await handler(args, context);
      if (result instanceof Error) {
        return void this.#reply({ id, error: encodeFailure(result) });
      }
      this.#reply({ id, result });
    } catch (error) {
      this.#reply({ id, error: encodeFailure(error) });
    }
  }

  #reply(fields) {
    if (this.#closed) return;
    try {
      this.#port.postMessage({ type: 'callback', ...fields });
    } catch (error) {
      const failure = encodeFailure(error);
      this.#port.postMessage({
        type: 'callback',
        id: fields.id,
        error: failure,
      });
    }
  }
}

class MetacomPeer extends Emitter {
  #router;
  #options;
  #sessions = new Map();
  #closed = true;
  #link = null;

  constructor(options) {
    super();
    this.#options = options;
    if (options.port) {
      this.#link = new PortLink(this, options);
      return;
    }
    this.#router = new MetacomRouter({ ...options, localStreams: true });
    this.#router.on('error', (error) => this.#report(error));
  }

  get active() {
    if (this.#link) return this.#link.active;
    for (const session of this.#sessions.values()) {
      if (session.transport.active) return true;
    }
    return false;
  }

  register(unit, methods) {
    if (this.#link) return void this.#link.register(unit, methods);
    this.#router.register(unit, methods);
  }

  call(unit, name, args, options) {
    if (!this.#link) return Promise.reject(new Error('Port mode only'));
    return this.#link.call(unit, name, args, options);
  }

  send(unit, event, data) {
    this.#link?.send(unit, event, data);
  }

  subscribe(unit, event, handler) {
    this.#link?.subscribe(unit, event, handler);
  }

  unsubscribe(unit, event, handler) {
    this.#link?.unsubscribe(unit, event, handler);
  }

  broadcast(name, data) {
    if (this.#link) return;
    this.#router.broadcast(name, data);
  }

  open() {
    if (this.#link) {
      this.#link.open();
      return Promise.resolve();
    }
    if (!this.#closed) return Promise.resolve();
    const peers = Array.isArray(this.#options.rtc)
      ? this.#options.rtc
      : [this.#options.rtc];
    const ids = new Set();
    for (let i = 0; i < peers.length; i++) {
      const rtc = peers[i];
      if (!rtc || ids.has(rtc.peerId)) {
        return Promise.reject(new Error('Unique RTC peers required'));
      }
      ids.add(rtc.peerId);
    }
    this.#closed = false;
    for (let i = 0; i < peers.length; i++) {
      const rtc = peers[i];
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
        const onMessage = (data) => listener({ data });
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
    emitError(this, error);
  }

  close() {
    if (this.#link) return void this.#link.close();
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
