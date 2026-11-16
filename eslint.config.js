'use strict';

const init = require('eslint-config-metarhia');

module.exports = [
  { ignores: ['metacom.iife.js', '.example/**'] },
  ...init,
  {
    files: ['metacom.mjs', 'browser/*.mjs', 'examples/webrtc/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        crypto: 'readonly',
      },
    },
  },
];
