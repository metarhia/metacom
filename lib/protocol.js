'use strict';

const serializer = {
  call: ({ callId, iface, ver, method, data, meta }) => ({
    type: 'call',
    id: callId,
    method: `${iface}${ver ? `.${ver}` : ''}/${method}`,
    args: data,
    meta,
  }),
  callback: ({ callId, data, meta }) => ({
    type: 'callback',
    id: callId,
    result: data,
    meta,
  }),
  event: ({ iface, eventName, data, meta }) => ({
    type: 'event',
    name: `${iface}/${eventName}`,
    data,
    meta,
  }),
  stream: ({ streamId, name, size, status }) => ({
    type: 'stream',
    id: streamId,
    name,
    size,
    status,
  }),
  error: ({ callId, message, code }) => ({
    type: 'callback',
    id: callId,
    error: { message, code },
  }),
};

const serialize = (type, data) => serializer[type]?.(data) ?? null;

const deserializer = {
  call: ({ id, method: target, args, meta }) => {
    const [service, method] = target?.split('/') ?? [];
    const [iface, ver] = service?.split('.') ?? [];
    return {
      callId: id,
      iface,
      method,
      ver: ver && parseInt(ver),
      args,
      meta,
    };
  },
  callback: ({ id, result, meta }) => ({
    callId: id,
    data: result,
    meta,
  }),
  event: ({ name, data, meta }) => {
    const [iface, eventName] = name.split('/') ?? [];
    return { iface, eventName, data, meta };
  },
  stream: ({ id, name, size, status }) => ({
    streamId: id,
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
