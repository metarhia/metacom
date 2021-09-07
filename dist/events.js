export class EventEmitter {
  constructor() {
    this.events = new Map();
    this.maxListenersCount = 10;
  }

  getMaxListeners() {
    return this.maxListenersCount;
  }

  listenerCount(name) {
    const event = this.events.get(name);
    if (event) return event.size;
    return 0;
  }

  on(name, fn) {
    const event = this.events.get(name);
    if (event) event.add(fn);
    else this.events.set(name, new Set([fn]));
  }

  once(name, fn) {
    const wrapper = (...args) => {
      this.remove(name, wrapper);
      return fn(...args);
    };
    this.on(name, wrapper);
  }

  emit(name, ...args) {
    const event = this.events.get(name);
    if (!event) return;
    for (const fn of event.values()) {
      fn(...args);
    }
  }

  remove(name, fn) {
    const event = this.events.get(name);
    if (!event) return;
    if (event.has(fn)) {
      event.delete(fn);
    }
  }

  clear(name) {
    if (name) this.events.delete(name);
    else this.events.clear();
  }
}
