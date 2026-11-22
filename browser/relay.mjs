import { RtcConnection } from './metacom.mjs';

import { broadcastSignaling } from './signaling.mjs';

const MEDIA_SLOTS = [
  { slot: 'mic', kind: 'audio' },
  { slot: 'camera', kind: 'video' },
  { slot: 'screen', kind: 'video' },
  { slot: 'screenAudio', kind: 'audio' },
  { slot: 'relayAudio', kind: 'audio' },
  { slot: 'relayVideo', kind: 'video' },
];

const createLink = () => {
  const connection = new RtcConnection();
  const tracks = new Map();
  connection.on('track', ({ slot, track }) => tracks.set(slot, track));
  return { connection, tracks };
};

const createSource = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const drawing = canvas.getContext('2d');
  const camera = canvas.captureStream(10).getVideoTracks()[0];
  let isRed = false;
  const timer = setInterval(() => {
    isRed = !isRed;
    drawing.fillStyle = isRed ? 'red' : 'blue';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);

  const audio = new globalThis.AudioContext();
  const output = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  const analyser = audio.createAnalyser();
  oscillator.connect(analyser).connect(output);
  oscillator.start();
  const mic = output.stream.getAudioTracks()[0];
  const waveform = new Float32Array(analyser.fftSize);
  const audioPeak = () => {
    analyser.getFloatTimeDomainData(waveform);
    let peak = 0;
    for (const sample of waveform) peak = Math.max(peak, Math.abs(sample));
    return peak;
  };
  const close = async () => {
    clearInterval(timer);
    camera.stop();
    mic.stop();
    oscillator.stop();
    await audio.close();
  };
  return { camera, mic, audio, close, audioPeak };
};

const attachAudio = (track, volume) => {
  const audio = document.createElement('audio');
  audio.volume = volume;
  audio.srcObject = new globalThis.MediaStream([track]);
  document.body.append(audio);
  return audio;
};

const detachAudio = (audio) => {
  audio.srcObject = null;
  audio.remove();
};

const watchMedia = (tracks) => {
  const video = document.createElement('video');
  video.muted = true;
  const videoTrack = tracks.get('relayVideo');
  video.srcObject = new globalThis.MediaStream([videoTrack]);
  document.body.append(video);

  const audio = attachAudio(tracks.get('relayAudio'), 1);

  let frames = 0;
  let callbackId = 0;
  const count = () => {
    frames++;
    callbackId = video.requestVideoFrameCallback(count);
  };
  callbackId = video.requestVideoFrameCallback(count);
  const close = () => {
    video.cancelVideoFrameCallback(callbackId);
    video.srcObject = null;
    video.remove();
    detachAudio(audio);
  };
  return { video, audio, close, frames: () => frames };
};

const readInbound = async (connection, slot) => {
  const stats = await connection.receiver(slot).getStats();
  for (const entry of stats.values()) {
    if (entry.type === 'inbound-rtp') return entry;
  }
  return null;
};

const createRelayLab = () => {
  const signaling = broadcastSignaling('metacom-browser-relay');
  const links = new Map();
  let source = null;
  let micPlayback = null;
  let playback = null;

  return {
    async open(localId, peerId, role) {
      const link = links.get(peerId) ?? createLink();
      links.set(peerId, link);
      await link.connection.open({
        localId,
        peerId,
        role,
        signaling,
        configuration: { iceServers: [] },
        media: MEDIA_SLOTS,
      });
    },
    closeLink(peerId) {
      const { connection, tracks } = links.get(peerId);
      connection.close();
      tracks.clear();
    },
    async publish(peerId) {
      const { connection } = links.get(peerId);
      source = createSource();
      await source.audio.resume();
      await connection.setTrack('mic', source.mic);
      await connection.setTrack('camera', source.camera);
    },
    sourceAudio() {
      return { state: source.audio.state, peak: source.audioPeak() };
    },
    async playMic(peerId) {
      const { tracks } = links.get(peerId);
      micPlayback = attachAudio(tracks.get('mic'), 0);
      await micPlayback.play();
    },
    async forward(sourceId, sinkId) {
      const { tracks } = links.get(sourceId);
      const { connection } = links.get(sinkId);
      await connection.setTrack('relayAudio', tracks.get('mic'));
      await connection.setTrack('relayVideo', tracks.get('camera'));
    },
    async clear(peerId) {
      const { connection } = links.get(peerId);
      await connection.setTrack('relayAudio', null);
      await connection.setTrack('relayVideo', null);
    },
    async watch(peerId) {
      const { tracks } = links.get(peerId);
      playback?.close();
      playback = watchMedia(tracks);
      await Promise.all([playback.audio.play(), playback.video.play()]);
    },
    async sample(peerId, audioSlot, videoSlot) {
      const { connection } = links.get(peerId);
      const audio = await readInbound(connection, audioSlot);
      const video = await readInbound(connection, videoSlot);
      const receiver = connection.receiver(audioSlot);
      const sources = receiver.getSynchronizationSources();
      let audioLevel = 0;
      for (const source of sources) {
        audioLevel = Math.max(audioLevel, source.audioLevel ?? 0);
      }
      return {
        frames: playback?.frames() ?? 0,
        audioPackets: audio?.packetsReceived ?? 0,
        audioLevel,
        audioEnergy: audio?.totalAudioEnergy ?? 0,
        audioSamples: audio?.jitterBufferEmittedCount ?? 0,
        videoPackets: video?.packetsReceived ?? 0,
      };
    },
    async close() {
      if (micPlayback) {
        detachAudio(micPlayback);
        micPlayback = null;
      }
      for (const { connection } of links.values()) connection.close();
      links.clear();
      signaling.close();
      playback?.close();
      playback = null;
      await source?.close();
      source = null;
    },
  };
};

export { createRelayLab };
