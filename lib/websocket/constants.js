'use strict';

const FINAL_FRAME = 0x80;
const RSV = 0x00;
const LEN_16_BIT = 126;
const LEN_64_BIT = 127;
const MAX_16_BIT = 65535;
const TWO_32 = 4294967296;
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // WebSocket GUID
const PING_INTERVAL = 10000;
const EOL = '\r\n';
const EOL2 = '\r\n\r\n';
const ENCODING = 'utf8';
const UPGRADE = [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Accept: ',
].join(EOL);
const MAX_BUFFER = 1024 * 1024 * 100;
const CLOSE_TIMEOUT = 1000;

const FIN_MASK = 0x80;
const RSV_MASK = 0x70;
const OPCODE_MASK = 0x0f;
const MASK_MASK = 0x80;
const PAYLOAD_LEN_MASK = 0x7f;
const CONTROL_FRAME_MASK = 0x08;
const MAX_SAFE_HIGH_MASK = 0xffe00000;

const CLOSE_CODES = {
  NORMAL_CLOSE: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  RESERVED: 1004,
  NO_CODE_RECEIVED: 1005,
  CONNECTION_CLOSED_ABNORMALLY: 1006,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATED: 1008,
  MESSAGE_TOO_BIG: 1009,
  MANDATORY_EXTENSION: 1010, //client
  INTERNAL_SERVER_ERROR: 1011,
  TLS_HANDSHAKE: 1015,
};
const VALID_CLOSE_CODES = new Set([
  CLOSE_CODES.NORMAL_CLOSE,
  CLOSE_CODES.GOING_AWAY,
  CLOSE_CODES.PROTOCOL_ERROR,
  CLOSE_CODES.UNSUPPORTED_DATA,
  CLOSE_CODES.INVALID_PAYLOAD,
  CLOSE_CODES.POLICY_VIOLATED,
  CLOSE_CODES.MESSAGE_TOO_BIG,
  CLOSE_CODES.MANDATORY_EXTENSION,
  CLOSE_CODES.INTERNAL_SERVER_ERROR,
]);
const VALID_USER_CLOSE_CODES = {
  MIN: 3000,
  MAX: 4999,
};

const OPCODES = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
};
const DATA_OPCODES = new Set([
  OPCODES.CONTINUATION,
  OPCODES.TEXT,
  OPCODES.BINARY,
]);
const CONTROL_OPCODES = new Set([OPCODES.CLOSE, OPCODES.PING, OPCODES.PONG]);

const EMPTY_PING = Buffer.from([0x89, 0x00]);
const EMPTY_PONG = Buffer.from([0x8a, 0x00]);
const CLIENT_EMPTY_PING = Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00]);
const CLIENT_EMPTY_PONG = Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]);
const EMPTY_BUFFER = Buffer.alloc(0);

const CLOSE_FRAMES = {
  NORMAL_CLOSE: {
    reason: '',
    buf: Buffer.from([0x88, 0x02, 0x03, 0xe8]),
  },
  GOING_AWAY: {
    reason: 'Going away',
    buf: Buffer.concat([
      Buffer.from([0x88, 0x0c, 0x03, 0xe9]),
      Buffer.from('Going away', ENCODING),
    ]),
  },
  PROTOCOL_ERROR: {
    COMMON: {
      reason: 'Protocol error',
      buf: Buffer.concat([
        Buffer.from([0x88, 0x10, 0x3, 0xea]),
        Buffer.from('Protocol error', ENCODING),
      ]),
    },
    UNMASKED: {
      reason: 'Unmasked frame from client',
      buf: Buffer.concat([
        Buffer.from([0x88, 0x1c, 0x03, 0xea]),
        Buffer.from('Unmasked frame from client', ENCODING),
      ]),
    },
    MASKED: {
      reason: 'Masked frame from server',
      buf: null,
    },
    RSV: {
      reason: 'RSV bits must be 0',
      buf: Buffer.concat([
        Buffer.from([0x88, 0x14, 0x03, 0xea]),
        Buffer.from('RSV bits must be 0', ENCODING),
      ]),
    },
    CTRL_TOO_LONG: {
      reason: 'Control frame too long',
      buf: Buffer.concat([
        Buffer.from([0x88, 0x18, 0x03, 0xea]),
        Buffer.from('Control frame too long', ENCODING),
      ]),
    },
  },
  INVALID_PAYLOAD: {
    reason: 'Invalid payload data',
    buf: Buffer.concat([
      Buffer.from([0x88, 0x16, 0x03, 0xef]),
      Buffer.from('Invalid payload data', ENCODING),
    ]),
  },
  MESSAGE_TOO_BIG: {
    reason: 'Message too big',
    buf: Buffer.concat([
      Buffer.from([0x88, 0x11, 0x03, 0xf1]),
      Buffer.from('Message too big', ENCODING),
    ]),
  },
};

const PROTOCOL_ERROR_SUBTYPES = {
  COMMON: 'COMMON',
  UNMASKED: 'UNMASKED',
  MASKED: 'MASKED',
  RSV: 'RSV',
  CTRL_TOO_LONG: 'CTRL_TOO_LONG',
};

module.exports = {
  FIN_MASK,
  RSV_MASK,
  OPCODE_MASK,
  MASK_MASK,
  PAYLOAD_LEN_MASK,
  RSV,
  OPCODES,
  FINAL_FRAME,
  LEN_16_BIT,
  LEN_64_BIT,
  MAX_16_BIT,
  PING_INTERVAL,
  UPGRADE,
  MAGIC,
  EOL,
  MAX_BUFFER,
  CLOSE_TIMEOUT,
  CONTROL_FRAME_MASK,
  DATA_OPCODES,
  CONTROL_OPCODES,
  CLOSE_CODES,
  EMPTY_PING,
  EMPTY_PONG,
  EMPTY_BUFFER,
  CLIENT_EMPTY_PING,
  CLIENT_EMPTY_PONG,
  CLOSE_FRAMES,
  ENCODING,
  EOL2,
  VALID_CLOSE_CODES,
  VALID_USER_CLOSE_CODES,
  MAX_SAFE_HIGH_MASK,
  TWO_32,
  PROTOCOL_ERROR_SUBTYPES,
};
