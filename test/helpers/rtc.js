'use strict';

class RtcTarget {
  listeners = new Map();

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, data = {}) {
    const listeners = this.listeners.get(name) ?? [];
    for (const listener of [...listeners]) {
      listener(data);
    }
  }
}

class RtcMockChannel extends RtcTarget {
  label = 'metacom';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = 'connecting';
  bufferedAmount = 0;
  sent = [];

  open() {
    this.readyState = 'open';
    this.dispatch('open');
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('Channel closed');
    this.sent.push(data);
    const copy = typeof data === 'string' ? data : data.slice();
    if (this.other) {
      queueMicrotask(() => {
        if (this.other.readyState === 'open') {
          this.other.dispatch('message', { data: copy });
        }
      });
    }
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatch('close');
    this.other?.close();
  }
}

class RtcMockPeer extends RtcTarget {
  static peers = new Map();
  static sequence = 0;
  id = `${++RtcMockPeer.sequence}`;
  candidates = [];
  sctp = { maxMessageSize: 65536 };

  constructor() {
    super();
    RtcMockPeer.peers.set(this.id, this);
  }

  createDataChannel() {
    this.channel = new RtcMockChannel();
    return this.channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: this.id };
  }

  async createAnswer() {
    return { type: 'answer', sdp: this.id };
  }

  async setLocalDescription(value) {
    this.localDescription = value;
  }

  async setRemoteDescription(value) {
    this.remoteDescription = value;
    if (value.type === 'offer') {
      this.remote = RtcMockPeer.peers.get(value.sdp);
      this.channel = new RtcMockChannel();
      this.channel.other = this.remote.channel;
      this.remote.channel.other = this.channel;
      this.dispatch('datachannel', { channel: this.channel });
    } else {
      this.channel.open();
      this.channel.other.open();
    }
  }

  async addIceCandidate(value) {
    this.candidates.push(value);
  }

  close() {
    this.connectionState = 'closed';
    this.channel?.close();
    RtcMockPeer.peers.delete(this.id);
  }
}

const rtcSignals = () => {
  const listeners = new Set();
  const messages = [];
  return {
    listeners,
    messages,
    send(message) {
      messages.push(message);
      for (const listener of listeners) queueMicrotask(() => listener(message));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const rtcOptions = (signaling, role = 'offerer') => ({
  localId: role === 'offerer' ? 'caller' : 'host',
  peerId: role === 'offerer' ? 'host' : 'caller',
  role,
  signaling,
  handshakeTimeout: 100,
});

module.exports = {
  RtcTarget,
  RtcMockChannel,
  RtcMockPeer,
  rtcSignals,
  rtcOptions,
};
