'use strict';

const { Emitter } = require('metautil');

const { ClientRtcTransport } = require('./client.js');
const { emitError, parseMethod, registerUnit } = require('./utils.js');
const { expectCall, takeCall } = require('./utils.js');
const { CALL_TIMEOUT_MS, RECONNECT_TIMEOUT_MS } = require('./utils.js');
const { MetacomError } = require('./metacom.js');
const { MetacomRouter } = require('./router.js');

const PORT_NOT_FOUND = { message: 'Not Found', code: 404 };

const encodeFailure = (error) => {
  const message = error?.message ?? `${error}`;
  const code = error?.code;
  const isCode = typeof code === 'number' || typeof code === 'string';
  return { message, code: isCode ? code : 500 };
};

const failurePacket = (id, error) => {
  const failure = encodeFailure(error);
  return { type: 'callback', id, error: failure };
};

// Peer modes share one surface, each overrides what it supports
class PeerMode {
  // eslint-disable-next-line class-methods-use-this
  call() {
    return Promise.reject(new Error('Port mode only'));
  }

  // eslint-disable-next-line class-methods-use-this
  send() {}

  // eslint-disable-next-line class-methods-use-this
  subscribe() {}

  // eslint-disable-next-line class-methods-use-this
  unsubscribe() {}

  // eslint-disable-next-line class-methods-use-this
  broadcast() {}
}

// Symmetric link on one MessagePort: packets are posted as objects,
// so structured clone keeps Date, Map, Set, undefined, and typed arrays
class PortLink extends PeerMode {
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
    super();
    this.#peer = peer;
    this.#port = options.port;
    this.#callTimeout = options.callTimeout || CALL_TIMEOUT_MS;
    this.#onMessage = (event) => this.#receive(event.data);
    this.#onClose = () => this.#lost();
  }

  get active() {
    return !this.#closed;
  }

  register(unit, methods) {
    registerUnit(this.#units, unit, methods);
  }

  async open() {
    if (!this.#closed) return;
    this.#closed = false;
    this.#port.addEventListener('message', this.#onMessage);
    this.#port.addEventListener('close', this.#onClose);
    this.#port.start?.();
  }

  call(unit, name, args, options = {}) {
    if (this.#closed) return Promise.reject(new Error('Link closed'));
    const id = `${++this.#sequence}`;
    const method = `${unit}/${name}`;
    const timeout = options.timeout || this.#callTimeout;
    const promise = expectCall(this.#calls, id, timeout);
    try {
      this.#port.postMessage({ type: 'call', id, method, args });
    } catch (error) {
      takeCall(this.#calls, id)?.reject(error);
    }
    return promise;
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
    for (const pending of this.#calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Link closed'));
    }
    this.#calls.clear();
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
    const pending = takeCall(this.#calls, packet.id);
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
    const handler = this.#units.get(route.unit)?.get(route.name);
    if (!handler) {
      const notFound = { type: 'callback', id, error: PORT_NOT_FOUND };
      return void this.#reply(notFound);
    }
    try {
      const context = { peer: this.#peer };
      const result = await handler(args, context);
      const isFailure = result instanceof Error;
      if (isFailure) return void this.#reply(failurePacket(id, result));
      this.#reply({ type: 'callback', id, result });
    } catch (error) {
      this.#reply(failurePacket(id, error));
    }
  }

  // Result structured clone can not copy is reported as a failure
  #reply(packet) {
    if (this.#closed) return;
    try {
      this.#port.postMessage(packet);
    } catch (error) {
      this.#port.postMessage(failurePacket(packet.id, error));
    }
  }
}

// Answering RTC peers attached to one router, like tabs to a proxy
class RtcHost extends PeerMode {
  #peer;
  #options;
  #router;
  #reconnectTimeout;
  #sessions = new Map();
  #closed = true;

  constructor(peer, options) {
    super();
    this.#peer = peer;
    this.#options = options;
    this.#reconnectTimeout = options.reconnectTimeout ?? RECONNECT_TIMEOUT_MS;
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

  async open() {
    if (!this.#closed) return;
    const { rtc } = this.#options;
    const peers = Array.isArray(rtc) ? rtc : [rtc];
    const ids = new Set();
    for (let i = 0; i < peers.length; i++) {
      const target = peers[i];
      if (!target || ids.has(target.peerId)) {
        throw new Error('Unique RTC peers required');
      }
      ids.add(target.peerId);
    }
    this.#closed = false;
    for (let i = 0; i < peers.length; i++) {
      this.#connect(peers[i]).catch((error) => this.#report(error));
    }
  }

  async #connect(rtc) {
    const transport = new ClientRtcTransport(rtc.peerId);
    const session = { transport, timer: null, rtc };
    const messageListeners = new Set();
    this.#sessions.set(rtc.peerId, session);
    const port = {
      postMessage: (data) => transport.write(data),
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
    const reconnect = () => {
      session.timer = null;
      transport.open({ rtc }).catch((error) => this.#report(error));
    };
    transport.on('open', () => {
      this.#router.attach(port, { id: rtc.peerId });
      this.#peer.emit('connect', rtc.peerId);
    });
    transport.on('close', () => {
      this.#router.detach(rtc.peerId);
      if (this.#closed || session.timer) return;
      session.timer = setTimeout(reconnect, this.#reconnectTimeout);
      this.#peer.emit('disconnect', rtc.peerId);
    });
    await transport.open({ rtc });
  }

  #report(error) {
    emitError(this.#peer, error);
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

class MetacomPeer extends Emitter {
  #mode = null;

  constructor(options) {
    super();
    const Mode = options.port ? PortLink : RtcHost;
    this.#mode = new Mode(this, options);
  }

  get active() {
    return this.#mode.active;
  }

  register(unit, methods) {
    this.#mode.register(unit, methods);
  }

  call(unit, name, args, options) {
    return this.#mode.call(unit, name, args, options);
  }

  send(unit, event, data) {
    this.#mode.send(unit, event, data);
  }

  subscribe(unit, event, handler) {
    this.#mode.subscribe(unit, event, handler);
  }

  unsubscribe(unit, event, handler) {
    this.#mode.unsubscribe(unit, event, handler);
  }

  broadcast(name, data) {
    this.#mode.broadcast(name, data);
  }

  open() {
    return this.#mode.open();
  }

  close() {
    this.#mode.close();
  }
}

module.exports = { MetacomPeer };
