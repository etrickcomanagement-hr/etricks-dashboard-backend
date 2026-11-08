'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// On Railway, attach a Volume: its mount path is picked up automatically so the database survives redeploys.
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const onRender = !!process.env.RENDER; // Render sets RENDER=true; attach a Disk and set DATA_DIR to its mount path
const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data'));

module.exports = {
  root,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || (onRailway || onRender ? '0.0.0.0' : '127.0.0.1'),
  onRailway,
  onRender,
  hasPersistentStorage: !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  dataDir,
  dbFile: path.join(dataDir, 'etricks.db'),
  backupDir: path.join(dataDir, 'backups'),
  backupKeep: Number(process.env.BACKUP_KEEP) || 30,
  // The full backup: a complete copy of everything, made every N days for the admin to download.
  fullBackupDir: path.join(dataDir, 'backups', 'full'),
  fullBackupDays: Number(process.env.FULL_BACKUP_DAYS) || 30,
  fullBackupGraceDays: Number(process.env.FULL_BACKUP_GRACE_DAYS) || 7, // days the admin has to download it before it is deleted
  fullBackupKeep: Number(process.env.FULL_BACKUP_KEEP) || 3, // downloaded copies that stay on the server (the newest ones)
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  timezone: process.env.TZ || 'Asia/Karachi',
};
