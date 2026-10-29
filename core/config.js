'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// On Railway, attach a Volume: its mount path is picked up automatically so the database survives redeploys.
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data'));

module.exports = {
  root,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || (onRailway ? '0.0.0.0' : '127.0.0.1'),
  onRailway,
  hasPersistentStorage: !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  dataDir,
  dbFile: path.join(dataDir, 'etricks.db'),
  backupDir: path.join(dataDir, 'backups'),
  backupKeep: Number(process.env.BACKUP_KEEP) || 30,
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  timezone: process.env.TZ || 'Asia/Karachi',
};
