const TIMEOUT_MS = 60 * 100;

export class Timer {
  constructor(options = {}) {
    this.timeout = options.timeout || TIMEOUT_MS;
    this.timer = null;
  }

  start(timedOut) {
    this.timer = setTimeout(() => {
      console.count('Timed out!');
      timedOut();
    }, this.timeout);
  }

  restart(timedOut) {
    this.stop();
    this.start(timedOut);
  }

  stop() {
    console.count('Stopping timer!');
    clearTimeout(this.timer);
  }
}
