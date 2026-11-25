'use strict';

const { Emitter, generateUUID } = require('metautil');

const { TEXT_ENCODER, Waiters, isId } = require('./utils.js');
const { startInterval, watchWorker } = require('./utils.js');
const { retireRtcGeneration } = require('./rtc.js');
const { ClientTransport, ClientRtcTransport } = require('./client.js');
const { TRANSPORTS } = require('./client.js');

const RTC_BRIDGE_PROTOCOL = 'metacom:rtc-bridge';
const RTC_BRIDGE_VERSION = 1;
const RTC_BRIDGE_HANDSHAKE_MS = 15000;
const RTC_BRIDGE_PING_MS = 1000;
const RTC_BRIDGE_PONG_MS = 5000;
const RTC_BRIDGE_MAX_BYTES = 16 * 1024 * 1024;
const RTC_BRIDGE_QUEUE_BYTES = 32 * 1024 * 1024;
const RTC_BRIDGE_QUEUE_LIMIT = 1024;

const rtcBridgeSize = (data) => {
  if (typeof data === 'string') return TEXT_ENCODER.encode(data).length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new TypeError('Invalid RTC bridge packet');
};

// Sender may reuse its buffer after write returns
const copyBytes = (view) => {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return bytes.slice();
};

const rtcBridgeMessage = (generation, kind, body = {}) => ({
  protocol: RTC_BRIDGE_PROTOCOL,
  version: RTC_BRIDGE_VERSION,
  generation,
  kind,
  ...body,
});

