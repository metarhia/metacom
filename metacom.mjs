import { split, Emitter, generateUUID, delay, jsonParse } from './metautil.js';

// utils.js

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

// rtc.js

const RTC_PROTOCOL = 'metacom:rtc';
const RTC_VERSION = 1;
const RTC_TIMEOUT_MS = 10000;
const RTC_MAX_CANDIDATES = 256;
const RTC_RETIRED_LIMIT = 256;
const SDP_MID = 'a=mid:';

// Finished generations are ignored, the oldest is forgotten over the limit
const retireRtcGeneration = (retired, generation) => {
  retired.add(generation);
  if (retired.size <= RTC_RETIRED_LIMIT) return;
  retired.delete(retired.values().next().value);
};

const mediaError = () => {
  throw new Error('Invalid RTC media');
};

const sdpKinds = (sdp) => {
  const kinds = new Map();
  let section = '';
  const lines = sdp.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('m=')) {
      const header = line.slice(2);
      const space = header.indexOf(' ');
      section = space === -1 ? header : header.slice(0, space);
    } else if (section && line.startsWith(SDP_MID)) {
      const mid = line.slice(SDP_MID.length);
      kinds.set(mid, section);
      section = '';
    }
  }
  return kinds;
};

const kindBySlot = (media) => {
  const kinds = new Map();
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    kinds.set(item.slot, item.kind);
  }
  return kinds;
};

const assertRtcMedia = (media, offered, sdp) => {
  const missing = offered === undefined || offered === null;
  if (!media.length && missing) return;
  const record = !missing && typeof offered === 'object';
  const list = Array.isArray(offered);
  if (!media.length || !record || list) mediaError();
  const mids = Object.keys(offered);
  if (mids.length !== media.length) mediaError();
  const local = kindBySlot(media);
  const remote = sdpKinds(sdp);
  const seen = new Set();
  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    const slot = offered[mid];
    const expected = local.get(slot);
    const duplicate = seen.has(slot);
    const matched = remote.get(mid) === expected;
    if (!expected || duplicate || !matched) mediaError();
    seen.add(slot);
  }
};

const readMediaOffer = (attempt, offered, sdp) => {
  assertRtcMedia(attempt.media, offered, sdp);
  if (!offered) return;
  const mids = Object.keys(offered);
  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    attempt.slots.set(mid, offered[mid]);
  }
};

const preferredCodecs = (kind, codecs) => {
  const names = codecs?.[kind];
  if (!names?.length) return null;
  const factory = globalThis.RTCRtpSender;
  const capabilities = factory?.getCapabilities?.(kind);
  const available = capabilities?.codecs;
  if (!available?.length) return null;
  const selected = [];
  for (let i = 0; i < names.length; i++) {
    const mime = names[i];
    for (let j = 0; j < available.length; j++) {
      const codec = available[j];
      if (codec.mimeType === mime) selected.push(codec);
    }
  }
  return selected.length ? selected : null;
};

const applyCodecs = (transceiver, kind, codecs) => {
  if (typeof transceiver.setCodecPreferences !== 'function') return;
  const selected = preferredCodecs(kind, codecs);
  if (!selected) return;
  transceiver.setCodecPreferences(selected);
};

// One negotiation generation owns all its listeners and asynchronous work.
class RtcConnection extends Emitter {
  #attempt = null;
  #retired = new Set();
  #tracks = new Map();

  get peerConnection() {
    return this.#attempt?.pc ?? null;
  }

  async setTrack(slot, track) {
    this.#tracks.set(slot, track);
    const sender = this.#attempt?.senders.get(slot);
    if (sender) await sender.replaceTrack(track);
  }

  sender(slot) {
    return this.#attempt?.senders.get(slot) ?? null;
  }

  receiver(slot) {
    return this.#attempt?.receivers.get(slot) ?? null;
  }

  open(options) {
    if (this.#attempt) return this.#attempt.promise;
    const { RTCPeerConnection: PeerConnection } = globalThis;
    if (!PeerConnection) {
      return Promise.reject(new Error('WebRTC is unavailable in this context'));
    }
    const { localId, peerId, role, signaling } = options ?? {};
    const validRole = role === 'offerer' || role === 'answerer';
    if (!localId || !peerId || localId === peerId || !validRole) {
      return Promise.reject(new TypeError('Invalid RTC peer identity or role'));
    }
    if (!signaling?.send || !signaling?.subscribe) {
      return Promise.reject(new TypeError('RTC signaling adapter is required'));
    }
    const pc = new PeerConnection(options.configuration);
    const media = options.media ?? [];
    const codecs = options.codecs ?? null;
    const attempt = {
      pc,
      options,
      channel: null,
      listeners: [],
      candidates: [],
      generation: role === 'offerer' ? generateUUID() : null,
      remote: false,
      description: false,
      ready: false,
      unsubscribe: null,
      timer: null,
      serial: Promise.resolve(),
      media,
      codecs,
      slots: new Map(),
      senders: new Map(),
      receivers: new Map(),
    };
    attempt.promise = new Promise((resolve, reject) => {
      attempt.resolve = resolve;
      attempt.reject = reject;
    });
    this.#attempt = attempt;
    const fail = (error) => this.#finish(attempt, error);
    const listen = (target, name, handler) => {
      target.addEventListener(name, handler);
      attempt.listeners.push(() => target.removeEventListener(name, handler));
    };
    attempt.listen = listen;
    listen(pc, 'icecandidate', ({ candidate }) => {
      if (!candidate || !attempt.generation) return;
      const value = candidate.toJSON ? candidate.toJSON() : candidate;
      this.#send(attempt, { candidate: value }).catch(fail);
    });
    const onState = () => {
      const states = [pc.connectionState, pc.iceConnectionState];
      if (states.includes('failed') || states.includes('closed')) {
        fail(new Error('RTC connection failed'));
      }
    };
    listen(pc, 'connectionstatechange', onState);
    listen(pc, 'iceconnectionstatechange', onState);
    listen(pc, 'datachannel', ({ channel }) => {
      if (role !== 'answerer' || attempt.channel) {
        channel.close();
        return void fail(new Error('Unexpected RTC data channel'));
      }
      this.#channel(attempt, channel);
    });
    listen(pc, 'track', (event) => {
      const mid = event.transceiver?.mid;
      if (typeof mid !== 'string' || !mid) return;
      const slot = attempt.slots.get(mid);
      if (!slot) return;
      const { track } = event;
      this.emit('track', { slot, track });
    });
    try {
      attempt.unsubscribe = signaling.subscribe((message) => {
        attempt.serial = attempt.serial
          .then(() => this.#receive(attempt, message))
          .catch(fail);
      });
      if (typeof attempt.unsubscribe !== 'function') {
        throw new TypeError(
          'RTC subscribe must return an unsubscribe function',
        );
      }
      attempt.timer = setTimeout(() => {
        fail(new Error('RTC handshake timeout'));
      }, options.handshakeTimeout ?? RTC_TIMEOUT_MS);
      if (role === 'offerer') {
        this.#channel(
          attempt,
          pc.createDataChannel('metacom', { ordered: true }),
        );
        const slots = attempt.media;
        for (let i = 0; i < slots.length; i++) {
          const kind = slots[i].kind;
          const transceiver = pc.addTransceiver(kind, {
            direction: 'sendrecv',
          });
          applyCodecs(transceiver, kind, attempt.codecs);
        }
        const createOffer = () => pc.createOffer();
        this.#describe(attempt, createOffer).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
    return attempt.promise;
  }

  async #send(attempt, body) {
    if (this.#attempt !== attempt) return;
    const { localId: source, peerId: target, signaling } = attempt.options;
    const { generation } = attempt;
    const protocol = RTC_PROTOCOL;
    const version = RTC_VERSION;
    const envelope = { protocol, version, source, target, generation };
    await signaling.send({ ...envelope, ...body });
  }

  async #applyTrack(sender, slot) {
    const track = this.#tracks.get(slot);
    if (track) await sender.replaceTrack(track);
  }

  async #offerMedia(attempt) {
    const transceivers = attempt.pc.getTransceivers();
    const slots = attempt.media;
    const named = {};
    for (let i = 0; i < slots.length; i++) {
      const transceiver = transceivers[i];
      const { mid, sender, receiver } = transceiver;
      const slot = slots[i].slot;
      named[mid] = slot;
      attempt.slots.set(mid, slot);
      attempt.senders.set(slot, sender);
      attempt.receivers.set(slot, receiver);
      await this.#applyTrack(sender, slot);
    }
    return named;
  }

  async #answerMedia(attempt) {
    const transceivers = attempt.pc.getTransceivers();
    const kinds = kindBySlot(attempt.media);
    for (let i = 0; i < transceivers.length; i++) {
      const transceiver = transceivers[i];
      const slot = attempt.slots.get(transceiver.mid);
      if (!slot) continue;
      const kind = kinds.get(slot);
      transceiver.direction = 'sendrecv';
      applyCodecs(transceiver, kind, attempt.codecs);
      attempt.senders.set(slot, transceiver.sender);
      attempt.receivers.set(slot, transceiver.receiver);
      await this.#applyTrack(transceiver.sender, slot);
    }
  }

