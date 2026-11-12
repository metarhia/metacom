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

const CONTROL_OPCODES = [OPCODES.CLOSE, OPCODES.PING, OPCODES.PONG];

const FIN_MASK = 0x80;
const RSV_MASK = 0x70;
const MASK_MASK = 0x80;
const LEN_16_BIT = 126;
const LEN_64_BIT = 127;
const TWO_32 = 4294967296;

module.exports = {
  OPCODES,
  CLOSE_CODES,
  CONTROL_OPCODES,
  FIN_MASK,
  RSV_MASK,
  MASK_MASK,
  LEN_16_BIT,
  LEN_64_BIT,
  TWO_32,
};