const isRtcBridgeMessage = (data, generation) => {
  const protocol = data?.protocol === RTC_BRIDGE_PROTOCOL;
  const sameGeneration = data?.generation === generation;
  return protocol && sameGeneration;
};

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
  #waiters = new Waiters();
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
    const oversized = bytes > RTC_BRIDGE_MAX_BYTES;
    const queued = this.#bytes + bytes > RTC_BRIDGE_QUEUE_BYTES;
    const full = this.#queue.length >= RTC_BRIDGE_QUEUE_LIMIT;
    if (oversized || queued || full) {
      throw new RangeError('RTC bridge queue limit exceeded');
    }
    const isText = typeof packet === 'string';
    const copy = isText ? packet : copyBytes(packet);
    this.#queue.push({ packet: copy, bytes });
    this.#bytes += bytes;
    this.#flush();
    return false;
  }

  #flush() {
    if (this.closed || this.#inflight) return;
    const next = this.#queue.shift();
    if (!next) return void this.#waiters.release();
    const packet = next.packet;
    const bytes = next.bytes;
    const sequence = ++this.#sequence;
    this.#inflight = { packet, bytes, sequence };
    this.post('data', { packet, sequence });
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
      const busy = this.#receiving;
      const outOfOrder = data.sequence !== this.#received + 1;
      const blocked = busy || outOfOrder;
      const size = blocked ? 0 : rtcBridgeSize(data.packet);
      if (blocked || size > RTC_BRIDGE_MAX_BYTES) {
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
    const isIdle = !this.#inflight && this.#queue.length === 0;
    if (this.closed || isIdle) return Promise.resolve();
    return this.#waiters.wait();
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
    this.#waiters.release();
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
    const hasClients = Boolean(scope?.clients);
    const hasLocation = Boolean(scope?.location);
    const authorize = typeof options.bridge?.authorize === 'function';
    if (!hasClients || !hasLocation || !authorize) {
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
    const badVersion = data.version !== RTC_BRIDGE_VERSION;
    const missingGeneration = !isId(generation);
    const retired = this.#retired.has(generation);
    const badPeer = data.peerId !== this.#options.peerId;
    const rejected =
      badVersion || missingGeneration || retired || badPeer || !controlled;
    const origin = rejected ? '' : new URL(source.url).origin;
    const badSource = !rejected && origin !== expectedOrigin;
    if (rejected || badSource || wrongOrigin) {
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
      const badVersion = message.version !== RTC_BRIDGE_VERSION;
      const badInstance = message.instance !== this.#instance;
      const badPeer = message.peerId !== this.#options.peerId;
      if (badVersion || badInstance || badPeer) {
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
  #unwatch;
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
    const container = globalThis.navigator?.serviceWorker;
    const onMessage = ({ data }) => {
      const reset = data?.type === 'metacom:rtc-bridge:reset';
      const current = reset && data.generation === this.#generation;
      if (current) this.close(new Error('RTC bridge worker restarted'));
    };
    const onControllerChange = () => {
      const { controller } = container;
      if (controller && controller !== worker) {
        this.close(new Error('RTC bridge controller replaced'));
      }
    };
    const onPageHide = () => this.close();
    const handlers = { onMessage, onControllerChange, onPageHide };
    this.#unwatch = watchWorker(container, handlers);
    const timeout = rtcOptions.handshakeTimeout ?? RTC_BRIDGE_HANDSHAKE_MS;
    const onTimeout = () => {
      this.close(new Error('RTC bridge handshake timeout'));
    };
    this.#timer = setTimeout(onTimeout, timeout);
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
    const { kind } = data;
    if (kind === 'error') throw new Error(data.message);
    if (kind === 'accepted') await this.#accepted(data);
    else if (kind === 'ready-ack') this.#readyAck(data);
    else if (kind === 'pong') this.#pong(data);
  }

  // Worker took the port: connect the peer, then report ready
  async #accepted(data) {
    const linked = Boolean(this.#link);
    const badPeer = data.peerId !== this.#rtc.peerId;
    const badInstance = typeof data.instance !== 'string';
    if (linked || badPeer || badInstance) {
      throw new Error('Invalid RTC bridge acceptance');
    }
    this.#instance = data.instance;
    const transport = this.#transport;
    const deliver = async (packet) => {
      if (!transport.write(packet)) await transport.drain();
    };
    const link = new RtcBridgeLink(this.#port, this.#generation, deliver);
    this.#link = link;
    const onDisconnect = () => {
      this.close(new Error('RTC bridge peer disconnected'));
    };
    link.on('close', (error) => this.close(error));
    transport.on('message', (packet) => link.write(packet));
    transport.on('close', onDisconnect);
    await transport.open({ rtc: this.#rtc });
    if (this.closed) return;
    const { peerId } = this.#rtc;
    link.post('ready', { instance: this.#instance, peerId });
  }

  #readyAck(data) {
    this.#checkInstance(data);
    clearTimeout(this.#timer);
    this.#lastPong = Date.now();
    this.#resolve();
    const pongTimeout = this.#rtc.pongTimeout ?? RTC_BRIDGE_PONG_MS;
    const pingInterval = this.#rtc.pingInterval ?? RTC_BRIDGE_PING_MS;
    const ping = rtcBridgeMessage(this.#generation, 'ping');
    const beat = () => {
      if (Date.now() - this.#lastPong > pongTimeout) {
        const error = new Error('RTC bridge worker heartbeat timeout');
        return void this.close(error);
      }
      this.#worker.postMessage(ping);
    };
    this.#heartbeat = startInterval(beat, pingInterval);
  }

  #pong(data) {
    this.#checkInstance(data);
    this.#lastPong = Date.now();
  }

  #checkInstance(data) {
    if (data.instance === this.#instance) return;
    throw new Error('RTC bridge worker changed');
  }

  close(error = new Error('RTC bridge owner closed')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#heartbeat);
    this.#unwatch();
    this.#port.removeEventListener('message', this.#onPort);
    this.#link?.close(error);
    this.#transport.close();
    this.#port.close();
    this.#reject(error);
  }
}

TRANSPORTS['rtc-bridge'] = ClientRtcBridgeTransport;

module.exports = { ClientRtcBridgeTransport, MetacomRtcBridge };
