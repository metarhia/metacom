'use strict';

const init = require('eslint-config-metarhia');
init[0].ignores.push('metacom.iife.js', '.example/**');
module.exports = [
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
