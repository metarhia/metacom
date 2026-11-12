export const broadcastSignaling = (name) => {
  const channel = new BroadcastChannel(name);
  return {
    send(message) {
      channel.postMessage(message);
    },
    subscribe(listener) {
      const receive = ({ data }) => listener(data);
      channel.addEventListener('message', receive);
      return () => channel.removeEventListener('message', receive);
    },
    close() {
      channel.close();
    },
  };
};

export const windowSignaling = (target, origin) => ({
  send(message) {
    target.postMessage(message, origin);
  },
  subscribe(listener) {
    const receive = (event) => {
      if (event.source === target && event.origin === origin) {
        listener(event.data);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  },
});
