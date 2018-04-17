'use strict';

const submodules = [
  'client' // Metacom client
].map(path => require('./lib/' + path));

const { client } = submodules[0];
module.exports = Object.assign(client, ...submodules);
