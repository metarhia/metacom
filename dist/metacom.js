import { Metacom, MetacomUnit, connections } from './client.js';

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

export { Metacom, MetacomUnit };
