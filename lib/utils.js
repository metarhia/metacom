'use strict';

const { split } = require('metautil');

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

module.exports = { startInterval, parseMethod, encodeEvent, emitError };
