// Copyright (c) 2018-2025 Metarhia contributors
// Version 3.2.6 metacom MIT License

var metacomIIFE = (function (exports) {
  //#region metautil
  // Copyright (c) 2017-2025 Metarhia contributors (full list in AUTHORS file)
  // Version 5.4.0 metautil MIT License

  //#region error.js

  class Error extends globalThis.Error {
    constructor(message, options = {}) {
      super(message);
      const hasOptions = typeof options === 'object';
      const { code, cause } = hasOptions ? options : { code: options };
      this.code = code;
      this.cause = cause;
    }
  }

  class DomainError extends Error {
    constructor(code, options = {}) {
      const hasCode = typeof code !== 'object';
      const opt = hasCode ? { ...options, code } : code;
      super('Domain error', opt);
    }

    toError(errors) {
      const { code, cause } = this;
      const message = errors[this.code] || this.message;
      return new Error(message, { code, cause });
    }
  }

  const isError = (err) => err?.constructor?.name?.includes('Error') || false;

  ((exports.Error = Error),
    (exports.DomainError = DomainError),
    (exports.isError = isError));
  //#endregion

  //#region strings.js

  const replace = (str, substr, newstr) => {
    if (substr === '') return str;
    let src = str;
    let res = '';
    do {
      const index = src.indexOf(substr);
      if (index === -1) return res + src;
      const start = src.substring(0, index);
      src = src.substring(index + substr.length, src.length);
      res += start + newstr;
    } while (true);
  };

  const between = (s, prefix, suffix) => {
    let i = s.indexOf(prefix);
    if (i === -1) return '';
    s = s.substring(i + prefix.length);
    if (suffix) {
      i = s.indexOf(suffix);
      if (i === -1) return '';
      s = s.substring(0, i);
    }
    return s;
  };

  const split = (s, separator) => {
    const i = s.indexOf(separator);
    if (i < 0) return [s, ''];
    return [s.slice(0, i), s.slice(i + separator.length)];
  };

  const inRange = (x, min, max) => x >= min && x <= max;

  const isFirstUpper = (s) => !!s && inRange(s[0], 'A', 'Z');

  const isFirstLower = (s) => !!s && inRange(s[0], 'a', 'z');

  const isFirstLetter = (s) => isFirstUpper(s) || isFirstLower(s);

  const toLowerCamel = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  const toUpperCamel = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const toLower = (s) => s.toLowerCase();

  const toCamel = (separator) => (s) => {
    const words = s.split(separator);
    const first = words.length > 0 ? words.shift().toLowerCase() : '';
    return first + words.map(toLower).map(toUpperCamel).join('');
  };

  const spinalToCamel = toCamel('-');

  const snakeToCamel = toCamel('_');

  const isConstant = (s) => s === s.toUpperCase();

  const fileExt = (fileName) => {
    const dot = fileName.lastIndexOf('.');
    const slash = fileName.lastIndexOf('/');
    if (slash > dot) return '';
    return fileName.substring(dot + 1, fileName.length).toLowerCase();
  };

  const trimLines = (s) => {
    const chunks = s.split('\n').map((d) => d.trim());
    return chunks.filter((d) => d !== '').join('\n');
  };

  ((exports.replace = replace),
    (exports.between = between),
    (exports.split = split),
    (exports.isFirstUpper = isFirstUpper),
    (exports.isFirstLower = isFirstLower),
    (exports.isFirstLetter = isFirstLetter),
    (exports.toLowerCamel = toLowerCamel),
    (exports.toUpperCamel = toUpperCamel),
    (exports.toLower = toLower),
    (exports.toCamel = toCamel),
    (exports.spinalToCamel = spinalToCamel),
    (exports.snakeToCamel = snakeToCamel),
    (exports.isConstant = isConstant),
    (exports.fileExt = fileExt),
    (exports.trimLines = trimLines));
  //#endregion

  //#region array.js

  const sample = (array, random = Math.random) => {
    const index = Math.floor(random() * array.length);
    return array[index];
  };

  const shuffle = (array, random = Math.random) => {
    // Based on the algorithm described here:
    // https://en.wikipedia.org/wiki/Fisher-Yates_shuffle
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  const projection = (source, fields) => {
    const entries = [];
    for (const key of fields) {
      if (Object.hasOwn(source, key)) {
        const value = source[key];
        entries.push([key, value]);
      }
    }
    return Object.fromEntries(entries);
  };

  ((exports.sample = sample),
    (exports.shuffle = shuffle),
    (exports.projection = projection));
  //#endregion

  //#region async.js

  const toBool = [() => true, () => false];

  const timeout = (msec, signal = null) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout of ${msec}ms reached`, 'ETIMEOUT'));
      }, msec);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Timeout aborted'));
      });
    });

  const delay = (msec, signal = null) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, msec);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Delay aborted'));
      });
    });

  const timeoutify = (promise, msec) =>
    new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        timer = null;
        reject(new Error(`Timeout of ${msec}ms reached`, 'ETIMEOUT'));
      }, msec);
      promise.then(resolve, reject).finally(() => {
        if (timer) clearTimeout(timer);
      });
    });

  ((exports.toBool = toBool),
    (exports.timeout = timeout),
    (exports.delay = delay),
    (exports.timeoutify = timeoutify));
  //#endregion

  //#region datetime.js

  const DURATION_UNITS = {
    d: 86400, // days
    h: 3600, // hours
    m: 60, // minutes
    s: 1, // seconds
  };

  const duration = (s) => {
    if (typeof s === 'number') return s;
    if (typeof s !== 'string') return 0;
    let result = 0;
    const parts = s.split(' ');
    for (const part of parts) {
      const unit = part.slice(-1);
      const value = parseInt(part.slice(0, -1));
      const mult = DURATION_UNITS[unit];
      if (!isNaN(value) && mult) result += value * mult;
    }
    return result * 1000;
  };

  const twoDigit = (n) => {
    const s = n.toString();
    if (n < 10) return '0' + s;
    return s;
  };

  const nowDate = (date) => {
    if (!date) date = new Date();
    const yyyy = date.getUTCFullYear().toString();
    const mm = twoDigit(date.getUTCMonth() + 1);
    const dd = twoDigit(date.getUTCDate());
    return `${yyyy}-${mm}-${dd}`;
  };

  const nowDateTimeUTC = (date, timeSep = ':') => {
    if (!date) date = new Date();
    const yyyy = date.getUTCFullYear().toString();
    const mm = twoDigit(date.getUTCMonth() + 1);
    const dd = twoDigit(date.getUTCDate());
    const hh = twoDigit(date.getUTCHours());
    const min = twoDigit(date.getUTCMinutes());
    const ss = twoDigit(date.getUTCSeconds());
    return `${yyyy}-${mm}-${dd}T${hh}${timeSep}${min}${timeSep}${ss}`;
  };

  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const NAME_LEN = 3;

  const parseMonth = (s) => {
    const name = s.substring(0, NAME_LEN);
    const i = MONTHS.indexOf(name);
    return i >= 0 ? i + 1 : -1;
  };

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const parseDay = (s) => {
    const name = s.substring(0, NAME_LEN);
    const i = DAYS.indexOf(name);
    return i >= 0 ? i + 1 : -1;
  };

  const ORDINAL = ['st', 'nd', 'rd', 'th'];

  const isOrdinal = (s) => ORDINAL.some((d) => s.endsWith(d));

  const YEAR_LEN = 4;

  const parseEvery = (s = '') => {
    let YY = -1;
    let MM = -1;
    let DD = -1;
    let wd = -1;
    let hh = -1;
    let mm = -1;
    let ms = 0;
    const parts = s.split(' ');
    for (const part of parts) {
      if (part.includes(':')) {
        const [h, m] = split(part, ':');
        if (h !== '') hh = parseInt(h);
        mm = m === '' ? 0 : parseInt(m);
        continue;
      }
      if (isOrdinal(part)) {
        DD = parseInt(part);
        continue;
      }
      if (part.length === YEAR_LEN) {
        YY = parseInt(part);
        continue;
      }
      if (MM === -1) {
        MM = parseMonth(part);
        if (MM > -1) continue;
      }
      if (wd === -1) {
        wd = parseDay(part);
        if (wd > -1) continue;
      }
      const unit = part.slice(-1);
      const mult = DURATION_UNITS[unit];
      if (typeof mult === 'number') {
        const value = parseInt(part);
        if (!isNaN(value)) ms += value * mult;
      }
    }
    return { YY, MM, DD, wd, hh, mm, ms: ms > 0 ? ms * 1000 : -1 };
  };

  const nextEvent = (ev, d = new Date()) => {
    let ms = 0;
    const Y = d.getUTCFullYear();
    const M = d.getUTCMonth() + 1;
    const D = d.getUTCDate();
    const w = d.getUTCDay() + 1;
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();

    const iY = ev.YY > -1;
    const iM = ev.MM > -1;
    const iD = ev.DD > -1;
    const iw = ev.wd > -1;
    const ih = ev.hh > -1;
    const im = ev.mm > -1;
    const ims = ev.ms > -1;

    if (iY && (ev.YY < Y || ev.YY > Y)) return ev.YY < Y ? -1 : 0;
    if (iM && (ev.MM < M || ev.MM > M || ev.MM !== M))
      return ev.MM < M ? -1 : 0;
    if (iD && (ev.DD < D || ev.DD > D || ev.DD !== D))
      return ev.DD < D ? -1 : 0;
    if (iw && ev.wd !== w) return 0;
    if (ih && (ev.hh < h || (ev.hh === h && im && ev.mm < m))) return -1;

    if (ih) ms += (ev.hh - h) * DURATION_UNITS.h;
    if (im) ms += (ev.mm - m) * DURATION_UNITS.m;

    ms *= 1000;
    if (ims) ms += ev.ms;
    return ms;
  };

  ((exports.duration = duration),
    (exports.nowDate = nowDate),
    (exports.nowDateTimeUTC = nowDateTimeUTC),
    (exports.parseMonth = parseMonth),
    (exports.parseDay = parseDay),
    (exports.parseEvery = parseEvery),
    (exports.nextEvent = nextEvent));
  //#endregion

  //#region objects.js

  const makePrivate = (instance) => {
    const iface = {};
    const fields = Object.keys(instance);
    for (const fieldName of fields) {
      const field = instance[fieldName];
      if (isConstant(fieldName)) {
        iface[fieldName] = field;
      } else if (typeof field === 'function') {
        const bindedMethod = field.bind(instance);
        iface[fieldName] = bindedMethod;
        instance[fieldName] = bindedMethod;
      }
    }
    return iface;
  };

  const protect = (allowMixins, ...namespaces) => {
    for (const namespace of namespaces) {
      const names = Object.keys(namespace);
      for (const name of names) {
        const target = namespace[name];
        if (!allowMixins.includes(name)) Object.freeze(target);
      }
    }
  };

  const jsonParse = (buffer) => {
    if (buffer.length === 0) return null;
    try {
      return JSON.parse(buffer);
    } catch {
      return null;
    }
  };

  const isHashObject = (o) =>
    typeof o === 'object' && o !== null && !Array.isArray(o);

  const flatObject = (source, fields = []) => {
    const target = {};
    for (const [key, value] of Object.entries(source)) {
      if (!isHashObject(value)) {
        target[key] = value;
        continue;
      }
      if (fields.length > 0 && !fields.includes(key)) {
        target[key] = { ...value };
        continue;
      }
      for (const [childKey, childValue] of Object.entries(value)) {
        const combined = `${key}${toUpperCamel(childKey)}`;
        if (source[combined] !== undefined) {
          const error = `Can not combine keys: key "${combined}" already exists`;
          throw new Error(error);
        }
        target[combined] = childValue;
      }
    }
    return target;
  };

  const unflatObject = (source, fields) => {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
      const prefix = fields.find((name) => key.startsWith(name));
      if (prefix) {
        if (Object.prototype.hasOwnProperty.call(source, prefix)) {
          throw new Error(
            `Can not combine keys: key "${prefix}" already exists`,
          );
        }
        const newKey = key.substring(prefix.length).toLowerCase();
        const section = result[prefix];
        if (section) section[newKey] = value;
        else result[prefix] = { [newKey]: value };
        continue;
      }
      result[key] = value;
    }
    return result;
  };

  const getSignature = (method) => {
    const src = method.toString();
    const signature = between(src, '({', '})');
    if (signature === '') return [];
    return signature.split(',').map((s) => s.trim());
  };

  const namespaceByPath = (namespace, path) => {
    const [key, rest] = split(path, '.');
    const step = namespace[key];
    if (!step) return null;
    if (rest === '') return step;
    return namespaceByPath(step, rest);
  };

  const serializeArguments = (fields, args) => {
    if (!fields) return '';
    const data = {};
    for (const par of fields) {
      data[par] = args[par];
    }
    return JSON.stringify(data);
  };

  const firstKey = (obj) => Object.keys(obj).find(isFirstLetter);

  const isInstanceOf = (obj, constrName) =>
    obj?.constructor?.name === constrName;

  ((exports.makePrivate = makePrivate),
    (exports.protect = protect),
    (exports.jsonParse = jsonParse),
    (exports.isHashObject = isHashObject),
    (exports.flatObject = flatObject),
    (exports.unflatObject = unflatObject),
    (exports.getSignature = getSignature),
    (exports.namespaceByPath = namespaceByPath),
    (exports.serializeArguments = serializeArguments),
    (exports.firstKey = firstKey),
    (exports.isInstanceOf = isInstanceOf));
  //#endregion

  //#region collector.js

  class Collector {
    done = false;
    data = {};
    keys = [];
    count = 0;
    exact = true;
    reassign = true;
    timeout = 0;
    defaults = {};
    validate = null;
    #fulfill = null;
    #reject = null;
    #cause = null;
    #controller = null;
    #signal = null;
    #timeout = null;

    constructor(keys, options = {}) {
      const { exact = true, reassign = false } = options;
      const { timeout = 0, defaults = {}, validate } = options;
      if (validate) this.validate = validate;
      this.keys = keys;
      if (exact === false) this.exact = false;
      if (reassign === false) this.reassign = reassign;
      if (typeof defaults === 'object') this.defaults = defaults;
      this.#controller = new AbortController();
      this.#signal = this.#controller.signal;
      if (typeof timeout === 'number' && timeout > 0) {
        this.#timeout = AbortSignal.timeout(timeout);
        this.#signal = AbortSignal.any([this.#signal, this.#timeout]);
        this.#signal.addEventListener('abort', () => {
          if (Object.keys(this.defaults).length > 0) this.#default();
          if (this.done) return;
          this.fail(this.#signal.reason);
        });
      }
    }

    #default() {
      for (const [key, value] of Object.entries(this.defaults)) {
        if (this.data[key] === undefined) this.set(key, value);
      }
    }

    get signal() {
      return this.#signal;
    }

    set(key, value) {
      if (this.done) return;
      const expected = this.keys.includes(key);
      if (!expected && this.exact) {
        this.fail(new Error('Unexpected key: ' + key));
        return;
      }
      const has = this.data[key] !== undefined;
      if (has && !this.reassign) {
        const error = new Error('Collector reassign mode is off');
        return void this.fail(error);
      }
      if (!has && expected) this.count++;
      this.data[key] = value;
      if (this.count === this.keys.length) {
        this.done = true;
        this.#timeout = null;
        if (this.#fulfill) this.#fulfill(this.data);
      }
    }

    take(key, fn, ...args) {
      fn(...args, (err, data) => {
        if (err) this.fail(err);
        else this.set(key, data);
      });
    }

    wait(key, fn, ...args) {
      const promise = fn instanceof Promise ? fn : fn(...args);
      promise.then(
        (data) => this.set(key, data),
        (err) => this.fail(err),
      );
    }

    collect(sources) {
      for (const [key, collector] of Object.entries(sources)) {
        collector.then(
          (data) => this.set(key, data),
          (err) => this.fail(err),
        );
      }
    }

    fail(error) {
      this.done = true;
      this.#timeout = null;
      const err = error || new Error('Collector aborted');
      this.#cause = err;
      this.#controller.abort();
      if (this.#reject) this.#reject(err);
    }

    abort() {
      this.fail();
    }

    then(onFulfilled, onRejected = null) {
      return new Promise((resolve, reject) => {
        this.#fulfill = resolve;
        this.#reject = reject;
        if (!this.done) return;
        if (this.validate) {
          try {
            this.validate(this.data);
          } catch (err) {
            this.#cause = err;
          }
        }
        if (this.#cause) reject(this.#cause);
        else resolve(this.data);
      }).then(onFulfilled, onRejected);
    }
  }

  const collect = (keys, options) => new Collector(keys, options);

  ((exports.Collector = Collector), (exports.collect = collect));
  //#endregion

  //#region events.js

  const DONE = { done: true, value: undefined };

  class EventIterator {
    #resolvers = [];
    #emitter = null;
    #eventName = '';
    #listener = null;
    #onerror = null;
    #done = false;

    constructor(emitter, eventName) {
      this.#emitter = emitter;
      this.#eventName = eventName;

      this.#listener = (value) => {
        for (const resolver of this.#resolvers) {
          resolver.resolve({ done: this.#done, value });
        }
      };
      emitter.on(eventName, this.#listener);

      this.#onerror = (error) => {
        for (const resolver of this.#resolvers) {
          resolver.reject(error);
        }
        this.#finalize();
      };
      emitter.on('error', this.#onerror);
    }

    next() {
      return new Promise((resolve, reject) => {
        if (this.#done) return void resolve(DONE);
        this.#resolvers.push({ resolve, reject });
      });
    }

    #finalize() {
      if (this.#done) return;
      this.#done = true;
      this.#emitter.off(this.#eventName, this.#listener);
      this.#emitter.off('error', this.#onerror);
      for (const resolver of this.#resolvers) {
        resolver.resolve(DONE);
      }
      this.#resolvers.length = 0;
    }

    async return() {
      this.#finalize();
      return DONE;
    }

    async throw() {
      this.#finalize();
      return DONE;
    }
  }

  class EventIterable {
    #emitter = null;
    #eventName = '';

    constructor(emitter, eventName) {
      this.#emitter = emitter;
      this.#eventName = eventName;
    }

    [Symbol.asyncIterator]() {
      return new EventIterator(this.#emitter, this.#eventName);
    }
  }

  class Emitter {
    #events = new Map();
    #maxListeners = 10;

    constructor(options = {}) {
      this.#maxListeners = options.maxListeners ?? 10;
    }

    emit(eventName, value) {
      const event = this.#events.get(eventName);
      if (!event) {
        if (eventName !== 'error') return Promise.resolve();
        throw new Error('Unhandled error');
      }
      const on = event.on.slice();
      const promises = on.map(async (fn) => fn(value));
      if (event.once.size > 0) {
        const len = event.on.length;
        const on = new Array(len);
        let index = 0;
        for (let i = 0; i < len; i++) {
          const listener = event.on[i];
          if (!event.once.has(listener)) on[index++] = listener;
        }
        if (index === 0) {
          this.#events.delete(eventName);
          return Promise.resolve();
        }
        on.length = index;
        this.#events.set(eventName, { on, once: new Set() });
      }
      return Promise.all(promises).then(() => undefined);
    }

    #addListener(eventName, listener, once) {
      let event = this.#events.get(eventName);
      if (!event) {
        const on = [listener];
        event = { on, once: once ? new Set(on) : new Set() };
        this.#events.set(eventName, event);
      } else {
        if (event.on.includes(listener)) {
          throw new Error('Duplicate listeners detected');
        }
        event.on.push(listener);
        if (once) event.once.add(listener);
      }
      if (event.on.length > this.#maxListeners) {
        throw new Error(
          `MaxListenersExceededWarning: Possible memory leak. ` +
            `Current maxListeners is ${this.#maxListeners}.`,
        );
      }
    }

    on(eventName, listener) {
      this.#addListener(eventName, listener, false);
    }

    once(eventName, listener) {
      this.#addListener(eventName, listener, true);
    }

    off(eventName, listener) {
      if (!listener) return void this.#events.delete(eventName);
      const event = this.#events.get(eventName);
      if (!event) return;
      const index = event.on.indexOf(listener);
      if (index > -1) event.on.splice(index, 1);
      event.once.delete(listener);
    }

    toPromise(eventName) {
      return new Promise((resolve) => {
        this.once(eventName, resolve);
      });
    }

    toAsyncIterable(eventName) {
      return new EventIterable(this, eventName);
    }

    clear(eventName) {
      if (!eventName) return void this.#events.clear();
      this.#events.delete(eventName);
    }

    listeners(eventName) {
      if (!eventName) throw new Error('Expected eventName');
      const event = this.#events.get(eventName);
      return event ? event.on : [];
    }

    listenerCount(eventName) {
      if (!eventName) throw new Error('Expected eventName');
      const event = this.#events.get(eventName);
      return event ? event.on.length : 0;
    }

    eventNames() {
      return Array.from(this.#events.keys());
    }
  }

  exports.Emitter = Emitter;
  //#endregion

  //#region http.js

  const parseHost = (host) => {
    if (!host) return 'no-host-name-in-http-headers';
    const portOffset = host.indexOf(':');
    if (portOffset > -1) host = host.substr(0, portOffset);
    return host;
  };

  const parseParams = (params) =>
    Object.fromEntries(new URLSearchParams(params));

  const parseCookies = (cookie) => {
    const values = [];
    const items = cookie.split(';');
    for (const item of items) {
      const [key, val = ''] = item.split('=');
      values.push([key.trim(), val.trim()]);
    }
    return Object.fromEntries(values);
  };

  const parseRange = (range) => {
    if (!range || !range.includes('=')) return {};
    const bytes = range.split('=').pop();
    if (!bytes || !range.includes('-')) return {};
    const [start, end] = bytes.split('-').map((n) => parseInt(n));
    if (isNaN(start)) return isNaN(end) ? {} : { tail: end };
    return isNaN(end) ? { start } : { start, end };
  };

  ((exports.parseHost = parseHost),
    (exports.parseParams = parseParams),
    (exports.parseCookies = parseCookies),
    (exports.parseRange = parseRange));
  //#endregion

  //#region pool.js

  class Pool {
    constructor(options = {}) {
      this.items = [];
      this.free = [];
      this.queue = [];
      this.timeout = options.timeout || 0;
      this.current = 0;
      this.size = 0;
      this.available = 0;
    }

    async next(exclusive = false) {
      if (this.size === 0) return null;
      if (this.available === 0) {
        return new Promise((resolve, reject) => {
          const waiting = { resolve, timer: null };
          waiting.timer = setTimeout(() => {
            waiting.resolve = null;
            this.queue.shift();
            reject(new Error('Pool next item timeout'));
          }, this.timeout);
          this.queue.push(waiting);
        });
      }
      let item = null;
      let free = false;
      do {
        item = this.items[this.current];
        free = this.free[this.current];
        this.current++;
        if (this.current === this.size) this.current = 0;
      } while (!item || !free);
      if (exclusive) {
        const index = this.items.indexOf(item);
        this.free[index] = false;
        this.available--;
      }
      return item;
    }

    add(item) {
      if (this.items.includes(item)) throw new Error('Pool: add duplicates');
      this.size++;
      this.available++;
      this.items.push(item);
      this.free.push(true);
    }

    async capture() {
      const item = await this.next(true);
      return item;
    }

    release(item) {
      const index = this.items.indexOf(item);
      if (index < 0) throw new Error('Pool: release unexpected item');
      if (this.free[index]) throw new Error('Pool: release not captured');
      if (this.queue.length > 0) {
        const { resolve, timer } = this.queue.shift();
        clearTimeout(timer);
        if (resolve) return void setTimeout(resolve, 0, item);
      }
      this.free[index] = true;
      this.available++;
    }

    isFree(item) {
      const index = this.items.indexOf(item);
      if (index < 0) return false;
      return this.free[index];
    }
  }

  exports.Pool = Pool;
  //#endregion

  //#region semaphore.js

  class Semaphore {
    constructor({ concurrency, size = 0, timeout = 0 }) {
      this.concurrency = concurrency;
      this.counter = concurrency;
      this.timeout = timeout;
      this.size = size;
      this.queue = [];
      this.empty = true;
    }

    async enter() {
      return new Promise((resolve, reject) => {
        if (this.counter > 0) {
          this.counter--;
          this.empty = false;
          return void resolve();
        }
        if (this.queue.length >= this.size) {
          return void reject(new Error('Semaphore queue is full'));
        }
        const waiting = { resolve, timer: null };
        waiting.timer = setTimeout(() => {
          waiting.resolve = null;
          this.queue.shift();
          const { counter, concurrency } = this;
          this.empty = this.queue.length === 0 && counter === concurrency;
          reject(new Error('Semaphore timeout'));
        }, this.timeout);
        this.queue.push(waiting);
        this.empty = false;
      });
    }

    leave() {
      if (this.queue.length === 0) {
        this.counter++;
        this.empty = this.counter === this.concurrency;
        return;
      }
      const { resolve, timer } = this.queue.shift();
      clearTimeout(timer);
      if (resolve) setTimeout(resolve, 0);
      const { counter, concurrency } = this;
      this.empty = this.queue.length === 0 && counter === concurrency;
    }
  }

  exports.Semaphore = Semaphore;
  //#endregion

  //#region units.js

  const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const bytesToSize = (bytes) => {
    if (bytes === 0) return '0';
    const exp = Math.floor(Math.log(bytes) / Math.log(1000));
    const size = bytes / 1000 ** exp;
    const short = Math.round(size);
    const unit = exp === 0 ? '' : ' ' + SIZE_UNITS[exp - 1];
    return short.toString() + unit;
  };

  const UNIT_SIZES = {
    yb: 24, // yottabyte
    zb: 21, // zettabyte
    eb: 18, // exabyte
    pb: 15, // petabyte
    tb: 12, // terabyte
    gb: 9, // gigabyte
    mb: 6, // megabyte
    kb: 3, // kilobyte
  };

  const sizeToBytes = (size) => {
    const length = size.length;
    const unit = size.substring(length - 2, length).toLowerCase();
    const value = parseInt(size, 10);
    const exp = UNIT_SIZES[unit];
    if (!exp) return value;
    return value * Math.pow(10, exp);
  };

  ((exports.bytesToSize = bytesToSize), (exports.sizeToBytes = sizeToBytes));
  //#endregion

  //#region browser.js

  const UINT32_MAX = 0xffffffff;
  const BUF_LEN = 1024;
  const BUF_SIZE = BUF_LEN * Uint32Array.BYTES_PER_ELEMENT;

  const randomPrefetcher = {
    buf: new Uint8Array(BUF_SIZE),
    view: null,
    pos: 0,
    next() {
      const { buf, view, pos } = this;
      let start = pos;
      if (start === buf.length) {
        start = 0;
        crypto.getRandomValues(buf);
      }
      const rnd = view.getUint32(start, true) / (UINT32_MAX + 1);
      this.pos = start + Uint32Array.BYTES_PER_ELEMENT;
      return rnd;
    },
  };

  crypto.getRandomValues(randomPrefetcher.buf);
  randomPrefetcher.view = new DataView(
    randomPrefetcher.buf.buffer,
    randomPrefetcher.buf.byteOffset,
    randomPrefetcher.buf.byteLength,
  );

  const cryptoRandom = (min, max) => {
    const rnd = randomPrefetcher.next();
    if (min === undefined) return rnd;
    const [a, b] = max === undefined ? [0, min] : [min, max];
    return a + Math.floor(rnd * (b - a + 1));
  };

  const random = (min, max) => {
    const rnd = Math.random();
    if (min === undefined) return rnd;
    const [a, b] = max === undefined ? [0, min] : [min, max];
    return a + Math.floor(rnd * (b - a + 1));
  };

  const generateUUID = crypto.randomUUID;

  const generateKey = (possible, length) => {
    if (length < 0) return '';
    const base = possible.length;
    if (base < 1) return '';
    const key = new Uint8Array(length);
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      const index = randomValues[i] % base;
      key[i] = possible.charCodeAt(index);
    }
    return String.fromCharCode.apply(null, key);
  };

  ((exports.cryptoRandom = cryptoRandom),
    (exports.random = random),
    (exports.generateUUID = generateUUID),
    (exports.generateKey = generateKey));
  //#endregion

  //#endregion
  //#region client-listeners.js
  const listenOnline = (connections) => {
    const online = () => {
      for (const connection of connections) {
        if (!connection.connected) connection.open();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', online);
    }
    if (typeof self !== 'undefined' && !!self.registration) {
      self.addEventListener('online', online);
    }
  };

  //#endregion

  //#region chunks-browser.js
  const ID_LENGTH_BYTES = 1;
  const chunkEncode = (id, payload) => {
    const encoder = new TextEncoder();
    const idBuffer = encoder.encode(id);
    const idLength = idBuffer.length;
    if (idLength > 255) {
      throw new Error(
        `ID length ${idLength} exceeds maximum of 255 characters`,
      );
    }
    const chunk = new Uint8Array(ID_LENGTH_BYTES + idLength + payload.length);
    chunk[0] = idLength;
    chunk.set(idBuffer, ID_LENGTH_BYTES);
    chunk.set(payload, ID_LENGTH_BYTES + idLength);
    return chunk;
  };
  const chunkDecode = (chunk) => {
    const idLength = chunk[0];
    const idBuffer = chunk.subarray(
      ID_LENGTH_BYTES,
      ID_LENGTH_BYTES + idLength,
    );
    const decoder = new TextDecoder();
    const id = decoder.decode(idBuffer);
    const payload = chunk.subarray(ID_LENGTH_BYTES + idLength);
    return { id, payload };
  };

  //#endregion

  //#region streams.js
  const PUSH_EVENT = Symbol();
  const PULL_EVENT = Symbol();
  const DEFAULT_HIGH_WATER_MARK = 32;
  const MAX_LISTENERS = 10;
  const MAX_HIGH_WATER_MARK = 1000;
  class MetaReadable extends Emitter {
    constructor(id, name, size, options = {}) {
      super(options);
      this.id = id;
      this.name = name;
      this.size = size;
      this.highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
      this.queue = [];
      this.streaming = true;
      this.status = 'active';
      this.bytesRead = 0;
    }
    async push(data) {
      if (this.queue.length > this.highWaterMark) {
        this.checkStreamLimits();
        await this.waitEvent(PULL_EVENT);
        return this.push(data);
      }
      this.queue.push(data);
      if (this.queue.length === 1) this.emit(PUSH_EVENT);
      return data;
    }
    async finalize(writable) {
      const onError = () => this.terminate();
      writable.once('error', onError);
      for await (const chunk of this) {
        const needDrain = !writable.write(chunk);
        if (needDrain) await writable.waitEvent('drain');
      }
      this.emit('end');
      writable.end();
      await writable.waitEvent('close');
      await this.close();
      writable.removeListener('error', onError);
    }
    pipe(writable) {
      this.finalize(writable);
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
      await this.stop();
      this.status = 'closed';
    }
    async terminate() {
      await this.stop();
      this.status = 'terminated';
    }
    async stop() {
      while (this.bytesRead !== this.size) {
        await this.waitEvent(PULL_EVENT);
      }
      this.streaming = false;
      this.emit(PUSH_EVENT, null);
    }
    async read() {
      if (this.queue.length > 0) return this.pull();
      const finisher = await this.waitEvent(PUSH_EVENT);
      if (finisher === null) return null;
      return this.pull();
    }
    pull() {
      const data = this.queue.shift();
      if (!data) return data;
      this.bytesRead += data.length;
      this.emit(PULL_EVENT);
      return data;
    }
    checkStreamLimits() {
      if (this.listenerCount(PULL_EVENT) >= MAX_LISTENERS) {
        ++this.highWaterMark;
      }
      if (this.highWaterMark > MAX_HIGH_WATER_MARK) {
        throw new Error('Stream overflow occurred');
      }
    }
    waitEvent(event) {
      return new Promise((resolve) => this.once(event, resolve));
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
    write(data) {
      const chunk = chunkEncode(this.id, data);
      this.transport.write(chunk);
      return true;
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

  //#endregion

  //#region metacom.js
  const CALL_TIMEOUT = 7 * 1000;
  const PING_INTERVAL = 60 * 1000;
  const RECONNECT_TIMEOUT = 2 * 1000;
  const connections = new Set();
  listenOnline(connections);
  const toByteView = async (input) => {
    if (typeof input.arrayBuffer === 'function') {
      const buffer = await input.arrayBuffer();
      return new Uint8Array(buffer);
    }
    return new Uint8Array(input);
  };
  class MetacomError extends Error {
    constructor({ message, code }) {
      super(message);
      this.code = code;
    }
  }
  class MetacomUnit extends Emitter {
    emit(...args) {
      super.emit('*', ...args);
      super.emit(...args);
    }
    post(...args) {
      super.emit(...args);
    }
  }
  class Metacom extends Emitter {
    constructor(url, options = {}) {
      super(options);
      this.url = url;
      this.socket = null;
      this.api = {};
      this.calls = new Map();
      this.streams = new Map();
      this.active = false;
      this.connected = false;
      this.opening = null;
      this.lastActivity = Date.now();
      this.callTimeout = options.callTimeout || CALL_TIMEOUT;
      this.pingInterval = options.pingInterval || PING_INTERVAL;
      this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
      this.generateId = options.generateId || (() => crypto.randomUUID());
      this.ping = null;
      if (!options.messagePortTransport) {
        this.open();
      }
    }
    static async createProxy(url, options) {
      const { transport } = Metacom;
      const Transport = transport.mp;
      options.messagePortTransport = true;
      const instance = new Transport(url, options);
      await instance.open(options.metacomLoad);
      return instance;
    }
    static create(url, options) {
      const { transport } = Metacom;
      const Transport = url.startsWith('ws') ? transport.ws : transport.http;
      return new Transport(url, options);
    }
    getStream(id) {
      const stream = this.streams.get(id);
      if (stream) return stream;
      throw new Error(`Stream ${id} is not initialized`);
    }
    createStream(name, size) {
      const id = this.generateId();
      const transport = this;
      return new MetaWritable(id, name, size, transport);
    }
    createBlobUploader(blob) {
      const name = blob.name || 'blob';
      const size = blob.size;
      const consumer = this.createStream(name, size);
      return {
        id: consumer.id,
        upload: async () => {
          const reader = blob.stream().getReader();
          let chunk;
          while (!(chunk = await reader.read()).done) {
            consumer.write(chunk.value);
          }
          consumer.end();
        },
      };
    }
    async message(data) {
      if (data === '{}') return;
      this.lastActivity = Date.now();
      let packet;
      try {
        packet = JSON.parse(data);
      } catch {
        return;
      }
      const { type, id, name } = packet;
      if (type === 'event') {
        const [unit, eventName] = name.split('/');
        const metacomUnit = this.api[unit];
        if (metacomUnit) metacomUnit.emit(eventName, packet.data);
        return;
      }
      if (!id) {
        console.error(new Error('Packet structure error'));
        return;
      }
      if (type === 'callback') {
        const promised = this.calls.get(id);
        if (!promised) return;
        const [resolve, reject, timeout] = promised;
        this.calls.delete(id);
        clearTimeout(timeout);
        if (packet.error) {
          return void reject(new MetacomError(packet.error));
        }
        resolve(packet.result);
      } else if (type === 'stream') {
        const { name, size, status } = packet;
        const stream = this.streams.get(id);
        if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
          if (stream) {
            console.error(new Error(`Stream ${name} is already initialized`));
          } else {
            const stream = new MetaReadable(id, name, size);
            this.streams.set(id, stream);
          }
        } else if (!stream) {
          console.error(new Error(`Stream ${id} is not initialized`));
        } else if (status === 'end') {
          await stream.close();
          this.streams.delete(id);
        } else if (status === 'terminate') {
          await stream.terminate();
          this.streams.delete(id);
        } else {
          console.error(new Error('Stream packet structure error'));
        }
      }
    }
    async binary(input) {
      const byteView = await toByteView(input);
      const { id, payload } = chunkDecode(byteView);
      const stream = this.streams.get(id);
      if (stream) await stream.push(payload);
      else console.warn(`Stream ${id} is not initialized`);
    }
    async load(...units) {
      const introspect = this.scaffold('system')('introspect');
      const introspection = await introspect(units);
      this.initApi(units, introspection);
      return introspection;
    }
    initApi(units, introspection) {
      const available = Object.keys(introspection);
      for (const unit of units) {
        if (!available.includes(unit)) continue;
        const methods = new MetacomUnit();
        const instance = introspection[unit];
        const request = this.scaffold(unit);
        const methodNames = Object.keys(instance);
        for (const methodName of methodNames) {
          methods[methodName] = request(methodName);
        }
        this.api[unit] = methods;
      }
    }
    scaffold(unit, ver) {
      return (method) =>
        async (args = {}) => {
          const id = this.generateId();
          const unitName = unit + (ver ? '.' + ver : '');
          const target = unitName + '/' + method;
          if (this.opening) await this.opening;
          if (!this.connected) await this.open();
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              if (this.calls.has(id)) {
                this.calls.delete(id);
                reject(new Error('Request timeout'));
              }
            }, this.callTimeout);
            this.calls.set(id, [resolve, reject, timeout]);
            const packet = { type: 'call', id, method: target, args };
            this.send(packet, { unit, method });
          });
        };
    }
    async uploadFile(file, { unit = 'files', method = 'upload' } = {}) {
      this.lastActivity = Date.now();
      const uploader = this.createBlobUploader(file);
      await this.api[unit][method]({
        streamId: uploader.id,
        name: file.name || `blob-${uploader.id}`,
      });
      await uploader.upload();
      return file;
    }
    async downloadFile(name, { unit = 'files', method = 'download' } = {}) {
      const { streamId } = await this.api[unit][method]({ name });
      const readable = await this.getStream(streamId);
      const blob = await readable.toBlob();
      return new File([blob], name);
    }
  }
  class WebsocketTransport extends Metacom {
    async open() {
      if (this.opening) return this.opening;
      if (this.connected) return Promise.resolve();
      const socket = new WebSocket(this.url);
      this.active = true;
      this.socket = socket;
      connections.add(this);
      socket.addEventListener('message', ({ data }) => {
        if (typeof data === 'string') this.message(data);
        else this.binary(data);
      });
      socket.addEventListener('close', () => {
        this.opening = null;
        this.connected = false;
        this.emit('close');
        setTimeout(() => {
          if (this.active) this.open();
        }, this.reconnectTimeout);
      });
      socket.addEventListener('error', (err) => {
        this.emit('error', err);
        socket.close();
      });
      if (this.pingInterval) {
        this.ping = setInterval(() => {
          if (this.active) {
            const interval = Date.now() - this.lastActivity;
            if (interval > this.pingInterval) this.write('{}');
          }
        }, this.pingInterval);
      }
      this.opening = new Promise((resolve) => {
        socket.addEventListener('open', () => {
          this.opening = null;
          this.connected = true;
          this.emit('open');
          resolve();
        });
      });
      return this.opening;
    }
    close() {
      this.active = false;
      connections.delete(this);
      if (this.ping) clearInterval(this.ping);
      if (!this.socket) return;
      this.socket.close();
      this.socket = null;
    }
    write(data) {
      if (!this.connected) return;
      this.lastActivity = Date.now();
      this.socket.send(data);
    }
    send(data) {
      if (!this.connected) return;
      this.lastActivity = Date.now();
      const payload = JSON.stringify(data);
      this.socket.send(payload);
    }
  }
  class HttpTransport extends Metacom {
    async open() {
      this.active = true;
      this.connected = true;
      this.emit('open');
    }
    close() {
      this.active = false;
      this.connected = false;
    }
    send(data) {
      this.lastActivity = Date.now();
      const body = JSON.stringify(data);
      const headers = { 'Content-Type': 'application/json' };
      fetch(this.url, { method: 'POST', headers, body }).then((res) =>
        res.text().then((packet) => {
          this.message(packet);
        }),
      );
    }
  }
  class MessagePortTransport extends Metacom {
    async open(metacomLoad) {
      this.active = true;
      this.connected = true;
      const messageChannel = new MessageChannel();
      this.messagePort = messageChannel.port1;
      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active;
      worker.postMessage(
        {
          type: 'PORT_INITIALIZATION',
          url: this.url,
          metacomLoad,
        },
        [messageChannel.port2],
      );
      const { promise, resolve } = Promise.withResolvers();
      // Process messages from worker
      this.messagePort.onmessage = ({ data }) => {
        const { payload, type } = data;
        switch (type) {
          case 'INTROSPECTION':
            // instead of metacom.load with implicit introspection call
            // use initApi, when introspection data comes from worker
            this.initApi(metacomLoad, payload);
            resolve(this);
            return;
          case 'CALLBACK':
            this.message(JSON.stringify(payload));
            break;
          case 'UPLOADED':
            if (!payload.done) return;
            this.emit(`stream_${payload.meta.id}`, payload.meta);
            break;
          case 'DOWNLOADED': {
            if (!payload.done) return;
            const { arrayBuffer, meta } = payload;
            const file = new File([arrayBuffer], meta.name);
            this.emit(`stream_${meta.id}`, file);
            break;
          }
          default:
            break;
        }
      };
      return promise;
    }
    close() {
      this.active = false;
      this.connected = false;
    }
    send(packet, { unit, method } = {}) {
      if (!this.messagePort) throw new Error('MessagePort is not initialized');
      this.lastActivity = Date.now();
      this.messagePort.postMessage({ unit, method, packet });
    }
    // overriden methods for passing files through service worker
    async uploadFile(file, { unit = 'files', method = 'upload' } = {}) {
      const arrayBuffer = await file.arrayBuffer();
      if (!this.messagePort) throw new Error('MessagePort is not initialized');
      this.lastActivity = Date.now();
      const id = this.generateId();
      this.messagePort.postMessage(
        {
          type: 'UPLOAD',
          unit,
          method,
          packet: arrayBuffer,
          meta: { id, name: file.name, size: file.size, type: file.type },
        },
        [arrayBuffer],
      );
      return await this.toPromise(`stream_${id}`).then(() => file);
    }
    async downloadFile(name, { unit = 'files', method = 'download' } = {}) {
      if (!this.messagePort) throw new Error('MessagePort is not initialized');
      this.lastActivity = Date.now();
      const id = this.generateId();
      this.messagePort.postMessage({
        type: 'DOWNLOAD',
        unit,
        method,
        packet: { name },
        meta: { id },
      });
      return await this.toPromise(`stream_${id}`);
    }
  }
  Metacom.transport = {
    ws: WebsocketTransport,
    http: HttpTransport,
    mp: MessagePortTransport,
  };

  //#endregion

  exports.listenOnline = listenOnline;
  exports.chunkEncode = chunkEncode;
  exports.chunkDecode = chunkDecode;
  exports.MetaReadable = MetaReadable;
  exports.MetaWritable = MetaWritable;
  exports.Metacom = Metacom;
  exports.MetacomUnit = MetacomUnit;
  return exports;
})({});
