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

const db = require('./core/db');

const loaded = modules.loadAll();
auth.purgeSessions();
setInterval(auth.purgeSessions, 3600e3).unref();
require('./core/notify').prune();

const server = http.createServer();
// Connections stay open long enough that the proxy in front never sends a request down a connection this server has just closed
// (the classic cause of a sporadic "502 Bad Gateway"); slow uploads (a picture, a voice note) get time to arrive.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 120_000;

server.listen(config.port, config.host, () => {
  console.log(`\neTricks Hub running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Modules: ${loaded.map((m) => m.id).join(', ')}`);
  console.log(`Data folder: ${config.dataDir}  (timezone ${process.env.TZ})`);
  // The backups start a few seconds AFTER the server answers, so a restart never keeps anybody waiting for them.
  setTimeout(() => backup.startScheduler(), 4000);
  setInterval(() => db.tidy(), 6 * 3600e3).unref();
});

// ---- stopping: finish what is being answered, then close the database cleanly ----
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal}: finishing the requests in progress, then stopping`);
  server.close(() => { db.close(); console.log('[server] stopped'); process.exit(0); });
  server.closeIdleConnections?.();
  setTimeout(() => { server.closeAllConnections?.(); db.close(); process.exit(0); }, 8000).unref(); // never wait longer than 8 seconds
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
// One odd error in one request must not take the whole server down: it is written to the log and the server carries on.
process.on('unhandledRejection', (e) => console.error('[error] unhandled promise rejection', e));
process.on('uncaughtException', (e) => { console.error('[fatal] uncaught exception, restarting cleanly', e); stop('uncaughtException'); });
