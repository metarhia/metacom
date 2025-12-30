'use strict';

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

module.exports = { listenOnline };
