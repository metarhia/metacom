import { Metacom } from './metacom.js';
import { runStreams } from './streamsUsage.js';

class Application {
  constructor() {
    const protocol = location.protocol === 'http:' ? 'ws' : 'wss';
    this.metacom = Metacom.create(`${protocol}://${location.host}/api`, {
      callTimeout: 5 * 60000,
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  window.application = new Application();
  window.api = window.application.metacom.api;
  await window.application.metacom.load('streams');
  await runStreams();
});
