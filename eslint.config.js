'use strict';

const init = require('eslint-config-metarhia');
init[0].ignores.push('metacom.iife.js');
module.exports = [
  ...init,
  {
    files: ['metacom.mjs', 'metacom-service-worker.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        crypto: 'readonly',
      },
    },
  },
];