  // Offer or answer: the peer gets only type and sdp of local description
  async #describe(attempt, create) {
    const description = await create();
    if (this.#attempt !== attempt) return;
    const { pc } = attempt;
    await pc.setLocalDescription(description);
    if (this.#attempt !== attempt) return;
    const { type, sdp } = pc.localDescription;
    const message = { description: { type, sdp } };
    if (type === 'offer' && attempt.media.length) {
      message.media = await this.#offerMedia(attempt);
      if (this.#attempt !== attempt) return;
    }
    await this.#send(attempt, message);
  }

  async #receive(attempt, message) {
    if (this.#attempt !== attempt || !message) return;
    const { protocol, version, source, target, generation } = message;
    const { localId, peerId, role } = attempt.options;
    if (protocol !== RTC_PROTOCOL || source !== peerId || target !== localId) {
      return;
    }
    if (
      version !== RTC_VERSION ||
      typeof generation !== 'string' ||
      !generation
    ) {
      throw new Error('Invalid RTC signaling envelope');
    }
    if (this.#retired.has(generation)) return;
    if (attempt.generation && attempt.generation !== generation) return;
    const { description, candidate } = message;
    if (!!description === (candidate !== undefined)) {
      throw new Error('Invalid RTC signaling payload');
    }
    if (description) {
      const type = role === 'answerer' ? 'offer' : 'answer';
      if (description.type !== type || typeof description.sdp !== 'string') {
        throw new Error('Invalid RTC description');
      }
      if (attempt.description) return;
      attempt.description = true;
      attempt.generation = generation;
      if (role === 'answerer') {
        readMediaOffer(attempt, message.media, description.sdp);
      }
      await attempt.pc.setRemoteDescription(description);
      if (this.#attempt !== attempt) return;
      attempt.remote = true;
      for (const item of attempt.candidates) {
        await attempt.pc.addIceCandidate(item);
      }
      attempt.candidates = [];
      if (role === 'answerer') {
        if (attempt.media.length) await this.#answerMedia(attempt);
        if (this.#attempt !== attempt) return;
        const createAnswer = () => attempt.pc.createAnswer();
        await this.#describe(attempt, createAnswer);
      }
      return;
    }
    if (!candidate || typeof candidate.candidate !== 'string') {
      throw new Error('Invalid RTC ICE candidate');
    }
    if (!attempt.generation) attempt.generation = generation;
    if (attempt.remote) {
      await attempt.pc.addIceCandidate(candidate);
    } else {
      if (attempt.candidates.length >= RTC_MAX_CANDIDATES) {
        throw new Error('RTC ICE candidate limit exceeded');
      }
      attempt.candidates.push(candidate);
    }
  }

  #channel(attempt, channel) {
    const unreliable =
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null ||
      !channel.ordered;
    if (unreliable || channel.label !== 'metacom') {
      channel.close();
      return void this.#finish(
        attempt,
        new Error('Reliable ordered RTC channel required'),
      );
    }
    attempt.channel = channel;
    channel.binaryType = 'arraybuffer';
    const ready = () => {
      if (this.#attempt !== attempt || attempt.ready) return;
      attempt.ready = true;
      clearTimeout(attempt.timer);
      attempt.resolve(channel);
    };
    attempt.listen(channel, 'open', ready);
    attempt.listen(channel, 'close', () => {
      this.#finish(attempt, new Error('RTC channel closed'));
    });
    attempt.listen(channel, 'error', () => {
      this.#finish(attempt, new Error('RTC channel error'));
    });
    if (channel.readyState === 'open') ready();
  }

  #finish(attempt, error) {
    if (this.#attempt !== attempt) return;
    this.#attempt = null;
    clearTimeout(attempt.timer);
    for (const remove of attempt.listeners) remove();
    if (typeof attempt.unsubscribe === 'function') attempt.unsubscribe();
    if (attempt.generation) {
      retireRtcGeneration(this.#retired, attempt.generation);
    }
    attempt.candidates = [];
    attempt.channel?.close();
    attempt.pc.close();
    if (!attempt.ready) attempt.reject(error);
    this.emit('close', error);
  }

  close() {
    if (this.#attempt) {
      this.#finish(this.#attempt, new Error('RTC connection closed'));
    }
  }
}

// rtc-channel.js

const RTC_HEADER_BYTES = 16;
const RTC_FRAME_BYTES = 16384;
const RTC_MESSAGE_BYTES = 16 * 1024 * 1024;
const RTC_QUEUE_BYTES = 32 * 1024 * 1024;
const RTC_HIGH_WATER_BYTES = 256 * 1024;
const RTC_FRAGMENT_LIMIT = 4096;
const RTC_ENCODER = new TextEncoder();
const RTC_DECODER = new TextDecoder('utf-8', { fatal: true });

const rtcBytes = (data) => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('RTC data must be text or binary');
};

const rtcPositive = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Invalid RTC ${name}`);
  }
  return value;
};

// Binary envelopes preserve message boundaries across fragmentation.
class RtcChannelEndpoint extends Emitter {
  #channel;
  #options;
  #queue = [];
  #bytes = 0;
  #sequence = 0;
  #received = 0;
  #assembly = null;
  #waiters = [];
  #listeners = [];
  closed = false;

  constructor(channel, options = {}) {
    super();
    const messageBytes = options.maxMessageBytes ?? RTC_MESSAGE_BYTES;
    const queueBytes = options.maxQueueBytes ?? RTC_QUEUE_BYTES;
    const highWater = options.highWaterBytes ?? RTC_HIGH_WATER_BYTES;
    const fragments = options.maxFragments ?? RTC_FRAGMENT_LIMIT;
    const timeout = options.assemblyTimeout ?? 10000;
    const negotiated = options.maxMessageSize || RTC_FRAME_BYTES;
    const frameBytes = Math.min(negotiated, RTC_FRAME_BYTES);
    const limits = {
      messageBytes,
      queueBytes,
      highWater,
      fragments,
      timeout,
      frameBytes,
    };
    const names = Object.keys(limits);
    for (let i = 0; i < names.length; i++) {
      rtcPositive(limits[names[i]], names[i]);
    }
    if (frameBytes <= RTC_HEADER_BYTES || frameBytes > highWater) {
      throw new RangeError('RTC frame size exceeds buffer or header limit');
    }
    this.#channel = channel;
    this.#options = limits;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = Math.min(
      Math.floor(highWater / 2),
      highWater - frameBytes,
    );
    const listen = (name, listener) => {
      channel.addEventListener(name, listener);
      this.#listeners.push(() => channel.removeEventListener(name, listener));
    };
    listen('bufferedamountlow', () => this.#flush());
    listen('close', () => this.close(new Error('RTC channel closed')));
    listen('error', () => this.close(new Error('RTC channel error')));
    listen('message', ({ data }) => {
      try {
        this.#receive(data);
      } catch (error) {
        this.close(error);
      }
    });
  }

  write(data) {
    if (this.closed || this.#channel.readyState !== 'open') {
      throw new Error('RTC channel is not connected');
    }
    const isText = typeof data === 'string';
    const payload = isText ? RTC_ENCODER.encode(data) : rtcBytes(data);
    const { messageBytes, fragments, frameBytes, queueBytes } = this.#options;
    const capacity = frameBytes - RTC_HEADER_BYTES;
    const count = Math.max(1, Math.ceil(payload.length / capacity));
    const size = payload.length + count * RTC_HEADER_BYTES;
    if (payload.length > messageBytes || count > fragments) {
      throw new RangeError('RTC message limit exceeded');
    }
    if (this.#bytes + size > queueBytes) {
      throw new RangeError('RTC send queue overflow');
    }
    this.#sequence = (this.#sequence % 0xffffffff) + 1;
    const id = this.#sequence;
    for (let index = 0; index < count; index++) {
      const offset = index * capacity;
      const part = payload.subarray(offset, offset + capacity);
      const frame = new Uint8Array(RTC_HEADER_BYTES + part.length);
      const header = new DataView(frame.buffer);
      frame.set([0x4d, 0x43, 1, isText ? 0 : 1]);
      header.setUint32(4, id);
      header.setUint32(8, payload.length);
      header.setUint32(12, offset);
      frame.set(part, RTC_HEADER_BYTES);
      this.#queue.push(frame);
    }
    this.#bytes += size;
    this.#flush();
    if (this.closed) throw new Error('RTC send failed');
    return this.#writable();
  }

  #writable() {
    return (
      this.#queue.length === 0 &&
      this.#channel.bufferedAmount < this.#options.highWater
    );
  }

  #flush() {
    if (this.closed) return;
    const { highWater } = this.#options;
    try {
      while (this.#queue.length) {
        const frame = this.#queue[0];
        if (this.#channel.bufferedAmount + frame.length > highWater) break;
        this.#channel.send(frame);
        this.#queue.shift();
        this.#bytes -= frame.length;
      }
    } catch (error) {
      return void this.close(error);
    }
    if (this.#writable()) this.#settle();
  }

  drain() {
    if (this.closed || this.#writable()) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #settle() {
    for (const resolve of this.#waiters) resolve();
    this.#waiters = [];
  }

  #receive(data) {
    if (this.closed) return;
    const frame = rtcBytes(data);
    const { messageBytes, fragments, frameBytes, timeout } = this.#options;
    if (
      frame.length < RTC_HEADER_BYTES ||
      frame.length > frameBytes ||
      frame[0] !== 0x4d ||
      frame[1] !== 0x43 ||
      frame[2] !== 1 ||
      frame[3] > 1
    ) {
      throw new Error('Invalid RTC frame');
    }
    const header = new DataView(
      frame.buffer,
      frame.byteOffset,
      RTC_HEADER_BYTES,
    );
    const id = header.getUint32(4);
    const length = header.getUint32(8);
    const offset = header.getUint32(12);
    const payload = frame.subarray(RTC_HEADER_BYTES);
    if (
      !id ||
      length > messageBytes ||
      payload.length + offset > length ||
      (length > 0 && payload.length === 0)
    ) {
      throw new Error('Invalid RTC fragment size');
    }
    let assembly = this.#assembly;
    if (!assembly) {
      const expected = (this.#received % 0xffffffff) + 1;
      if (offset !== 0 || id !== expected) {
        throw new Error('Invalid RTC message order');
      }
      const timer = setTimeout(
        () => this.close(new Error('RTC assembly timeout')),
        timeout,
      );
      assembly = {
        id,
        length,
        type: frame[3],
        data: new Uint8Array(length),
        offset: 0,
        count: 0,
        timer,
      };
      this.#assembly = assembly;
    }
    if (
      assembly.id !== id ||
      assembly.length !== length ||
      assembly.type !== frame[3] ||
      assembly.offset !== offset ||
      ++assembly.count > fragments
    ) {
      throw new Error('Invalid RTC fragment order');
    }
    assembly.data.set(payload, offset);
    assembly.offset += payload.length;
    if (assembly.offset !== length) return;
    clearTimeout(assembly.timer);
    this.#assembly = null;
    this.#received = id;
    const result =
      assembly.type === 0 ? RTC_DECODER.decode(assembly.data) : assembly.data;
    this.emit('message', result);
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    if (this.#assembly) clearTimeout(this.#assembly.timer);
    this.#assembly = null;
    this.#queue = [];
    this.#bytes = 0;
    this.#settle();
    this.#channel.close();
    this.emit('close', error);
  }
}

// client.js

const { WebSocket } = globalThis;

const PING_INTERVAL_MS = 20 * 1000;
const PONG_TIMEOUT_MS = 5 * 1000;
const HANDSHAKE_TIMEOUT_MS = 5 * 1000;
const BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_INTERVAL_MS = 10;

class ClientTransport extends Emitter {
  active = false;

  constructor(url) {
    super();
    this.url = url;
  }

  static create(url) {
    return new this(url);
  }

  send(obj) {
    this.write(JSON.stringify(obj));
  }

  // eslint-disable-next-line class-methods-use-this
  drain() {
    return Promise.resolve();
  }

  // eslint-disable-next-line class-methods-use-this
  announce() {}
  // eslint-disable-next-line class-methods-use-this
  online() {}
  // eslint-disable-next-line class-methods-use-this
  offline() {}
}

class ClientWsTransport extends ClientTransport {
  #socket = null;
  #opening = null;

  async open() {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.#socket = socket;
      const rejectOpen = () => {
        if (!this.#opening) return;
        this.#opening = null;
        this.#socket = null;
        reject(new Error('Connection closed'));
        // Node.js 22 reports a refused handshake with error and no close.
        // close() in that turn re-enters and overflows the stack.
        if (socket.readyState !== WebSocket.CONNECTING) return;
        queueMicrotask(() => {
          if (socket.readyState === WebSocket.CONNECTING) socket.close();
        });
      };
      const onClose = (event) => {
        if (this.#opening) return void rejectOpen();
        this.#socket = null;
        if (!this.active) return;
        this.active = false;
        this.emit('close', event);
      };
      const onOpen = () => {
        if (!this.#opening) return;
        this.active = true;
        this.emit('open');
        this.#opening = null;
        resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
      socket.addEventListener('message', ({ data }) => {
        this.emit('message', data);
      });
    });
    this.#opening = opening;
    return opening;
  }

  close() {
    if (!this.active) return;
    this.#socket.close();
  }

  write(data) {
    if (!this.active) throw new Error('Not connected');
    this.#socket.send(data);
    return this.#socket.bufferedAmount < BUFFER_HIGH_WATER_BYTES;
  }

  // Browser WebSocket has no drain event, bufferedAmount is polled
  async drain() {
    while (this.#isBuffered()) await delay(DRAIN_INTERVAL_MS);
  }

  #isBuffered() {
    const socket = this.#socket;
    if (!socket) return false;
    return socket.bufferedAmount >= BUFFER_HIGH_WATER_BYTES;
  }
}

class ClientHttpTransport extends ClientTransport {
  async open() {
    if (this.active) return;
    this.active = true;
    this.emit('open');
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.emit('close');
  }

  write(data) {
    this.#post(data);
  }

  // Failed request is answered with callback error to reject the call
  async #post(data) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: data };
    try {
      const response = await fetch(this.url, options);
      const type = response.headers.get('Content-Type') ?? '';
      if (type.startsWith('application/json')) {
        const packet = await response.text();
        return void this.emit('message', packet);
      }
      const message = response.statusText || 'Invalid response';
      const code = response.ok ? 502 : response.status;
      this.#reply(data, { message, code });
    } catch (error) {
      this.#reply(data, { message: error.message, code: 503 });
    }
  }

  #reply(data, error) {
    const request = jsonParse(data);
    const id = request?.id ?? '';
    const packet = { type: 'callback', id, error };
    this.emit('message', JSON.stringify(packet));
  }
}

class ClientRtcTransport extends ClientTransport {
  #connection = new RtcConnection();
  #endpoint = null;
  #opening = null;
  #cycle = 0;

  constructor(url) {
    super(url);
    this.#connection.on('close', (error) => this.#release(error));
  }

  open(options = {}) {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const cycle = ++this.#cycle;
    this.#opening = this.#connection
      .open(options.rtc)
      .then((channel) => {
        if (cycle !== this.#cycle) throw new Error('RTC connection closed');
        const maxMessageSize =
          this.#connection.peerConnection.sctp?.maxMessageSize;
        const endpoint = new RtcChannelEndpoint(channel, {
          ...options.rtc,
          maxMessageSize,
        });
        this.#endpoint = endpoint;
        endpoint.on('message', (data) => this.emit('message', data));
        endpoint.on('close', (error) => {
          this.#release(error);
          this.#connection.close();
        });
        this.active = true;
        this.emit('open');
      })
      .catch((error) => {
        this.#connection.close();
        throw error;
      })
      .finally(() => {
        if (cycle === this.#cycle) this.#opening = null;
      });
    return this.#opening;
  }

  #release(error) {
    if (!this.active && !this.#opening) return;
    this.#cycle++;
    this.#opening = null;
    this.active = false;
    const endpoint = this.#endpoint;
    this.#endpoint = null;
    endpoint?.close();
    this.emit('close', error);
  }

  close() {
    this.#connection.close();
    this.#release();
  }

  write(data) {
    if (!this.active) throw new Error('RTC transport is not connected');
    return this.#endpoint.write(data);
  }

  drain() {
    return this.#endpoint?.drain() ?? Promise.resolve();
  }

  announce(id) {
    this.send({ type: 'metacom:stream', id });
  }
}

class ClientEventTransport extends ClientTransport {
  static instance = null;

  #id = generateUUID();
  #port = null;
  #worker = null;
  #container = null;
  #instance = '';
  #opening = null;
  #handshake = null;
  #pingTimer = null;
  #pongTimer = null;
  #pingInterval = PING_INTERVAL_MS;
  #pongTimeout = PONG_TIMEOUT_MS;
  #handshakeTimeout = HANDSHAKE_TIMEOUT_MS;
  #onContainerMessage = null;
  #onControllerChange = null;
  #onPageHide = null;

  static getInstance(url) {
    if (ClientEventTransport.instance) {
      return ClientEventTransport.instance;
    }
    const transport = new ClientEventTransport(url);
    ClientEventTransport.instance = transport;
    return transport;
  }

  // Tab has one connection to the worker
  static create(url) {
    return ClientEventTransport.getInstance(url);
  }

  constructor(url) {
    super(url);
    this.#onContainerMessage = ({ data }) => {
      if (data?.type === 'metacom:reset') this.#drop();
    };
    // First claim reports the worker this tab is already connected to
    this.#onControllerChange = () => {
      const { controller } = this.#container;
      if (!controller || controller === this.#worker) return;
      this.#worker = controller;
      this.#drop();
    };
    this.#onPageHide = () => {
      this.#disconnect();
      this.#drop();
    };
  }

  async open(options = {}) {
    if (this.active) return;
    if (this.#opening) {
      await this.#opening;
      return;
    }
    this.#configure(options);
    if (!this.#worker) throw new Error('Service Worker not provided');
    this.#opening = this.#connect(options.callTimeout);
    try {
      await this.#opening;
    } finally {
      this.#opening = null;
    }
  }

  #configure(options) {
    const { pingInterval, pongTimeout, handshakeTimeout } = options;
    if (pingInterval) this.#pingInterval = pingInterval;
    if (pongTimeout) this.#pongTimeout = pongTimeout;
    if (handshakeTimeout) this.#handshakeTimeout = handshakeTimeout;
    const container = options.container ?? globalThis.navigator?.serviceWorker;
    this.#container = container ?? null;
    const worker = this.#worker ?? options.worker ?? null;
    const isStale = worker !== null && worker.state === 'redundant';
    const controller = this.#container ? this.#container.controller : null;
    this.#worker = isStale && controller ? controller : worker;
  }

  // Worker answers with metacom:ready when it holds the other port
  #connect(callTimeout) {
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      this.#port = port1;
      port1.addEventListener('message', ({ data }) => {
        if (this.#port === port1) this.#receive(data);
      });
      port1.start();
      const timer = setTimeout(() => {
        this.#reject(new Error('Service Worker handshake timeout'));
        this.#release();
      }, this.#handshakeTimeout);
      this.#handshake = { resolve, reject, timer };
      const message = { type: 'metacom:connect', id: this.#id, callTimeout };
      this.#worker.postMessage(message, [port2]);
    });
  }

  #receive(data) {
    if (data === undefined) return;
    const isPacket = typeof data === 'string' || ArrayBuffer.isView(data);
    if (isPacket) return void this.emit('message', data);
    const { type } = data;
    if (type === 'metacom:ready') this.#accept(data);
    else if (type === 'metacom:pong') this.#alive(data.instance);
    else if (type === 'metacom:status') this.#report(data.connected);
  }

  #accept({ instance, connected }) {
    const handshake = this.#handshake;
    if (!handshake) return;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    this.#instance = instance;
    this.active = true;
    this.#bind();
    this.#pingTimer = startInterval(() => this.#ping(), this.#pingInterval);
    this.emit('open');
    handshake.resolve();
    this.#report(connected);
  }

  #reject(error) {
    const handshake = this.#handshake;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    handshake.reject(error);
  }

  #report(connected) {
    this.emit('status', { connected });
  }

  // Ping is posted to the worker itself to extend its lifetime
  #ping() {
    this.#worker.postMessage({ type: 'metacom:ping', id: this.#id });
    if (this.#pongTimer) return;
    this.#pongTimer = setTimeout(() => this.#drop(), this.#pongTimeout);
  }

  // Restarted worker has another instance id and no port of this tab
  #alive(instance) {
    clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
    if (instance !== this.#instance) this.#drop();
  }

  #bind() {
    const container = this.#container;
    if (container) {
      container.addEventListener('message', this.#onContainerMessage);
      container.addEventListener('controllerchange', this.#onControllerChange);
    }
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', this.#onPageHide);
  }

  #unbind() {
    const container = this.#container;
    if (container) {
      container.removeEventListener('message', this.#onContainerMessage);
      const onChange = this.#onControllerChange;
      container.removeEventListener('controllerchange', onChange);
    }
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.#onPageHide);
  }

  #release() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
    if (this.#handshake) this.#reject(new Error('Connection closed'));
    this.#unbind();
    if (this.#port) this.#port.close();
    this.#port = null;
    this.active = false;
  }

  // Connection to the worker is lost, Metacom reconnects on close
  #drop() {
    if (!this.active) return;
    this.#release();
    this.emit('close');
  }

  #disconnect() {
    const target = this.#port ?? this.#worker;
    target.postMessage({ type: 'metacom:disconnect', id: this.#id });
  }

  close() {
    if (!this.#port) return;
    const wasActive = this.active;
    this.#disconnect();
    this.#release();
    if (wasActive) this.emit('close');
  }

  announce(id) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage({ type: 'metacom:stream', id });
  }

  online() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:online' });
  }

  offline() {
    if (this.#worker) this.#worker.postMessage({ type: 'metacom:offline' });
  }

  write(data) {
    if (!this.#port) throw new Error('Not connected');
    this.#port.postMessage(data);
  }
}

const TRANSPORTS = {
  ws: ClientWsTransport,
  http: ClientHttpTransport,
  event: ClientEventTransport,
  webrtc: ClientRtcTransport,
};

// rtc-bridge.js

const RTC_BRIDGE_PROTOCOL = 'metacom:rtc-bridge';
const RTC_BRIDGE_VERSION = 1;
const RTC_BRIDGE_HANDSHAKE_MS = 15000;
const RTC_BRIDGE_PING_MS = 1000;
const RTC_BRIDGE_PONG_MS = 5000;
const RTC_BRIDGE_MAX_BYTES = 16 * 1024 * 1024;
const RTC_BRIDGE_QUEUE_BYTES = 32 * 1024 * 1024;
const RTC_BRIDGE_ENCODER = new TextEncoder();

const rtcBridgeSize = (data) => {
  if (typeof data === 'string') return RTC_BRIDGE_ENCODER.encode(data).length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new TypeError('Invalid RTC bridge packet');
};

const rtcBridgeMessage = (generation, kind, body = {}) => ({
  protocol: RTC_BRIDGE_PROTOCOL,
  version: RTC_BRIDGE_VERSION,
  generation,
  kind,
  ...body,
});

const isRtcBridgeMessage = (data, generation) =>
  data?.protocol === RTC_BRIDGE_PROTOCOL && data.generation === generation;

// One credit per direction: ACK follows delivery and downstream drain.
class RtcBridgeLink extends Emitter {
  #port;
  #generation;
  #deliver;
  #listener;
  #queue = [];
  #bytes = 0;
  #sequence = 0;
  #received = 0;
  #inflight = null;
  #receiving = false;
  #waiters = [];
  closed = false;

  constructor(port, generation, deliver) {
    super();
    this.#port = port;
    this.#generation = generation;
    this.#deliver = deliver;
    this.#listener = ({ data }) => {
      if (!isRtcBridgeMessage(data, generation)) return;
      this.#receive(data).catch((error) => this.close(error));
    };
    port.addEventListener('message', this.#listener);
    port.start();
  }

  post(kind, body = {}) {
    if (this.closed) return;
    this.#port.postMessage(rtcBridgeMessage(this.#generation, kind, body));
  }

  write(packet) {
    if (this.closed) throw new Error('RTC bridge closed');
    const bytes = rtcBridgeSize(packet);
    if (
      bytes > RTC_BRIDGE_MAX_BYTES ||
      this.#bytes + bytes > RTC_BRIDGE_QUEUE_BYTES ||
      this.#queue.length >= 1024
    ) {
      throw new RangeError('RTC bridge queue limit exceeded');
    }
    const copy =
      typeof packet === 'string'
        ? packet
        : new Uint8Array(
            packet.buffer,
            packet.byteOffset,
            packet.byteLength,
          ).slice();
    this.#queue.push({ packet: copy, bytes });
    this.#bytes += bytes;
    this.#flush();
    return false;
  }

  #flush() {
    if (this.closed || this.#inflight) return;
    const next = this.#queue.shift();
    if (!next) {
      for (const resolve of this.#waiters) resolve();
      this.#waiters = [];
      return;
    }
    this.#inflight = { ...next, sequence: ++this.#sequence };
    this.post('data', { packet: next.packet, sequence: this.#sequence });
  }

  async #receive(data) {
    if (this.closed) return;
    if (data.version !== RTC_BRIDGE_VERSION) {
      throw new Error('RTC bridge version mismatch');
    }
    if (data.kind === 'close') {
      return void this.close(
        new Error(data.message ?? 'RTC bridge closed'),
        false,
      );
    }
    if (data.kind === 'ack') {
      if (data.sequence !== this.#inflight?.sequence) {
        throw new Error('Invalid RTC bridge ACK');
      }
      this.#bytes -= this.#inflight.bytes;
      this.#inflight = null;
      this.#flush();
    } else if (data.kind === 'data') {
      if (
        this.#receiving ||
        data.sequence !== this.#received + 1 ||
        rtcBridgeSize(data.packet) > RTC_BRIDGE_MAX_BYTES
      ) {
        throw new Error('Invalid RTC bridge credit or packet');
      }
      this.#receiving = true;
      await this.#deliver(data.packet);
      this.#receiving = false;
      this.#received = data.sequence;
      this.post('ack', { sequence: data.sequence });
    }
  }

  drain() {
    if (this.closed || (!this.#inflight && !this.#queue.length)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  close(error = null, notify = true) {
    if (this.closed) return;
    if (notify) this.post('close', { message: error?.message });
    this.closed = true;
    this.#port.removeEventListener('message', this.#listener);
    this.#port.close();
    this.#queue = [];
    this.#inflight = null;
    this.#bytes = 0;
    for (const resolve of this.#waiters) resolve();
    this.#waiters = [];
    this.emit('close', error);
  }
}

class ClientRtcBridgeTransport extends ClientTransport {
  #instance = generateUUID();
  #scope = null;
  #listener = null;
  #options = null;
  #link = null;
  #opening = null;
  #pending = null;
  #generation = null;
  #retired = new Set();
  #timer = null;
  #heartbeat = null;
  #lastPing = 0;
  #epoch = 0;

  open(options = {}) {
    if (this.active) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const scope = globalThis.self;
    if (
      !scope?.clients ||
      !scope.location ||
      typeof options.bridge?.authorize !== 'function'
    ) {
      return Promise.reject(
        new Error(
          'RTC bridge requires a worker and explicit client authorization',
        ),
      );
    }
    this.#options = options.bridge;
    this.#scope = scope;
    if (!this.#listener) {
      this.#listener = (event) => {
        this.#control(event).catch((error) => {
          const port = event.ports?.[0];
          const { message } = error;
          const generation = event.data?.generation;
          port?.postMessage(rtcBridgeMessage(generation, 'error', { message }));
          port?.close();
        });
      };
      scope.addEventListener('message', this.#listener);
    }
    this.#opening = new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
    this.#timer = setTimeout(
      () => this.#release(new Error('RTC bridge handshake timeout')),
      options.bridge.handshakeTimeout ?? RTC_BRIDGE_HANDSHAKE_MS,
    );
    return this.#opening;
  }

  async #control(event) {
    const data = event.data;
    if (data?.protocol !== RTC_BRIDGE_PROTOCOL) return;
    const { generation } = data;
    if (data.kind === 'ping') {
      if (generation === this.#generation && this.#link) {
        this.#lastPing = Date.now();
        this.#link.post('pong', { instance: this.#instance });
      } else {
        event.source?.postMessage({
          type: 'metacom:rtc-bridge:reset',
          generation,
        });
      }
      return;
    }
    if (data.kind !== 'attach') return;
    const port = event.ports?.[0];
    if (!port) return;
    const epoch = this.#epoch;
    const source = event.source;
    const expectedOrigin = this.#scope.location.origin;
    const clients = await this.#scope.clients.matchAll({
      type: 'window',
      includeUncontrolled: false,
    });
    const controlled = clients.some((client) => client.id === source?.id);
    const wrongOrigin = event.origin && event.origin !== expectedOrigin;
    if (
      data.version !== RTC_BRIDGE_VERSION ||
      typeof generation !== 'string' ||
      !generation ||
      this.#retired.has(generation) ||
      data.peerId !== this.#options.peerId ||
      !controlled ||
      new URL(source.url).origin !== expectedOrigin ||
      wrongOrigin
    ) {
      throw new Error('RTC bridge attachment rejected');
    }
    const authorized = await this.#options.authorize(source, data);
    if (!authorized) throw new Error('RTC bridge attachment rejected');
    if (epoch !== this.#epoch || !this.#listener) return void port.close();
    if (this.#link) throw new Error('RTC bridge owner already attached');
    this.#generation = generation;
    const link = new RtcBridgeLink(port, generation, (packet) => {
      this.emit('message', packet);
    });
    this.#link = link;
    link.on('close', (error) => this.#release(error));
    const handshake = ({ data: message }) => {
      const isReady = isRtcBridgeMessage(message, generation);
      if (!isReady || message.kind !== 'ready') return;
      port.removeEventListener('message', handshake);
      if (
        message.version !== RTC_BRIDGE_VERSION ||
        message.instance !== this.#instance ||
        message.peerId !== this.#options.peerId
      ) {
        return void this.#release(
          new Error('Invalid RTC bridge ready message'),
        );
      }
      clearTimeout(this.#timer);
      this.#timer = null;
      this.active = true;
      this.#lastPing = Date.now();
      const pongTimeout = this.#options.pongTimeout ?? RTC_BRIDGE_PONG_MS;
      const pingInterval = this.#options.pingInterval ?? RTC_BRIDGE_PING_MS;
      this.#heartbeat = startInterval(() => {
        if (Date.now() - this.#lastPing > pongTimeout) {
          this.#release(new Error('RTC bridge owner heartbeat timeout'));
        }
      }, pingInterval);
      link.post('ready-ack', { instance: this.#instance });
      this.#pending?.resolve();
      this.#pending = null;
      this.#opening = null;
      this.emit('open');
    };
    port.addEventListener('message', handshake);
    link.post('accepted', {
      instance: this.#instance,
      peerId: this.#options.peerId,
    });
  }

  #release(error = new Error('RTC bridge closed')) {
    this.#epoch++;
    const wasOpen = this.active || this.#pending !== null;
    this.active = false;
    clearTimeout(this.#timer);
    clearInterval(this.#heartbeat);
    const link = this.#link;
    this.#link = null;
    if (this.#generation) {
      retireRtcGeneration(this.#retired, this.#generation);
    }
    this.#generation = null;
    this.#pending?.reject(error);
    this.#pending = null;
    this.#opening = null;
    link?.close(error);
    if (wasOpen) this.emit('close', error);
  }

  close() {
    this.#epoch++;
    this.#scope?.removeEventListener('message', this.#listener);
    this.#listener = null;
    this.#release();
  }

  write(data) {
    if (!this.active) throw new Error('RTC bridge is not connected');
    return this.#link.write(data);
  }

  drain() {
    return this.#link?.drain() ?? Promise.resolve();
  }
  announce(id) {
    this.send({ type: 'metacom:stream', id });
  }
}

class MetacomRtcBridge {
  static attach(worker, rtcOptions) {
    return new MetacomRtcBridge(worker, rtcOptions);
  }

  #worker;
  #rtc;
  #port;
  #link = null;
  #transport = new ClientRtcTransport('rtc-bridge-owner');
  #generation = generateUUID();
  #instance = null;
  #resolve;
  #reject;
  #timer;
  #heartbeat = null;
  #lastPong = Date.now();
  #container;
  #onReset;
  #onController;
  #onPageHide;
  #onPort;
  closed = false;

  constructor(worker, rtcOptions) {
    this.#worker = worker;
    this.#rtc = rtcOptions;
    this.ready = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.ready.catch(() => {});
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    this.#onPort = ({ data }) => {
      if (!isRtcBridgeMessage(data, this.#generation)) return;
      this.#receive(data).catch((error) => this.close(error));
    };
    port1.addEventListener('message', this.#onPort);
    port1.start();
    this.#container = globalThis.navigator?.serviceWorker;
    this.#onReset = ({ data }) => {
      if (
        data?.type === 'metacom:rtc-bridge:reset' &&
        data.generation === this.#generation
      ) {
        this.close(new Error('RTC bridge worker restarted'));
      }
    };
    this.#onController = () => {
      const controller = this.#container.controller;
      if (controller && controller !== worker) {
        this.close(new Error('RTC bridge controller replaced'));
      }
    };
    this.#onPageHide = () => this.close();
    this.#container?.addEventListener('message', this.#onReset);
    this.#container?.addEventListener('controllerchange', this.#onController);
    globalThis.window?.addEventListener('pagehide', this.#onPageHide);
    this.#timer = setTimeout(
      () => this.close(new Error('RTC bridge handshake timeout')),
      rtcOptions.handshakeTimeout ?? RTC_BRIDGE_HANDSHAKE_MS,
    );
    try {
      const { peerId, localId } = rtcOptions;
      const body = { peerId, localId };
      const message = rtcBridgeMessage(this.#generation, 'attach', body);
      worker.postMessage(message, [port2]);
    } catch (error) {
      this.close(error);
    }
  }

  async #receive(data) {
    if (this.closed) return;
    if (data.version !== RTC_BRIDGE_VERSION) {
      throw new Error('RTC bridge version mismatch');
    }
    if (data.kind === 'error') throw new Error(data.message);
    if (data.kind === 'accepted') {
      if (
        this.#link ||
        data.peerId !== this.#rtc.peerId ||
        typeof data.instance !== 'string'
      ) {
        throw new Error('Invalid RTC bridge acceptance');
      }
      this.#instance = data.instance;
      this.#link = new RtcBridgeLink(
        this.#port,
        this.#generation,
        async (packet) => {
          if (!this.#transport.write(packet)) await this.#transport.drain();
        },
      );
      this.#link.on('close', (error) => this.close(error));
      this.#transport.on('message', (packet) => this.#link.write(packet));
      this.#transport.on('close', () =>
        this.close(new Error('RTC bridge peer disconnected')),
      );
      await this.#transport.open({ rtc: this.#rtc });
      if (this.closed) return;
      this.#link.post('ready', {
        instance: this.#instance,
        peerId: this.#rtc.peerId,
      });
    } else if (data.kind === 'ready-ack') {
      if (data.instance !== this.#instance) {
        throw new Error('RTC bridge worker changed');
      }
      clearTimeout(this.#timer);
      this.#lastPong = Date.now();
      this.#resolve();
      const pongTimeout = this.#rtc.pongTimeout ?? RTC_BRIDGE_PONG_MS;
      const pingInterval = this.#rtc.pingInterval ?? RTC_BRIDGE_PING_MS;
      const ping = rtcBridgeMessage(this.#generation, 'ping');
      this.#heartbeat = startInterval(() => {
        if (Date.now() - this.#lastPong > pongTimeout) {
          const error = new Error('RTC bridge worker heartbeat timeout');
          return void this.close(error);
        }
        this.#worker.postMessage(ping);
      }, pingInterval);
    } else if (data.kind === 'pong') {
      if (data.instance !== this.#instance) {
        throw new Error('RTC bridge worker changed');
      }
      this.#lastPong = Date.now();
    }
  }

  close(error = new Error('RTC bridge owner closed')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#heartbeat);
    this.#container?.removeEventListener('message', this.#onReset);
    this.#container?.removeEventListener(
      'controllerchange',
      this.#onController,
    );
    globalThis.window?.removeEventListener('pagehide', this.#onPageHide);
    this.#port.removeEventListener('message', this.#onPort);
    this.#link?.close(error);
    this.#transport.close();
    this.#port.close();
    this.#reject(error);
  }
}

TRANSPORTS['rtc-bridge'] = ClientRtcBridgeTransport;

// chunks-browser.js

const ID_LENGTH_BYTES = 1;
const MAX_ID_LENGTH = 255;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const chunkEncode = (id, payload) => {
  const idBuffer = TEXT_ENCODER.encode(id);
  const idLength = idBuffer.length;
  if (idLength > MAX_ID_LENGTH) {
    const limit = `maximum of ${MAX_ID_LENGTH} characters`;
    throw new Error(`ID length ${idLength} exceeds ${limit}`);
  }
  const chunk = new Uint8Array(ID_LENGTH_BYTES + idLength + payload.length);
  chunk[0] = idLength;
  chunk.set(idBuffer, ID_LENGTH_BYTES);
  chunk.set(payload, ID_LENGTH_BYTES + idLength);
  return chunk;
};

const chunkDecode = (chunk) => {
  const idLength = chunk[0];
  const idBuffer = chunk.subarray(ID_LENGTH_BYTES, ID_LENGTH_BYTES + idLength);
  const id = TEXT_DECODER.decode(idBuffer);
  const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
  return { id, payload };
};

// streams.js

const PUSH_EVENT = Symbol();
const PULL_EVENT = Symbol();
const DEFAULT_HIGH_WATER_MARK = 32;
const MAX_PENDING_PUSHES = 1000;

const isStreamMeta = (name, size) => {
  const isSize = Number.isSafeInteger(size) && size >= 0;
  return typeof name === 'string' && isSize;
};

// Works for both node:stream Writable and metautil Emitter
const waitEvent = (emitter, eventName) => {
  const executor = (resolve) => emitter.once(eventName, resolve);
  return new Promise(executor);
};

class MetaReadable extends Emitter {
  queue = [];
  streaming = true;
  status = 'active';
  bytesRead = 0;
  highWaterMark = DEFAULT_HIGH_WATER_MARK;
  #pending = [];

  constructor(id, name, size, options = {}) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    const { highWaterMark } = options;
    if (highWaterMark) this.highWaterMark = highWaterMark;
  }

  // Chunks over highWaterMark wait in arrival order, pull moves them to queue
  async push(data) {
    if (this.queue.length <= this.highWaterMark) return this.#enqueue(data);
    if (this.#pending.length >= MAX_PENDING_PUSHES) {
      throw new Error('Stream overflow occurred');
    }
    return new Promise((resolve) => {
      this.#pending.push({ data, resolve });
    });
  }

  #enqueue(data) {
    this.queue.push(data);
    if (this.queue.length === 1) this.emit(PUSH_EVENT);
    return data;
  }

  async finalize(writable) {
    const onError = () => this.terminate();
    writable.once('error', onError);
    for await (const chunk of this) {
      const needDrain = !writable.write(chunk);
      if (needDrain) await waitEvent(writable, 'drain');
    }
    this.emit('end');
    writable.end();
    await waitEvent(writable, 'close');
    writable.off('error', onError);
  }

  pipe(writable) {
    this.finalize(writable).catch((error) => this.emit('error', error));
    return writable;
  }

  async toBlob(type = '') {
    const chunks = [];
    for await (const chunk of this) {
      chunks.push(chunk);
    }
    return new Blob(chunks, { type });
  }

  async close() {
    await this.stop(false);
    const { bytesRead, size } = this;
    const isComplete = bytesRead === size;
    this.status = isComplete ? 'closed' : 'terminated';
    if (isComplete) return;
    throw new Error(`Stream size mismatch: ${bytesRead} of ${size} bytes`);
  }

  async terminate() {
    await this.stop(true);
    this.status = 'terminated';
  }

  async stop(force = false) {
    if (!force) {
      while (this.streaming && this.queue.length > 0) {
        await this.toPromise(PULL_EVENT);
      }
    }
    this.streaming = false;
    this.queue.length = 0;
    const pending = this.#pending;
    this.#pending = [];
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      entry.resolve(entry.data);
    }
    this.emit(PUSH_EVENT, null);
    this.emit(PULL_EVENT);
  }

  async read() {
    if (this.queue.length > 0) return this.pull();
    const finisher = await this.toPromise(PUSH_EVENT);
    if (finisher === null) return null;
    return this.pull();
  }

  pull() {
    const data = this.queue.shift();
    if (!data) return data;
    this.bytesRead += data.length;
    const next = this.#pending.shift();
    if (next) next.resolve(this.#enqueue(next.data));
    this.emit(PULL_EVENT);
    return data;
  }

  async *[Symbol.asyncIterator]() {
    while (this.streaming) {
      const chunk = await this.read();
      if (!chunk) return;
      yield chunk;
    }
  }
}

class MetaWritable extends Emitter {
  #draining = false;

  constructor(id, name, size, transport) {
    super();
    this.id = id;
    this.name = name;
    this.size = size;
    this.transport = transport;
    this.init();
  }

  init() {
    const { id, name, size } = this;
    const packet = { type: 'stream', id, name, size };
    this.transport.send(packet);
  }

  // Transport returns false when its buffer is full, undefined is writable
  write(data) {
    const chunk = chunkEncode(this.id, data);
    const isWritable = this.transport.write(chunk) !== false;
    if (!isWritable) this.#waitDrain();
    return isWritable;
  }

  async #waitDrain() {
    if (this.#draining) return;
    this.#draining = true;
    await this.transport.drain();
    this.#draining = false;
    this.emit('drain');
  }

  end() {
    const packet = { type: 'stream', id: this.id, status: 'end' };
    this.transport.send(packet);
  }

  terminate() {
    const packet = { type: 'stream', id: this.id, status: 'terminate' };
    this.transport.send(packet);
  }
}

// metacom.js

const CALL_TIMEOUT_MS = 7 * 1000;
const RECONNECT_TIMEOUT_MS = 2 * 1000;
const QUEUE_OVERFLOW = { message: 'Service Unavailable', code: 503 };

// Blob is the only input that can not be viewed synchronously
const toByteView = (input) => {
  if (input instanceof Uint8Array) return input;
  if (typeof input.arrayBuffer === 'function') return null;
  return new Uint8Array(input);
};

const selectTransport = (url, options) => {
  if (options.transport) return options.transport;
  if (options.worker) return 'event';
  return url.startsWith('http') ? 'http' : 'ws';
};

const readBlob = async (blob) => {
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
};

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class Metacom extends Emitter {
  static connections = new Set();
  static isOnline = true;
  static transport = TRANSPORTS;
  static #shared = new WeakMap();

  static online() {
    Metacom.isOnline = true;
    for (const connection of Metacom.connections) {
      connection.#transport.online();
      if (!connection.active) {
        connection.open().catch((error) => connection.#report(error));
      }
    }
  }

  static offline() {
    Metacom.isOnline = false;
    for (const connection of Metacom.connections) {
      connection.#transport.offline();
    }
  }

  // Page and worker both expose their global scope as self
  static initialize() {
    const scope = globalThis.self;
    if (!scope) return;
    scope.addEventListener('online', Metacom.online);
    scope.addEventListener('offline', Metacom.offline);
  }

  api = {};
  #transport = null;
  #calls = new Map();
  #streams = new Map();
  #expected = new Set();
  #units = new Set();
  #outbox = [];
  #queueSize = 0;
  #restore = null;
  #restoring = false;
  #generateId = generateUUID;
  #callTimeout = CALL_TIMEOUT_MS;
  #reconnectTimeout = RECONNECT_TIMEOUT_MS;
  #reconnectTimer = null;
  #proxy = null;
  #options = {};

  get active() {
    return this.#transport.active;
  }

  constructor(url, transport, options = {}) {
    super();
    const callTimeout = options.callTimeout;
    const reconnectTimeout = options.reconnectTimeout;
    const queueSize = options.queueSize;
    const restore = options.restore;
    const generateId = options.generateId;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (reconnectTimeout) this.#reconnectTimeout = reconnectTimeout;
    if (queueSize) this.#queueSize = queueSize;
    if (restore) this.#restore = restore;
    if (generateId) this.#generateId = generateId;
    this.url = url;
    this.#transport = transport;
    this.#options = options;
    this.#bindTransport();
  }

  // Shared transport, like tab connection to worker, gets one Metacom
  static create(url, options = {}) {
    const name = selectTransport(url, options);
    const Transport = Metacom.transport[name];
    if (!Transport) throw new Error(`Unknown transport: '${name}'`);
    const transport = Transport.create(url);
    const shared = Metacom.#shared.get(transport);
    if (shared) return shared;
    const metacom = new Metacom(url, transport, options);
    Metacom.#shared.set(transport, metacom);
    return metacom;
  }

  static async connect(url, options = {}) {
    const metacom = Metacom.create(url, options);
    try {
      await metacom.open();
    } catch (error) {
      metacom.close();
      throw error;
    }
    return metacom;
  }

  #bindTransport() {
    const report = (error) => this.#report(error);

    this.#transport.on('open', () => {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.emit('open');
      this.#resume().catch(report);
    });

    this.#transport.on('close', () => {
      this.#terminateStreams();
      this.emit('close');
      this.#scheduleReconnect();
    });

    this.#transport.on('error', report);

    this.#transport.on('status', (status) => {
      this.emit('status', status);
      if (status.connected) this.#refresh().catch(report);
    });

    this.#transport.on('message', (data) => {
      if (typeof data === 'string') this.#handlePacket(data).catch(report);
      else this.#handleBinary(data).catch(report);
    });
  }

  // Server forgets streams on disconnect, expected ones wait for a call
  #terminateStreams() {
    for (const entry of this.#streams) {
      const id = entry[0];
      if (this.#expected.has(id)) continue;
      this.#streams.delete(id);
      entry[1].terminate().catch((error) => this.#report(error));
    }
  }

  #report(error) {
    emitError(this, error);
  }

  #scheduleReconnect() {
    if (this.active) return;
    if (!Metacom.connections.has(this)) return;
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.open().catch((error) => this.#report(error));
    }, this.#reconnectTimeout);
  }

  async open() {
    Metacom.connections.add(this);
    try {
      await this.#transport.open(this.#options);
    } catch (error) {
      this.#scheduleReconnect();
      throw error;
    }
  }

  close() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#outbox = [];
    Metacom.connections.delete(this);
    this.#transport.close();
  }

  write(data) {
    return this.#transport.write(data);
  }

  drain() {
    return this.#transport.drain();
  }

  send(data) {
    this.#transport.send(data);
  }

  setProxy(proxy) {
    if (proxy && this.#proxy && this.#proxy !== proxy) {
      throw new Error('Metacom already has a packet router');
    }
    this.#proxy = proxy;
  }

  deliver(data, timeout = this.#callTimeout) {
    const isReady = this.active && !this.#restoring;
    const isDirect = isReady || this.#queueSize === 0;
    if (isDirect) {
      this.#transport.write(data);
      return true;
    }
    if (this.#outbox.length >= this.#queueSize) this.#compact();
    if (this.#outbox.length >= this.#queueSize) return false;
    const expires = Date.now() + timeout;
    this.#outbox.push({ data, expires });
    return true;
  }

  #compact() {
    const now = Date.now();
    this.#outbox = this.#outbox.filter((entry) => entry.expires > now);
  }

  // Session is restored before queued packets reach the server
  async #resume() {
    this.#restoring = true;
    try {
      if (this.#restore) await this.#restore(this);
    } finally {
      this.#restoring = false;
      this.#flush();
    }
  }

  #flush() {
    const outbox = this.#outbox;
    if (outbox.length === 0) return;
    this.#outbox = [];
    const now = Date.now();
    for (let i = 0; i < outbox.length; i++) {
      const entry = outbox[i];
      if (entry.expires <= now) continue;
      if (this.active) this.#transport.write(entry.data);
      else this.#outbox.push(entry);
    }
  }

  getStream(id) {
    const stream = this.#streams.get(id);
    if (stream) return stream;
    throw new Error(`Stream ${id} is not initialized`);
  }

  createStream(name, size) {
    const id = this.#generateId();
    return new MetaWritable(id, name, size, this);
  }

  // Stream id is created by the receiver and passed to the server in args
  createReadable() {
    const id = this.#generateId();
    const readable = new MetaReadable(id, '', 0);
    this.#streams.set(id, readable);
    this.#expected.add(id);
    this.#transport.announce(id);
    return readable;
  }

  createBlobUploader(blob) {
    const { name = 'blob', size } = blob;
    const consumer = this.createStream(name, size);
    const { id } = consumer;
    const upload = async () => {
      for await (const chunk of blob.stream()) {
        const isWritable = consumer.write(chunk);
        if (!isWritable) await consumer.toPromise('drain');
      }
      consumer.end();
    };
    return { id, upload };
  }

  async #handlePacket(data) {
    const packet = jsonParse(data);
    if (!packet) throw new Error('Invalid JSON packet');
    const { type, id } = packet;
    const proxy = this.#proxy;
    if (type === 'event') {
      this.#handleEvent(packet);
      if (proxy) proxy.packet(packet, data);
      return;
    }
    if (!id) throw new Error('Packet structure error');
    if (type === 'callback') {
      const isForeign = proxy !== null && !this.#calls.has(id);
      if (isForeign) return void proxy.packet(packet, data);
      return void this.#handleCallback(packet);
    }
    if (type !== 'stream') return;
    const isForeign = proxy !== null && !this.#streams.has(id);
    if (isForeign) return void proxy.packet(packet, data);
    await this.#handleStream(packet);
  }

  #handleEvent(packet) {
    const route = split(packet.name, '/');
    const unit = route[0];
    const eventName = route[1];
    const metacomUnit = this.api[unit];
    if (metacomUnit) metacomUnit.emit(eventName, packet.data);
  }

  #handleCallback(packet) {
    const { id } = packet;
    const pending = this.#calls.get(id);
    if (!pending) throw new Error(`Callback ${id} not found`);
    const { resolve, reject, timeout } = pending;
    this.#calls.delete(id);
    clearTimeout(timeout);
    if (packet.error) return void reject(new MetacomError(packet.error));
    resolve(packet.result);
  }

  async #handleStream(packet) {
    const { id, name, size, status } = packet;
    const stream = this.#streams.get(id);
    if (status === undefined) {
      if (this.#expected.delete(id)) {
        stream.name = name;
        stream.size = size;
        return;
      }
      if (stream) {
        throw new Error(`Stream ${name} is already initialized`);
      }
      const readable = new MetaReadable(id, name, size);
      this.#streams.set(id, readable);
      return;
    }
    if (!stream) throw new Error(`Stream ${id} is not initialized`);
    const isEnd = status === 'end';
    if (!isEnd && status !== 'terminate') return;
    try {
      if (isEnd) await stream.close();
      else await stream.terminate();
    } finally {
      this.#streams.delete(id);
    }
  }

  async #handleBinary(input) {
    let byteView = toByteView(input);
    if (!byteView) byteView = await readBlob(input);
    const { id, payload } = chunkDecode(byteView);
    const stream = this.#streams.get(id);
    if (!stream) {
      if (!this.#proxy) throw new Error(`Stream ${id} is not initialized`);
      return void this.#proxy.binary(id, byteView);
    }
    await stream.push(payload);
  }

  async load(...units) {
    if (!this.active) throw new Error('Not connected');
    const introspection = await this.#introspect(units);
    for (let i = 0; i < units.length; i++) this.#units.add(units[i]);
    this.#extend(introspection, units);
  }

  #introspect(units) {
    return this.#request('system/introspect', units);
  }

  // Server methods appear in loaded units after proxy reaches the server
  async #refresh() {
    if (this.#units.size === 0) return;
    const units = Array.from(this.#units);
    const introspection = await this.#introspect(units);
    this.#extend(introspection, units);
  }

  // Unit emitter is reused to keep event listeners
  #extend(introspection, units) {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!Object.hasOwn(introspection, unit)) continue;
      const methods = this.api[unit] ?? new Emitter();
      const methodNames = Object.keys(introspection[unit]);
      for (let j = 0; j < methodNames.length; j++) {
        const methodName = methodNames[j];
        if (Object.hasOwn(methods, methodName)) continue;
        const method = `${unit}/${methodName}`;
        methods[methodName] = async (args = {}) => this.#request(method, args);
      }
      this.api[unit] = methods;
    }
  }

  #request(method, args) {
    const id = this.#generateId();
    const packet = { type: 'call', id, method, args };
    const data = JSON.stringify(packet);
    const promise = this.#expect(id);
    try {
      const isAccepted = this.#post(data);
      if (!isAccepted) this.#fail(id, new MetacomError(QUEUE_OVERFLOW));
    } catch (error) {
      this.#fail(id, error);
    }
    return promise;
  }

  // Kept apart from #request so the pending timer does not retain data
  #expect(id) {
    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        this.#calls.delete(id);
        reject(new Error('Request timeout'));
      };
      const timeout = setTimeout(onTimeout, this.#callTimeout);
      this.#calls.set(id, { resolve, reject, timeout });
    });
  }

  #fail(id, error) {
    const { reject, timeout } = this.#calls.get(id);
    this.#calls.delete(id);
    clearTimeout(timeout);
    reject(error);
  }

  // Own calls skip the queue while the session is being restored
  #post(data) {
    if (!this.active) return this.deliver(data);
    this.#transport.write(data);
    return true;
  }
}

Metacom.initialize();

// router.js

const ROUTE_TIMEOUT_MS = 7 * 1000;
const SWEEP_INTERVAL_MS = 10 * 1000;
const PROXY_QUEUE_SIZE = 1000;
const BAD_REQUEST = { message: 'Bad Request', code: 400 };
const UNAVAILABLE = { message: 'Service Unavailable', code: 503 };

const sendError = (port, id, error) => {
  const packet = { type: 'callback', id, error };
  port.postMessage(JSON.stringify(packet));
};

const sendTerminate = (port, id) => {
  const packet = { type: 'stream', id, status: 'terminate' };
  port.postMessage(JSON.stringify(packet));
};

const encodeCallback = (id, result) => {
  const packet = { type: 'callback', id, result };
  return JSON.stringify(packet);
};

// Stream route: port that owns it, direction, and local upload state
const createRoute = (port, upload, expires) => ({
  port,
  upload,
  expires,
  packet: null,
  init: null,
  readable: null,
  local: false,
  forwarded: false,
});

// Attached port seen by handlers, like server Client: events to this port,
// its streams, and `close` when the port is detached
class RouterClient extends Emitter {
  #port = null;
  #router = null;

  constructor(id, port, router) {
    super();
    this.id = id;
    this.#port = port;
    this.#router = router;
  }

  emit(name, data) {
    if (name === 'close') return super.emit(name, data);
    const isAttached = this.#router.port(this.id) === this.#port;
    if (isAttached) this.#port.postMessage(encodeEvent(name, data));
    return Promise.resolve();
  }

  getStream(id) {
    return this.#router.getStream(this.#port, id);
  }

  createStream(name, size, id) {
    return this.#router.createStream(this.#port, name, size, id);
  }
}

class ProxyContext {
  #port = null;
  #ports = null;

  constructor(server, port, ports) {
    const { client } = ports.get(port);
    this.server = server;
    this.client = client;
    this.peerId = client.id;
    this.#port = port;
    this.#ports = ports;
  }

  getStream(id) {
    return this.client.getStream(id);
  }

  createStream(name, size, id) {
    return this.client.createStream(name, size, id);
  }

  emit(name, data) {
    this.client.emit(name, data);
  }

  broadcast(name, data) {
    const packet = encodeEvent(name, data);
    for (const port of this.#ports.keys()) {
      if (port !== this.#port) port.postMessage(packet);
    }
  }
}

class MetacomRouter extends Emitter {
  #instance = generateUUID();
  #getClients = null;
  #localStreams = false;
  #ports = new Map();
  #peers = new Map();
  #calls = new Map();
  #streams = new Map();
  #units = new Map();
  #interfaces = new Map();
  #server = null;
  #connecting = false;
  #attempted = false;
  #connected = false;
  #callTimeout = ROUTE_TIMEOUT_MS;
  #sweepInterval = SWEEP_INTERVAL_MS;
  #sweepTimer = null;

  get instance() {
    return this.#instance;
  }

  get server() {
    return this.#server;
  }

  get active() {
    return this.#server?.active ?? false;
  }

  constructor(options = {}) {
    super();
    const { callTimeout, sweepInterval } = options;
    if (callTimeout) this.#callTimeout = callTimeout;
    if (sweepInterval) this.#sweepInterval = sweepInterval;
    this.#localStreams = options.localStreams ?? false;
    this.#getClients = options.getClients ?? null;
    this.#server = this.#createServer(options);
  }

  #createServer(options) {
    const url = options.url;
    if (!url && !options.upstream) return null;
    const queueSize = options.queueSize ?? PROXY_QUEUE_SIZE;
    const upstreamOptions = { ...options, queueSize };
    const proxy = {
      packet: (packet, data) => this.#route(packet, data),
      binary: (id, data) => this.#routeBinary(id, data),
    };
    const server = options.upstream ?? Metacom.create(url, upstreamOptions);
    server.setProxy(proxy);
    server.on('open', () => this.#notify(true));
    server.on('close', () => {
      this.#abortStreams();
      this.#notify(false);
    });
    server.on('error', (error) => this.#escalate(error));
    return server;
  }

  async open() {
    if (!this.#server || this.#server.active) return;
    this.#connecting = !this.#attempted;
    try {
      await this.#server.open();
    } finally {
      this.#connecting = false;
      this.#attempted = true;
      if (!this.#server.active) this.#describePending();
    }
  }

  close() {
    for (const id of [...this.#peers.keys()]) this.detach(id);
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#calls.clear();
    this.#streams.clear();
    this.#server?.close();
  }

  // Local method shadows server method with the same name
  register(unit, methods) {
    const handlers = this.#units.get(unit) ?? new Map();
    const names = Object.keys(methods);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      handlers.set(name, methods[name]);
    }
    this.#units.set(unit, handlers);
  }

  broadcast(name, data) {
    this.#post(encodeEvent(name, data));
  }

  #escalate(error) {
    emitError(this, error);
  }

  port(id) {
    return this.#peers.get(id);
  }

  attach(port, options = {}) {
    if (!port) return;
    const {
      id = generateUUID(),
      clientId = '',
      callTimeout = this.#callTimeout,
    } = options;
    this.detach(id);
    const client = new RouterClient(id, port, this);
    const units = new Set();
    this.#ports.set(port, { id, clientId, callTimeout, client, units });
    if (id) this.#peers.set(id, port);
    port.addEventListener('message', ({ data }) => {
      this.receive(port, data);
    });
    port.start();
    const instance = this.#instance;
    const connected = this.#server?.active;
    port.postMessage({ type: 'metacom:ready', instance, connected });
    this.#startSweep();
    this.emit('connect', id);
    if (!connected) this.open().catch((error) => this.#escalate(error));
  }

  detach(id) {
    const port = this.#peers.get(id);
    if (port) this.#removePort(port);
  }

  #removePort(port) {
    if (!this.#ports.has(port)) return;
    const { id, client } = this.#ports.get(port);
    this.#ports.delete(port);
    this.#peers.delete(id);
    for (const entry of this.#calls) {
      if (entry[1].port === port) this.#calls.delete(entry[0]);
    }
    for (const entry of this.#streams) {
      const streamId = entry[0];
      const stream = entry[1];
      if (stream.port !== port) continue;
      this.#streams.delete(streamId);
      if (stream.readable) {
        stream.readable.terminate().catch((error) => this.#escalate(error));
      }
      const isUploading = stream.upload && stream.expires === 0;
      if (isUploading) this.#terminateUpload(streamId);
    }
    port.close();
    client.emit('close').catch((error) => this.#escalate(error));
    this.emit('disconnect', id);
  }

  #terminateUpload(id) {
    if (!this.#server?.active) return;
    this.#server.send({ type: 'stream', id, status: 'terminate' });
  }

  #startSweep() {
    if (this.#sweepTimer) return;
    const sweep = () => this.#sweep();
    this.#sweepTimer = startInterval(sweep, this.#sweepInterval);
  }

  #sweep() {
    const now = Date.now();
    for (const entry of this.#calls) {
      if (entry[1].expires <= now) this.#calls.delete(entry[0]);
    }
    for (const entry of this.#streams) {
      const { expires } = entry[1];
      const isExpired = expires !== 0 && expires <= now;
      if (isExpired) this.#streams.delete(entry[0]);
    }
    this.#sweepClients().catch((error) => this.#escalate(error));
  }

  // Closed tab is not listed by the browser, its port gives no signal
  async #sweepClients() {
    if (!this.#getClients) return;
    const list = await this.#getClients();
    if (!list) return;
    const alive = new Set();
    for (let i = 0; i < list.length; i++) alive.add(list[i].id);
    for (const entry of this.#ports) {
      const { clientId } = entry[1];
      const isClosed = clientId !== '' && !alive.has(clientId);
      if (isClosed) this.#removePort(entry[0]);
    }
  }

  // Failed reconnect attempts close the transport again and again
  #notify(connected) {
    if (this.#connected === connected) return;
    this.#connected = connected;
    const message = { type: 'metacom:status', connected };
    for (const port of this.#ports.keys()) port.postMessage(message);
  }

  #post(data) {
    for (const port of this.#ports.keys()) port.postMessage(data);
  }

  // Upstream event goes to ports that loaded its unit
  #publish(name, data) {
    if (typeof name !== 'string') return;
    const { unit } = parseMethod(name);
    for (const entry of this.#ports) {
      if (entry[1].units.has(unit)) entry[0].postMessage(data);
    }
  }

  receive(port, data) {
    const peer = this.#ports.get(port);
    if (!peer) return;
    if (typeof data === 'string') return void this.#receivePacket(port, data);
    if (ArrayBuffer.isView(data)) return void this.#forwardChunk(port, data);
    const isAnnounce = data?.type === 'metacom:stream';
    if (isAnnounce) this.#expectStream(port, data.id);
  }

  #receivePacket(port, data) {
    const packet = jsonParse(data);
    if (!packet) return void sendError(port, '', BAD_REQUEST);
    const { type, id } = packet;
    if (typeof id !== 'string' || id === '') {
      return void sendError(port, '', BAD_REQUEST);
    }
    if (type === 'call') return void this.#dispatchCall(port, packet, data);
    if (type === 'stream') return void this.#forwardStream(port, packet, data);
    if (type === 'metacom:stream') return void this.#expectStream(port, id);
    sendError(port, id, BAD_REQUEST);
  }

  #dispatchCall(port, packet, data) {
    const { id, method } = packet;
    if (typeof method !== 'string') {
      return void sendError(port, id, BAD_REQUEST);
    }
    const { unit, name } = parseMethod(method);
    const isIntrospect = unit === 'system' && name === 'introspect';
    if (isIntrospect) return void this.#introspect(port, packet, data);
    const handlers = this.#units.get(unit);
    const handler = handlers ? handlers.get(name) : undefined;
    if (handler) return void this.#invoke(port, packet, handler);
    this.#forwardCall(port, id, data, null);
  }

  async #invoke(port, packet, handler) {
    const { id, args } = packet;
    const context = new ProxyContext(this.#server, port, this.#ports);
    try {
      const result = await handler(args, context);
      if (this.#ports.has(port)) port.postMessage(encodeCallback(id, result));
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : 500;
      this.#replyError(port, id, error.message, code);
    }
  }

  #replyError(port, id, message, code) {
    if (this.#ports.has(port)) sendError(port, id, { message, code });
  }

  // Offline tab gets local and cached methods, the rest after reconnect
  #introspect(port, packet, data) {
    const { id, args } = packet;
    const units = Array.isArray(args) ? args : [];
    const loaded = this.#ports.get(port).units;
    for (let i = 0; i < units.length; i++) loaded.add(units[i]);
    const isReachable = this.#server?.active || this.#connecting;
    if (isReachable) return void this.#forwardCall(port, id, data, units);
    this.#sendInterface(port, id, units);
  }

  #sendInterface(port, id, units) {
    const result = this.#describe(units);
    port.postMessage(encodeCallback(id, result));
  }

  // Introspection waits for the first connection attempt only
  #describePending() {
    for (const entry of this.#calls) {
      const id = entry[0];
      const { port, units } = entry[1];
      if (!units) continue;
      this.#calls.delete(id);
      this.#sendInterface(port, id, units);
    }
  }

  #describe(units) {
    const result = {};
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const remote = this.#interfaces.get(unit);
      const local = this.#units.get(unit);
      if (!remote && !local) continue;
      const methods = { ...remote };
      if (local) for (const name of local.keys()) methods[name] = {};
      result[unit] = methods;
    }
    return result;
  }

  #mergeInterfaces(units, packet, data) {
    const { id, result } = packet;
    if (!result) return data;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (Object.hasOwn(result, unit)) this.#interfaces.set(unit, result[unit]);
      else this.#interfaces.delete(unit);
    }
    return encodeCallback(id, this.#describe(units));
  }

  #forwardCall(port, id, data, units) {
    if (this.#calls.has(id)) {
      return void sendError(port, id, {
        message: 'Duplicate call id',
        code: 409,
      });
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + callTimeout;
    this.#calls.set(id, { port, expires, units });
    if (this.#deliver(data, callTimeout)) return;
    this.#calls.delete(id);
    sendError(port, id, UNAVAILABLE);
  }

  #deliver(data, timeout) {
    try {
      return this.#server.deliver(data, timeout);
    } catch {
      return false;
    }
  }

  // Finished upload keeps its route for a while to pass server errors
  #forwardStream(port, packet, data) {
    const { id, status } = packet;
    if (this.#localStreams) return void this.#localStream(port, packet, data);
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (!this.#server?.active) {
      this.#streams.delete(id);
      return void sendError(port, id, UNAVAILABLE);
    }
    const { callTimeout } = this.#ports.get(port);
    const expires = status === undefined ? 0 : Date.now() + callTimeout;
    this.#streams.set(id, createRoute(port, true, expires));
    this.#server.write(data);
  }

  getStream(port, id) {
    const stream = this.#streams.get(id);
    if (!stream || stream.port !== port || !stream.upload || stream.forwarded) {
      throw new Error('Local stream is not available');
    }
    stream.local = true;
    stream.readable ??= new MetaReadable(
      id,
      stream.packet.name,
      stream.packet.size,
    );
    return stream.readable;
  }

  createStream(port, name, size, id = generateUUID()) {
    if (!this.#ports.has(port)) throw new Error('Peer disconnected');
    const existing = this.#streams.get(id);
    if (existing && (existing.port !== port || existing.upload)) {
      throw new Error('Stream id already in use');
    }
    if (!isStreamMeta(name, size)) {
      throw new TypeError('Invalid stream metadata');
    }
    this.#streams.set(id, createRoute(port, false, 0));
    const transport = {
      send: (packet) => {
        if (!this.#ports.has(port)) return;
        port.postMessage(JSON.stringify(packet));
        if (packet.status) this.#streams.delete(id);
      },
      write: (data) => {
        if (!this.#ports.has(port)) throw new Error('Peer disconnected');
        return port.postMessage(data);
      },
      drain: () => port.drain?.() ?? Promise.resolve(),
    };
    return new MetaWritable(id, name, size, transport);
  }

  #localStream(port, packet, data) {
    const { id, name, size, status } = packet;
    let stream = this.#streams.get(id);
    if (stream && stream.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (status === undefined) {
      if (stream || !isStreamMeta(name, size)) {
        return void sendError(port, id, BAD_REQUEST);
      }
      stream = createRoute(port, true, Date.now() + this.#callTimeout);
      stream.packet = packet;
      stream.init = data;
      this.#streams.set(id, stream);
      return;
    }
    if (!stream?.upload || !['end', 'terminate'].includes(status)) {
      return void sendError(port, id, BAD_REQUEST);
    }
    if (stream.local || !this.#server) {
      const readable = this.getStream(port, id);
      const finishing =
        status === 'end' ? readable.close() : readable.terminate();
      finishing.catch((error) => {
        this.#replyError(port, id, error.message, 400);
      });
      this.#streams.delete(id);
      return;
    }
    if (!this.#forwardUpload(port, id, stream, data)) return;
    stream.expires = Date.now() + this.#callTimeout;
  }

  // Upload not claimed by a local handler goes upstream, its init first
  #forwardUpload(port, id, stream, data) {
    if (!this.#server.active) {
      sendError(port, id, UNAVAILABLE);
      return false;
    }
    if (!stream.forwarded) this.#server.write(stream.init);
    stream.forwarded = true;
    this.#server.write(data);
    return true;
  }

  #localChunk(port, data) {
    const { id, payload } = chunkDecode(data);
    const stream = this.#streams.get(id);
    if (!stream?.upload || stream.port !== port) {
      return void sendError(port, id, BAD_REQUEST);
    }
    stream.expires = 0;
    if (stream.local || !this.#server) {
      const readable = this.getStream(port, id);
      readable.push(payload).catch((error) => {
        this.#replyError(port, id, error.message, 400);
      });
      return;
    }
    this.#forwardUpload(port, id, stream, data);
  }

  #forwardChunk(port, data) {
    if (this.#localStreams) return void this.#localChunk(port, data);
    if (!this.#server?.active) return;
    const { id } = chunkDecode(data);
    const stream = this.#streams.get(id);
    if (stream?.port !== port || !stream.upload) {
      return void sendError(port, id, BAD_REQUEST);
    }
    this.#server.write(data);
  }

  // Tab creates download stream id before the call that fills the stream
  #expectStream(port, id) {
    if (typeof id !== 'string' || id === '') return;
    const existing = this.#streams.get(id);
    if (existing && existing.port !== port) return;
    const { callTimeout } = this.#ports.get(port);
    const expires = Date.now() + 2 * callTimeout;
    this.#streams.set(id, createRoute(port, false, expires));
  }

  #route(packet, data) {
    const { type, id } = packet;
    if (type === 'event') return void this.#publish(packet.name, data);
    if (type === 'callback') return void this.#routeCallback(packet, data);
    const stream = this.#streams.get(id);
    if (!stream) return;
    if (packet.status === undefined) stream.expires = 0;
    else this.#streams.delete(id);
    stream.port.postMessage(data);
  }

  // Server reports stream errors as callbacks with stream id
  #routeCallback(packet, data) {
    const { id } = packet;
    const call = this.#calls.get(id);
    if (call) {
      this.#calls.delete(id);
      const { port, units } = call;
      const reply = units ? this.#mergeInterfaces(units, packet, data) : data;
      return void port.postMessage(reply);
    }
    const stream = this.#streams.get(id);
    if (stream) stream.port.postMessage(data);
  }

  #routeBinary(id, data) {
    const stream = this.#streams.get(id);
    if (stream) stream.port.postMessage(data);
  }

  // Server forgets streams on reconnect, expected downloads stay routed
  #abortStreams() {
    for (const entry of this.#streams) {
      const id = entry[0];
      const { port, expires, upload } = entry[1];
      if (expires !== 0) continue;
      if (upload) sendError(port, id, UNAVAILABLE);
      else sendTerminate(port, id);
      this.#streams.delete(id);
    }
  }
}

// peer.js

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
    const handlers = this.#subscribers.get(name) ?? new Set();
    handlers.add(handler);
    this.#subscribers.set(name, handlers);
  }

  unsubscribe(unit, event, handler) {
    const name = `${unit}/${event}`;
    const handlers = this.#subscribers.get(name);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.#subscribers.delete(name);
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
    const pending = [...this.#calls.keys()];
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
    for (const handler of [...handlers]) {
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

// proxy.js

const getWorkerUrl = () => {
  const { protocol, host } = self.location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}`;
};

class MetacomProxy extends MetacomRouter {
  #scope;
  #listener;

  constructor(options = {}) {
    const scope = globalThis.self;
    if (!scope) {
      throw new Error('MetacomProxy must run in ServiceWorker context');
    }
    const getClients = async () => {
      if (!scope.clients) return null;
      return scope.clients.matchAll({ includeUncontrolled: true, type: 'all' });
    };
    super({ ...options, url: options.url ?? getWorkerUrl(), getClients });
    this.#scope = scope;
    this.#listener = (event) => this.#control(event);
    scope.addEventListener('message', this.#listener);
  }

  #control(event) {
    if (!event.data) return;
    const { type, id } = event.data;
    if (type === 'metacom:connect') {
      this.attach(event.ports[0], {
        ...event.data,
        clientId: event.source?.id ?? '',
      });
    } else if (type === 'metacom:ping') {
      const port = this.port(id);
      if (port) {
        port.postMessage({ type: 'metacom:pong', instance: this.instance });
      } else {
        event.source?.postMessage({ type: 'metacom:reset' });
      }
    } else if (type === 'metacom:disconnect') {
      this.detach(id);
    } else if (type === 'metacom:online') {
      Metacom.online();
    } else if (type === 'metacom:offline') {
      Metacom.offline();
    }
  }

  receive(port, data) {
    if (data?.type !== 'metacom:disconnect') {
      return void super.receive(port, data);
    }
    if (this.port(data.id) === port) this.detach(data.id);
  }

  close() {
    this.#scope.removeEventListener?.('message', this.#listener);
    super.close();
  }
}

export {
  startInterval,
  parseMethod,
  encodeEvent,
  emitError,
  RtcConnection,
  retireRtcGeneration,
  RtcChannelEndpoint,
  ClientTransport,
  ClientWsTransport,
  ClientHttpTransport,
  ClientEventTransport,
  ClientRtcTransport,
  TRANSPORTS,
  ClientRtcBridgeTransport,
  MetacomRtcBridge,
  chunkEncode,
  chunkDecode,
  MetaReadable,
  MetaWritable,
  isStreamMeta,
  Metacom,
  MetacomError,
  MetacomRouter,
  MetacomPeer,
  MetacomProxy,
};
