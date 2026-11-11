'use strict';

const { WebsocketServer } = require('./websocket/ws.js');
const { ClientWsTransport } = require('./client-ws.js');
const { ServerTransport } = require('./transport.js');
const { registerTransport } = require('./transport-registry.js');

class ServerWsTransport extends ServerTransport {
  static capabilities = { duplex: true, streams: true, events: true };

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
    const isSendable = typeof data === 'string' || Buffer.isBuffer(data);
    if (isSendable) return void this.connection.send(data);
    const { buffer, byteOffset, byteLength } = data;
    const view = Buffer.from(buffer, byteOffset, byteLength);
    this.connection.send(view);
  }

  close() {
    this.connection.terminate();
  }
}

const attach = (server, options, onConnection) => {
  const { path, verifyClient } = options;
  const wsOptions = { server: server.httpServer };
  if (path !== undefined) wsOptions.path = path;
  if (verifyClient !== undefined) wsOptions.verifyClient = verifyClient;
  const wsServer = new WebsocketServer(wsOptions);
  wsServer.on('connection', (connection, req) => {
    const transport = new ServerWsTransport(req, connection);
    onConnection(transport);
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
