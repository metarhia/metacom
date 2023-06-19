'use strict';

const serializer = {
  call: ({ id, unit, version, name, args, meta }) => ({
    type: 'call',
    id,
    method: `${unit}${version ? `.${version}` : ''}/${name}`,
    args,
    meta,
  }),
  callback: ({ id, result, meta }) => ({
    type: 'callback',
    id,
    result,
    meta,
  }),
  event: ({ unit, eventName, data, meta }) => ({
    type: 'event',
    name: `${unit}/${eventName}`,
    data,
    meta,
  }),
  stream: ({ id, name, size, status }) => ({
    type: 'stream',
    id,
    name,
    size,
    status,
  }),
  error: ({ id, message, code }) => ({
    type: 'callback',
    id,
    error: { message, code },
  }),
};

const serialize = (type, data) => serializer[type]?.(data) ?? null;

const deserializer = {
  call: ({ id, method, args, meta }) => {
    const [service, name] = method?.split('/') ?? [];
    const [unit, version] = service?.split('.') ?? [];
    return {
      id,
      unit,
      version: version && parseInt(version),
      name,
      args,
      meta,
    };
  },
  callback: ({ id, result, meta }) => ({
    id,
    result,
    meta,
  }),
  event: ({ name, data, meta }) => {
    const [unit, eventName] = name.split('/') ?? [];
    return { unit, eventName, data, meta };
  },
  stream: ({ id, name, size, status }) => ({
    id,
    name,
    size,
    status,
  }),
  error: ({ id, error }) => ({
    callId: id,
    message: error?.message,
    code: error?.code,
  }),
};

const deserialize = (packet) => {
  const type = packet.error ? 'error' : packet.type;
  if (!type) return null;
  const data = deserializer[type](packet);
  return { type, data };
};

module.exports = {
  serialize,
  deserialize,
  serializer,
  deserializer,
};
