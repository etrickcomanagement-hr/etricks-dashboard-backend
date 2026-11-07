'use strict';
// Recovery for the website access password, run on the server:
//   DATA_DIR=/var/lib/etricks node scripts/gate.js off          (turns it off)
//   DATA_DIR=/var/lib/etricks node scripts/gate.js set "new password"
const gate = require('../core/gate');
const [cmd, pw] = process.argv.slice(2);
if (cmd === 'off') { gate.clear(); console.log('The access password is off.'); }
else if (cmd === 'set' && pw && pw.length >= 8) { gate.set(pw); console.log('The access password was set.'); }
else { console.log('Usage: node scripts/gate.js off | set "<at least 8 characters>"'); process.exitCode = 1; }
