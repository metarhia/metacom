'use strict';

const metacom = require('..');

const server = new metacom.Server({ transport: 'tcp' });

server.on('connection', (connection) => {
  console.log('Connection accepted ' + connection.remoteAddress);
});

server.listen(2000);

server.on('listening', () => {
  process.exit(0);

  // const client = metacom.connect('tcp://localhost:2000/applicationName');
  //
  // client.on('connect', () => {
  //   console.log('Connection initiated');
  //   client.rpcCall('methodName', 'par1', 'par2', 'par3', (err, data) => {
  //     console.dir({ data });
  //     process.exit(0);
  //   });
  //   client.methodName('par1', 'par2', 'par3', (err, data) => {
  //    console.dir({ data });
  //    process.exit(0);
  //   });
  // });

});
