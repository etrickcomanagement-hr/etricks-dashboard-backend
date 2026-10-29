'use strict';
// Timezone drives attendance dates and late calculation. Override with TZ=... if the office is elsewhere.
process.env.TZ = process.env.TZ || 'Asia/Karachi';

const config = require('./core/config');
const modules = require('./core/modules');
const http = require('./core/http');
const backup = require('./core/backup');
const auth = require('./core/auth');

if ((config.onRailway || config.onRender) && !config.hasPersistentStorage) {
  console.warn('\n!!! WARNING: no persistent storage. The database lives on temporary disk and WILL BE ERASED on every restart or redeploy.');
  console.warn('!!! Railway: add a Volume (mount path /data). Render: add a Disk (mount path /data) and set DATA_DIR=/data. Then redeploy.\n');
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
