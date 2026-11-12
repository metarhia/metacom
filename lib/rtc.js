'use strict';

const { Emitter, generateUUID } = require('metautil');

const RTC_PROTOCOL = 'metacom:rtc';
const RTC_VERSION = 1;
const RTC_TIMEOUT_MS = 10000;
const RTC_MAX_CANDIDATES = 256;

// One negotiation generation owns all its listeners and asynchronous work.
class RtcConnection extends Emitter {
  #attempt = null;
  #retired = new Set();

  get peerConnection() {
    return this.#attempt?.pc ?? null;
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
        this.#offer(attempt).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
    return attempt.promise;
  }

  async #send(attempt, body) {
    if (this.#attempt !== attempt) return;
    const { localId: source, peerId: target, signaling } = attempt.options;
    const generation = attempt.generation;
    const protocol = RTC_PROTOCOL;
    const version = RTC_VERSION;
    await signaling.send({
      protocol,
      version,
      source,
      target,
      generation,
      ...body,
    });
  }

  async #offer(attempt) {
    const description = await attempt.pc.createOffer();
    if (this.#attempt !== attempt) return;
    await attempt.pc.setLocalDescription(description);
    await this.#send(attempt, { description: attempt.pc.localDescription });
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
      await attempt.pc.setRemoteDescription(description);
      if (this.#attempt !== attempt) return;
      attempt.remote = true;
      for (const item of attempt.candidates) {
        await attempt.pc.addIceCandidate(item);
      }
      attempt.candidates = [];
      if (role === 'answerer') {
        const answer = await attempt.pc.createAnswer();
        if (this.#attempt !== attempt) return;
        await attempt.pc.setLocalDescription(answer);
        await this.#send(attempt, { description: attempt.pc.localDescription });
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
      this.#retired.add(attempt.generation);
      if (this.#retired.size > 256) {
        this.#retired.delete(this.#retired.values().next().value);
      }
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

module.exports = { RtcConnection };
