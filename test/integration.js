'use strict';

const metacom = require('..');

const server = metacom.listen({
  transport: 'tcp',
  port: 2000,
  host: 'localhost'
});

server.on('connection', connection => {
  console.log('Connection accepted ' + connection.remoteAddress);
});

const client = metacom.connect({
  transport: 'tcp',
  port: 2000,
  host: 'localhost',
  api: 'applicationName'
});

client.on('open', () => {
  console.log('Connection initiated');
  client.methodName('par1', 'par2', 'par3', (err, data) => {
    console.dir({ data });
    process.exit(0);
  });
});
