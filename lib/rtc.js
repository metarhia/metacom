'use strict';

const { Emitter, generateUUID } = require('metautil');

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

module.exports = { RtcConnection, retireRtcGeneration };
