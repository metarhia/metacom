'use strict';

const { ClientEventTransport } = require('./client-event.js');
const { ServerTransport } = require('./transport.js');
const { registerTransport } = require('./transport-registry.js');

class ServerEventTransport extends ServerTransport {
  static capabilities = { duplex: true, streams: true, events: true };

  constructor(port) {
    super('event transport');
    this.port = port;
    port.on('close', () => void this.emit('close'));
    port.on('message', (data) => {
      const packet = Buffer.isBuffer(data) ? data.toString() : data;
      this.emit('message', packet);
    });
  }

  write(data) {
    this.port.postMessage(data);
  }

  close() {
    this.port.close();
  }
}

// Ports are delivered externally (e.g. Service Worker bridge)
// via server.emit('port', port)
const attach = (server, options, onConnection) => {
  server.on('port', (port) => {
    const transport = new ServerEventTransport(port);
    onConnection(transport);
  });
};

registerTransport('event', {
  Client: ClientEventTransport,
  Server: ServerEventTransport,
  capabilities: ServerEventTransport.capabilities,
  attach,
});

module.exports = { ClientEventTransport, ServerEventTransport, attach };
