'use strict';

const { split } = require('metautil');

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

// Emitter throws on error event without listeners
const emitError = (emitter, error) => {
  if (emitter.listenerCount('error') > 0) emitter.emit('error', error);
};

module.exports = { startInterval, parseMethod, emitError };
