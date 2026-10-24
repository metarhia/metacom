'use strict';

const { WebsocketServer } = require('./websocket/ws.js');
const { ClientWsTransport } = require('./client-ws.js');
const { ServerTransport } = require('./transport.js');
const { registerTransport } = require('./transport-registry.js');

class ServerWsTransport extends ServerTransport {
  constructor(req, connection) {
    super(req.socket.remoteAddress);
    this.connection = connection;
    connection.on('close', () => void this.emit('close'));
    connection.on('error', () => void this.emit('close'));
    connection.on('message', (data, isBinary) => {
      this.emit('message', isBinary ? data : data.toString());
    });
  }

  write(data) {
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
      data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    this.connection.send(data);
  }

  close() {
    this.connection.terminate();
  }
}

ServerWsTransport.capabilities = {
  duplex: true,
  streams: true,
  events: true,
};

const attach = (httpServer, options, onConnection) => {
  const wsOptions = { server: httpServer, ...options };
  const wsServer = new WebsocketServer(wsOptions);
  wsServer.on('connection', (connection, req) => {
    onConnection(new ServerWsTransport(req, connection));
  });
  return wsServer;
};

registerTransport('ws', {
  Client: ClientWsTransport,
  Server: ServerWsTransport,
  capabilities: ServerWsTransport.capabilities,
  attach,
});

module.exports = { ClientWsTransport, ServerWsTransport, attach };
