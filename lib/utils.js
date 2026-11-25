'use strict';

const { split } = require('metautil');

const CALL_TIMEOUT_MS = 7 * 1000;
const RECONNECT_TIMEOUT_MS = 2 * 1000;
const SERVICE_UNAVAILABLE = { message: 'Service Unavailable', code: 503 };
const TEXT_ENCODER = new TextEncoder();

// Frozen data does not change: its event packet is serialized once
// and reused for every client the event goes to
const FROZEN_EVENTS = new WeakMap();

// Timer does not keep Node.js process alive, browsers have no unref
const startInterval = (listener, interval) => {
  const timer = setInterval(listener, interval);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

// Method format: unit/name or unit.version/name, version defaults to '*'
const parseMethod = (method) => {
  const route = split(method, '/');
  const target = split(route[0], '.');
  const version = target[1] || '*';
  return { unit: target[0], version, name: route[1] };
};

const encodeEvent = (name, data) => {
  const isObject = typeof data === 'object' && data !== null;
  const isFrozen = isObject && Object.isFrozen(data);
  const cached = isFrozen ? FROZEN_EVENTS.get(data) : undefined;
  if (cached?.name === name) return cached.packet;
  const packet = JSON.stringify({ type: 'event', name, data });
  if (isFrozen) FROZEN_EVENTS.set(data, { name, packet });
  return packet;
};

// Emitter throws on error event without listeners
const emitError = (emitter, error) => {
  if (emitter.listenerCount('error') > 0) emitter.emit('error', error);
};

const isId = (value) => typeof value === 'string' && value !== '';

// Units map: unit name to Map of method handlers, later methods win
const registerUnit = (units, unit, methods) => {
  const handlers = units.get(unit) ?? new Map();
  const names = Object.keys(methods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    handlers.set(name, methods[name]);
  }
  units.set(unit, handlers);
};

// Kept apart from the caller so the pending timer does not retain args
const expectCall = (calls, id, timeoutMs) =>
  new Promise((resolve, reject) => {
    const onTimeout = () => {
      calls.delete(id);
      reject(new Error('Request timeout'));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    calls.set(id, { resolve, reject, timer });
  });

const takeCall = (calls, id) => {
  const pending = calls.get(id);
  if (!pending) return null;
  calls.delete(id);
  clearTimeout(pending.timer);
  return pending;
};

// Writers waiting for a send queue to flush
class Waiters {
  #list = [];

  wait() {
    return new Promise((resolve) => {
      this.#list.push(resolve);
    });
  }

  release() {
    const list = this.#list;
    this.#list = [];
    for (let i = 0; i < list.length; i++) list[i]();
  }
}

module.exports = {
  CALL_TIMEOUT_MS,
  RECONNECT_TIMEOUT_MS,
  SERVICE_UNAVAILABLE,
  TEXT_ENCODER,
  startInterval,
  parseMethod,
  encodeEvent,
  emitError,
  isId,
  registerUnit,
  expectCall,
  takeCall,
  Waiters,
};
