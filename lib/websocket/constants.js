'use strict';

const OPCODES = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
};

const CLOSE_CODES = {
  'Normal closure': 1000,
  'Going away': 1001,
  'Protocol error': 1002,
  'Unsupported data': 1003,
  'Invalid payload data': 1007,
  'Policy violation': 1008,
  'Message too big': 1009,
  'Mandatory extension': 1010,
  'Internal error': 1011,
};

const DATA_OPCODES = [OPCODES.CONTINUATION, OPCODES.TEXT, OPCODES.BINARY];

const CONTROL_OPCODES = [OPCODES.CLOSE, OPCODES.PING, OPCODES.PONG];

module.exports = { OPCODES, CLOSE_CODES, DATA_OPCODES, CONTROL_OPCODES };
