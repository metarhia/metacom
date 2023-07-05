'use strict';

const metatests = require('metatests');
const protocol = require('../lib/protocol.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

metatests.case(
  'Protocol',
  { protocol },
  {
    'protocol.serialize': [
      // unknown
      ['unknown', {}, null],
      // call
      [
        'call',
        {
          id: 1,
          unit: 'auth',
          version: 1,
          name: 'signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
        {
          type: 'call',
          id: 1,
          method: 'auth.1/signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
      ],
      // call without version
      [
        'call',
        {
          id: 1,
          unit: 'auth',
          version: undefined,
          name: 'signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
        {
          type: 'call',
          id: 1,
          method: 'auth/signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
      ],
      // callback
      [
        'callback',
        {
          id: 1,
          result: { token: 'random-string' },
          meta: { some: 'data' },
        },
        {
          type: 'callback',
          id: 1,
          result: { token: 'random-string' },
          meta: { some: 'data' },
        },
      ],
      // event
      [
        'event',
        {
          unit: 'account',
          name: 'created',
          data: { accountId: 'random-string' },
          meta: { some: 'data' },
        },
        {
          type: 'event',
          name: 'account/created',
          data: { accountId: 'random-string' },
          meta: { some: 'data' },
        },
      ],
      // stream initialization
      [
        'stream',
        { id: 1, name: 'some-name', size: 1e9 },
        {
          type: 'stream',
          id: 1,
          name: 'some-name',
          size: 1e9,
          status: undefined,
        },
      ],
      // stream finalization
      [
        'stream',
        { id: 1, status: 'end' },
        {
          type: 'stream',
          id: 1,
          status: 'end',
          name: undefined,
          size: undefined,
        },
      ],
      // stream termination
      [
        'stream',
        { id: 1, status: 'terminate' },
        {
          type: 'stream',
          id: 1,
          status: 'terminate',
          name: undefined,
          size: undefined,
        },
      ],
    ],
    'protocol.deserialize': [
      // empty
      [{}, null],
      // call
      [
        {
          type: 'call',
          id: 1,
          method: 'auth.1/signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
        {
          type: 'call',
          data: {
            id: 1,
            unit: 'auth',
            version: 1,
            name: 'signIn',
            args: { email: 'test@gmail.com', password: 'secret' },
            meta: { some: 'data' },
          },
        },
      ],
      // call without version
      [
        {
          type: 'call',
          id: 1,
          method: 'auth/signIn',
          args: { email: 'test@gmail.com', password: 'secret' },
          meta: { some: 'data' },
        },
        {
          type: 'call',
          data: {
            id: 1,
            unit: 'auth',
            version: undefined,
            name: 'signIn',
            args: { email: 'test@gmail.com', password: 'secret' },
            meta: { some: 'data' },
          },
        },
      ],
      // callback
      [
        {
          type: 'callback',
          id: 1,
          result: { token: 'random-string' },
          meta: { some: 'data' },
        },
        {
          type: 'callback',
          data: {
            id: 1,
            result: { token: 'random-string' },
            meta: { some: 'data' },
          },
        },
      ],
      // event
      [
        {
          type: 'event',
          name: 'account/created',
          data: { accountId: 'random-string' },
          meta: { some: 'data' },
        },
        {
          type: 'event',
          data: {
            unit: 'account',
            name: 'created',
            data: { accountId: 'random-string' },
            meta: { some: 'data' },
          },
        },
      ],
      // stream initialization
      [
        {
          type: 'stream',
          id: 1,
          name: 'some-name',
          size: 1e9,
        },
        {
          type: 'stream',
          data: {
            id: 1,
            name: 'some-name',
            size: 1e9,
            status: undefined,
          },
        },
      ],
      // stream finalization
      [
        { type: 'stream', id: 1, status: 'end' },
        {
          type: 'stream',
          data: {
            id: 1,
            status: 'end',
            name: undefined,
            size: undefined,
          },
        },
      ],
      // stream termination
      [
        { type: 'stream', id: 1, status: 'terminate' },
        {
          type: 'stream',
          data: {
            id: 1,
            status: 'terminate',
            name: undefined,
            size: undefined,
          },
        },
      ],
    ],
  },
);
