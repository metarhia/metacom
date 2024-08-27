'use strict';

const init = require('eslint-config-metarhia');

module.exports = [
  ...init,
  {
    files: ['dist/**/*.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];
