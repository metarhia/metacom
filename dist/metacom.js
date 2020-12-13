const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomInterface {
  constructor() {
    this._events = new Map();
  }

  on(name, fn) {
    const event = this._events.get(name);
    if (event) event.add(fn);
    else this._events.set(name, new Set([fn]));
  }

  emit(name, ...args) {
    const event = this._events.get(name);
    if (!event) return;
    for (const fn of event.values()) fn(...args);
  }
}

export class Metacom {
  constructor(url, options = {}) {
    this.url = url;
    this.socket = null;
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.active = true;
    this.lastActivity = new Date().getTime();
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.open();
  }

  async open() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    this.active = true;
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('message', ({ data }) => {
      this.message(data);
    });

    this.socket.addEventListener('close', () => {
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });

    this.socket.addEventListener('error', () => {
      this.socket.close();
    });

    setInterval(() => {
      if (this.active) {
        const interval = new Date().getTime() - this.lastActivity;
        if (interval > this.pingInterval) this.send('{}');
      }
    }, this.pingInterval);

    return new Promise(resolve => {
      this.socket.addEventListener('open', resolve, { once: true });
    });
  }

  close() {
    this.active = false;
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  message(data) {
    if (data === '{}') return;
    this.lastActivity = new Date().getTime();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch (err) {
      console.error(err);
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      if (callType === 'callback') {
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        if (packet.error) {
          reject(new MetacomError(packet.error));
          return;
        }
        resolve(args);
        return;
      }
      if (callType === 'event') {
        const [interfaceName, eventName] = target.split('/');
        const metacomInterface = this.api[interfaceName];
        metacomInterface.emit(eventName, args);
      }
    }
  }

  async load(...interfaces) {
    const introspect = this.scaffold('system')('introspect');
    const introspection = await introspect(interfaces);
    const available = Object.keys(introspection);
    for (const interfaceName of interfaces) {
      if (!available.includes(interfaceName)) continue;
      const methods = new MetacomInterface();
      const iface = introspection[interfaceName];
      const request = this.scaffold(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[interfaceName] = methods;
    }
  }

  scaffold(iname, ver) {
    return methodName => async (args = {}) => {
      const callId = ++this.callId;
      const interfaceName = ver ? `${iname}.${ver}` : iname;
      const target = interfaceName + '/' + methodName;
      await this.open();
      return new Promise((resolve, reject) => {
        this.calls.set(callId, [resolve, reject]);
        const packet = { call: callId, [target]: args };
        this.send(JSON.stringify(packet));
      });
    };
  }

  send(data) {
    this.lastActivity = new Date().getTime();
    this.socket.send(data);
  }
}
