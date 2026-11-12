'use strict';

const { Emitter, generateUUID } = require('metautil');
const {
  ClientTransport,
  ClientRtcTransport,
  TRANSPORTS,
} = require('./client.js');

const RTC_BRIDGE_PROTOCOL = 'metacom:rtc-bridge';
const RTC_BRIDGE_MAX_BYTES = 16 * 1024 * 1024;
const RTC_BRIDGE_QUEUE_BYTES = 32 * 1024 * 1024;
const RTC_BRIDGE_ENCODER = new TextEncoder();

const rtcBridgeSize = (data) => {
  if (typeof data === 'string') return RTC_BRIDGE_ENCODER.encode(data).length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new TypeError('Invalid RTC bridge packet');
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
  #waiters = [];
  closed = false;

  constructor(port, generation, deliver) {
    super();
    this.#port = port;
    this.#generation = generation;
    this.#deliver = deliver;
    this.#listener = ({ data }) => {
      if (
        data?.protocol !== RTC_BRIDGE_PROTOCOL ||
        data.generation !== generation
      ) {
        return;
      }
      this.#receive(data).catch((error) => this.close(error));
    };
    port.addEventListener('message', this.#listener);
    port.start();
  }

  post(kind, body = {}) {
    if (this.closed) return;
    this.#port.postMessage({
      protocol: RTC_BRIDGE_PROTOCOL,
      version: 1,
      generation: this.#generation,
      kind,
      ...body,
    });
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
    if (data.version !== 1) throw new Error('RTC bridge version mismatch');
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
  static capabilities = { duplex: true, streams: true, events: true };
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
          port?.postMessage({
            protocol: RTC_BRIDGE_PROTOCOL,
            version: 1,
            generation: event.data?.generation,
            kind: 'error',
            message: error.message,
          });
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
      options.bridge.handshakeTimeout ?? 15000,
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
      data.version !== 1 ||
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
      if (
        message?.protocol !== RTC_BRIDGE_PROTOCOL ||
        message.generation !== generation ||
        message.kind !== 'ready'
      ) {
        return;
      }
      port.removeEventListener('message', handshake);
      if (
        message.version !== 1 ||
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
      this.#heartbeat = setInterval(() => {
        if (Date.now() - this.#lastPing > (this.#options.pongTimeout ?? 5000)) {
          this.#release(new Error('RTC bridge owner heartbeat timeout'));
        }
      }, this.#options.pingInterval ?? 1000);
      this.#heartbeat.unref?.();
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
    if (this.#generation) this.#retired.add(this.#generation);
    if (this.#retired.size > 256) {
      this.#retired.delete(this.#retired.values().next().value);
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
      if (
        data?.protocol !== RTC_BRIDGE_PROTOCOL ||
        data.generation !== this.#generation
      ) {
        return;
      }
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
      rtcOptions.handshakeTimeout ?? 15000,
    );
    try {
      worker.postMessage(
        {
          protocol: RTC_BRIDGE_PROTOCOL,
          version: 1,
          kind: 'attach',
          generation: this.#generation,
          peerId: rtcOptions.peerId,
          localId: rtcOptions.localId,
        },
        [port2],
      );
    } catch (error) {
      this.close(error);
    }
  }

  async #receive(data) {
    if (this.closed) return;
    if (data.version !== 1) throw new Error('RTC bridge version mismatch');
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
      this.#heartbeat = setInterval(() => {
        if (Date.now() - this.#lastPong > (this.#rtc.pongTimeout ?? 5000)) {
          return void this.close(
            new Error('RTC bridge worker heartbeat timeout'),
          );
        }
        this.#worker.postMessage({
          protocol: RTC_BRIDGE_PROTOCOL,
          version: 1,
          kind: 'ping',
          generation: this.#generation,
        });
      }, this.#rtc.pingInterval ?? 1000);
      this.#heartbeat.unref?.();
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

module.exports = { ClientRtcBridgeTransport, MetacomRtcBridge };
