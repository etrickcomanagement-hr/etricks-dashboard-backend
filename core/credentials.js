'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

// First-run passwords are random and written once to this file. Delete the file after noting them down.
const file = path.join(config.dataDir, 'initial-credentials.txt');

function append(line) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, 'eTricks - initial credentials (change them from the Admin portal, then delete this file)\r\n' + '='.repeat(60) + '\r\n');
  }
  fs.appendFileSync(file, line + '\r\n');
}

module.exports = { append, file };
