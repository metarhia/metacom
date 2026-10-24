'use strict';

const { OPCODES, CLOSE_CODES } = require('./constants.js');
const { WebsocketServer, MAGIC } = require('./server.js');
const { Connection, CLOSE_TIMEOUT } = require('./connection.js');
const { Frame } = require('./frame.js');
const {
  parse,
  expectedFrameLength,
  checkControlFrame,
  checkDataFrame,
  ParseError,
} = require('./frameParser.js');

module.exports = {
  OPCODES,
  CLOSE_CODES,
  CLOSE_TIMEOUT,
  MAGIC,
  WebsocketServer,
  Connection,
  Frame,
  parse,
  expectedFrameLength,
  checkControlFrame,
  checkDataFrame,
  ParseError,
};
