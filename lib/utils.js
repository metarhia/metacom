'use strict';

// This file is required for older node versions support in metacom.js
// Remove after drop support for node 20
// crypto is available as global crypto since node 19
// WebSocket client is available since node 21 and is stable since node 22.4

const crypto = require('node:crypto');
const WebSocket = require('ws');

module.exports = { WebSocket, crypto };
