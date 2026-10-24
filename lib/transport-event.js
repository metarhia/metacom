'use strict';

const { ClientEventTransport } = require('./client-event.js');
const { ServerTransport } = require('./transport.js');
const { registerTransport } = require('./transport-registry.js');

class ServerEventTransport extends ServerTransport {
  constructor(port) {
    super('event transport');
    this.port = port;
    port.on('close', () => void this.emit('close'));
    port.on('message', (data) => {
      if (Buffer.isBuffer(data)) data = data.toString();
      this.emit('message', data);
    });
  }

  write(data) {
    this.port.postMessage(data);
  }

  close() {
    this.port.close();
  }
}

ServerEventTransport.capabilities = {
  duplex: true,
  streams: true,
  events: true,
};

// Ports are delivered externally (e.g. Service Worker bridge)
// via server.emit('port', port)
const attach = (server, options, onConnection) => {
  server.on('port', (port) => {
    onConnection(new ServerEventTransport(port));
  });
};

registerTransport('event', {
  Client: ClientEventTransport,
  Server: ServerEventTransport,
  capabilities: ServerEventTransport.capabilities,
  attach,
});

module.exports = { ClientEventTransport, ServerEventTransport, attach };
