'use strict';
// Timezone drives attendance dates and late calculation. Override with TZ=... if the office is elsewhere.
process.env.TZ = process.env.TZ || 'Asia/Karachi';

const config = require('./core/config');
const modules = require('./core/modules');
const http = require('./core/http');
const backup = require('./core/backup');
const auth = require('./core/auth');

if (config.onRailway && !config.hasPersistentStorage) {
  console.warn('\n!!! WARNING: no Volume is attached. The database lives on temporary disk and WILL BE ERASED on every redeploy.');
  console.warn('!!! In Railway: add a Volume to this service (mount path /data), then redeploy.\n');
}

const loaded = modules.loadAll();
backup.startScheduler();
auth.purgeSessions();
setInterval(auth.purgeSessions, 3600e3).unref();
require('./core/notify').prune();

http.createServer().listen(config.port, config.host, () => {
  console.log(`\neTricks Hub running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Modules: ${loaded.map((m) => m.id).join(', ')}`);
  console.log(`Data folder: ${config.dataDir}  (timezone ${process.env.TZ})`);
});
