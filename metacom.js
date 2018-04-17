'use strict';

const submodules = [
  'client', // metacom client connection
  'server' // metacom server
].map(path => require('./lib/' + path));

const { client } = submodules[0];
module.exports = Object.assign(client, ...submodules);
