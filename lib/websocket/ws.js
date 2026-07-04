'use strict';

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { WebsocketServer, MAGIC } = require('./server.js');
const { Connection, CLOSE_TIMEOUT } = require('./connection.js');
const { Frame } = require('./frame.js');
const {
  FrameParser,
  ParseError,
  PARSE_ERR_CODES,
} = require('./frameParser.js');

module.exports = {
  OPCODES,
  CLOSE_CODES,
  CLOSE_TIMEOUT,
  MAGIC,
  WebsocketServer,
  Connection,
  Frame,
  FrameParser,
  ParseError,
  PARSE_ERR_CODES,
};
