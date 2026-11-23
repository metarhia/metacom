'use strict';

class RtcTarget {
  listeners = new Map();

  addEventListener(name, listener) {
    const found = this.listeners.get(name);
    const listeners = found ?? [];
    if (listeners.includes(listener)) return;
    listeners.push(listener);
    if (!found) this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index === -1) return;
    listeners.splice(index, 1);
  }

  dispatch(name, data = {}) {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    const snapshot = listeners.slice();
    for (const listener of snapshot) listener(data);
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

const SDP_MID = 'a=mid:';

const mockPeerId = (sdp) => {
  const splitAt = sdp.indexOf('\n');
  const line = splitAt === -1 ? sdp : sdp.slice(0, splitAt);
  return line.trim();
};

const mockSdpSections = (sdp) => {
  const sections = [];
  let kind = '';
  const lines = sdp.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('m=')) {
      const header = line.slice(2);
      const space = header.indexOf(' ');
      kind = space === -1 ? header : header.slice(0, space);
    } else if (kind && line.startsWith(SDP_MID)) {
      const mid = line.slice(SDP_MID.length);
      sections.push({ kind, mid });
      kind = '';
    }
  }
  return sections;
};

class RtcMockPeer extends RtcTarget {
  static peers = new Map();
  static sequence = 0;
  id = `${++RtcMockPeer.sequence}`;
  candidates = [];
  sctp = { maxMessageSize: 65536 };
  transceivers = [];

  constructor() {
    super();
    RtcMockPeer.peers.set(this.id, this);
  }

  createDataChannel() {
    this.channel = new RtcMockChannel();
    return this.channel;
  }

  addTransceiver(kind, init) {
    const direction = init?.direction ?? 'sendrecv';
    const sender = {
      track: null,
      replaced: [],
      parameters: {},
      async replaceTrack(track) {
        this.track = track;
        this.replaced.push(track);
      },
      getParameters() {
        return this.parameters;
      },
      async setParameters(parameters) {
        this.parameters = parameters;
      },
    };
    const track = {
      kind,
      id: `${kind}-${this.transceivers.length}`,
      muted: false,
    };
    const receiver = { track };
    const transceiver = {
      mid: null,
      kind,
      direction,
      sender,
      receiver,
      codecPreferences: null,
      setCodecPreferences(codecs) {
        this.codecPreferences = codecs;
      },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  emitTracks() {
    const list = this.transceivers;
    for (let i = 0; i < list.length; i++) {
      const transceiver = list[i];
      const track = transceiver.receiver.track;
      this.dispatch('track', { transceiver, track });
    }
  }

  async createOffer() {
    return { type: 'offer', sdp: this.id };
  }

  async createAnswer() {
    return { type: 'answer', sdp: this.id };
  }

  async setLocalDescription(value) {
    if (!this.transceivers.length) {
      this.localDescription = { ...value, toJSON: () => value };
      return;
    }
    const lines = [this.id];
    for (let i = 0; i < this.transceivers.length; i++) {
      const transceiver = this.transceivers[i];
      const mid = `${i}`;
      transceiver.mid = mid;
      lines.push(`m=${transceiver.kind} 9 UDP/TLS/RTP/SAVPF`);
      lines.push(`a=mid:${mid}`);
    }
    const dataMid = `${this.transceivers.length}`;
    lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    lines.push(`a=mid:${dataMid}`);
    const sdp = lines.join('\n');
    const description = { type: value.type, sdp };
    this.localDescription = { ...description, toJSON: () => description };
  }

  async setRemoteDescription(value) {
    this.remoteDescription = value;
    if (value.type === 'offer') {
      const remoteId = mockPeerId(value.sdp);
      this.remote = RtcMockPeer.peers.get(remoteId);
      this.channel = new RtcMockChannel();
      this.channel.other = this.remote.channel;
      this.remote.channel.other = this.channel;
      const sections = mockSdpSections(value.sdp);
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (section.kind === 'application') continue;
        const transceiver = this.addTransceiver(section.kind, {
          direction: 'recvonly',
        });
        transceiver.mid = section.mid;
      }
      this.dispatch('datachannel', { channel: this.channel });
      this.emitTracks();
      return;
    }
    this.channel.open();
    this.channel.other.open();
    this.emitTracks();
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
      message = structuredClone(message);
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
  handshakeTimeout: 2000,
});

module.exports = {
  RtcTarget,
  RtcMockChannel,
  RtcMockPeer,
  rtcSignals,
  rtcOptions,
};
