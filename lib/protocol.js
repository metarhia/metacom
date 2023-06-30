'use strict';

const serializer = {
  call: ({ id, unit, version, name, args, meta }) => {
    const type = 'call';
    const ver = version ? `.${version}` : '';
    const method = `${unit}${ver}/${name}`;
    return { type, id, method, args, meta };
  },
  callback: ({ id, result, meta }) => {
    const type = 'callback';
    return { type, id, result, meta };
  },
  event: ({ unit, name, data, meta }) => {
    const type = 'event';
    const eventName = `${unit}/${name}`;
    return { type, name: eventName, data, meta };
  },
  stream: ({ id, name, size, status }) => {
    const type = 'stream';
    return { type, id, name, size, status };
  },
  error: ({ id, message, code }) => {
    const type = 'callback';
    return { type, id, error: { message, code } };
  },
};

const serialize = (type, data) => serializer[type]?.(data) ?? null;

const deserializer = {
  call: ({ id, method, args, meta }) => {
    const [service, name] = method?.split('/') ?? [];
    const [unit, version] = service?.split('.') ?? [];
    const ver = version && parseInt(version, 10);
    return { id, unit, version: ver, name, args, meta };
  },
  callback: ({ id, result, meta }) => ({ id, result, meta }),
  event: ({ name, data, meta }) => {
    const [unit, eventName] = name.split('/') ?? [];
    return { unit, name: eventName, data, meta };
  },
  stream: ({ id, name, size, status }) => ({ id, name, size, status }),
  error: ({ id, error }) => {
    const { message, code } = error || {};
    return { id, message, code };
  },
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
