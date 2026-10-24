'use strict';

const adapters = new Map();

const registerTransport = (name, adapter) => {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('Transport name must be a non-empty string');
  }
  if (typeof adapter.Client !== 'function') {
    throw new TypeError(`Transport '${name}': Client must be a constructor`);
  }
  if (typeof adapter.Server !== 'function') {
    throw new TypeError(`Transport '${name}': Server must be a constructor`);
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== 'object') {
    throw new TypeError(`Transport '${name}': capabilities must be an object`);
  }
  adapters.set(name, adapter);
};

const getTransport = (name) => {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unknown transport: '${name}'`);
  return adapter;
};

const allTransports = () => adapters.entries();

module.exports = { registerTransport, getTransport, allTransports };
