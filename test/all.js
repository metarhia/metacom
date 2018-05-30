'use strict';

const fs = require('fs');
const path = require('path');

fs.readdir(__dirname, (err, files) => {
  if (err) {
    console.error('Failed to run tests: ', err);
    return;
  }

  const thisFilename = path.basename(__filename);
  files.filter(file => file !== thisFilename)
    .forEach(name => require('./' + name));
});
