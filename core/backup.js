'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const db = require('./db');
const notify = require('./notify');
const settings = require('./settings');
const { pad } = require('./util');

fs.mkdirSync(config.backupDir, { recursive: true });

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function create(kind = 'manual') {
  const name = `etricks-${kind}-${stamp()}.db`;
  const file = path.join(config.backupDir, name);
  if (fs.existsSync(file)) return name; // pressed twice within the same second: the copy that was just made is the backup
  db.snapshotTo(file);
  prune();
  return name;
}

function list() {
  return fs.readdirSync(config.backupDir)
    .filter((n) => /^etricks-[a-z]+-\d{8}-\d{6}\.db$/.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(config.backupDir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prune() {
  for (const b of list().slice(config.backupKeep)) fs.unlinkSync(path.join(config.backupDir, b.name));
}

function filePath(name) {
  if (!/^etricks-[a-z]+-\d{8}-\d{6}\.db$/.test(name)) return null;
  const p = path.join(config.backupDir, name);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------------------------
// The FULL BACKUP: every N days (30) eTricks makes a complete, verified copy of everything in the
// software (one database holds all of it: people, departments, attendance, leave, tasks, finance,
// sheets, chats, files, settings). The admin is told it is ready and has a few days (7) to download
// it; a copy that is not downloaded in time is deleted. After downloading, the admin can delete it
// from the server. It lives in its own folder, apart from the rolling daily safety copies above.
// ---------------------------------------------------------------------------------------------
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString();

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Opens the finished copy and proves it is sound: SQLite's own integrity check, then the number of tables and rows inside.
function inspect(file) {
  const t = new DatabaseSync(file);
  try {
    const check = t.prepare('PRAGMA integrity_check').all();
    if (!(check.length === 1 && Object.values(check[0])[0] === 'ok')) throw new Error('the database check failed');
    const names = t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    let rows = 0;
    for (const n of names) rows += Number(t.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`).get().n);
    return { tables: names.length, rows };
  } finally { t.close(); }
}

const fullPath = (file) => path.join(config.fullBackupDir, file);

function view(r, now = Date.now()) {
  const status = r.removedAt ? 'deleted' : r.downloadedAt ? 'downloaded' : 'ready';
  return {
    id: r.id, name: r.file, kind: r.kind, createdAt: r.createdAt, size: r.size, sha256: r.sha256, tables: r.tableCount, rows: r.rowCount, status,
    expiresAt: status === 'ready' ? r.expiresAt : null,
    daysLeft: status === 'ready' ? Math.max(0, Math.ceil((Date.parse(r.expiresAt) - now) / DAY)) : null,
    downloadedAt: r.downloadedAt, downloadedBy: r.downloadedBy, removedAt: r.removedAt, removedReason: r.removedReason,
  };
}

function systemLog(action, id, details) {
  try {
    db.run('INSERT INTO activity_log(ts, actor_role, actor_name, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?)',
      new Date().toISOString(), 'system', 'eTricks (automatic)', action, 'backup', id ?? null, String(details).slice(0, 1000));
  } catch (e) { console.error('[backup] log failed', e.message); }
}

function createFull(kind = 'manual', now = Date.now()) {
  fs.mkdirSync(config.fullBackupDir, { recursive: true });
  const name = `etricks-full-${stamp(new Date(now))}.db`;
  const same = db.get('SELECT * FROM full_backups WHERE file=?', name);
  if (same) return view(same); // pressed twice within the same second: the copy that was just made is the backup
  const file = fullPath(name);
  try { fs.unlinkSync(file); } catch { /* nothing left over from an earlier failed try */ }
  let info;
  try {
    db.snapshotTo(file);
    info = inspect(file);
  } catch (e) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    throw new Error(`The backup could not be verified and was discarded (${e.message}). Nothing was changed.`);
  }
  const r = db.insert('full_backups', {
    file: name, kind, createdAt: iso(now), size: fs.statSync(file).size, sha256: sha256File(file), tableCount: info.tables, rowCount: info.rows,
    expiresAt: iso(now + config.fullBackupGraceDays * DAY),
  });
  const row = db.get('SELECT * FROM full_backups WHERE id=?', r.id);
  if (kind === 'auto') {
    systemLog('backup_full_created', row.id, `${name} (${info.tables} tables, ${info.rows} rows)`);
    notify.toAdmin({
      title: `Your ${config.fullBackupDays}-day backup is ready`,
      body: `Download it before ${row.expiresAt.slice(0, 10)}. A backup that is not downloaded is deleted automatically after ${config.fullBackupGraceDays} days.`,
      link: '#/settings', kind: 'backup', urgent: true,
    });
  }
  return view(row);
}

function listFull(limit = 12) {
  return db.all('SELECT * FROM full_backups ORDER BY id DESC LIMIT ?', limit).map((r) => view(r));
}

function removeFull(id, reason) {
  const r = db.get('SELECT * FROM full_backups WHERE id=? AND removed_at IS NULL', id);
  if (!r) return false;
  try { fs.unlinkSync(fullPath(r.file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  db.update('full_backups', id, { removedAt: new Date().toISOString(), removedReason: reason, expiresAt: null });
  return true;
}

function markDownloaded(id, by) {
  const r = db.get('SELECT * FROM full_backups WHERE id=? AND removed_at IS NULL', id);
  if (!r || r.downloadedAt) return;
  db.update('full_backups', id, { downloadedAt: new Date().toISOString(), downloadedBy: by || null, expiresAt: null });
}

function fullFile(id) {
  const r = db.get('SELECT * FROM full_backups WHERE id=? AND removed_at IS NULL', id);
  if (!r) return null;
  const p = fullPath(r.file);
  return fs.existsSync(p) ? { row: r, path: p } : null;
}

// What the admin must be told right now, and when the next automatic backup is due.
function summary(now = Date.now()) {
  const waiting = db.all('SELECT * FROM full_backups WHERE removed_at IS NULL AND downloaded_at IS NULL ORDER BY expires_at').map((r) => view(r, now));
  const last = db.get('SELECT MAX(created_at) AS t FROM full_backups').t || settings.get('fullBackupSince') || null;
  return {
    days: config.fullBackupDays, graceDays: config.fullBackupGraceDays, keep: config.fullBackupKeep,
    nextDue: last ? iso(Date.parse(last) + config.fullBackupDays * DAY) : null,
    alert: waiting.length ? { count: waiting.length, name: waiting[0].name, expiresAt: waiting[0].expiresAt, daysLeft: waiting[0].daysLeft } : null,
  };
}

// Runs at start-up and every hour: delete what was not downloaded in time, warn, tidy up, make the next backup when it is due.
function maintain(now = Date.now()) {
  for (const r of db.all('SELECT * FROM full_backups WHERE removed_at IS NULL')) {
    if (!fs.existsSync(fullPath(r.file))) removeFull(r.id, 'The file was no longer on the server');
  }
  for (const r of db.all('SELECT * FROM full_backups WHERE removed_at IS NULL AND downloaded_at IS NULL ORDER BY id')) {
    const left = (Date.parse(r.expiresAt) - now) / DAY;
    if (left <= 0) {
      removeFull(r.id, `Not downloaded within ${config.fullBackupGraceDays} days`);
      systemLog('backup_full_expired', r.id, `${r.file} was deleted because it was not downloaded in time`);
      notify.toAdmin({ title: 'A backup was deleted because it was not downloaded', body: `The backup of ${r.createdAt.slice(0, 10)} was not downloaded within ${config.fullBackupGraceDays} days. A new one is made on schedule, or press "Create full backup now" in Settings.`, link: '#/settings', kind: 'backup', urgent: true });
      continue;
    }
    const stage = left <= 1 ? 2 : left <= 3 ? 1 : 0;
    if (stage > r.warned) {
      db.update('full_backups', r.id, { warned: stage });
      const days = Math.max(1, Math.ceil(left));
      notify.toAdmin({ title: `Download your backup: it will be deleted in ${days} day${days === 1 ? '' : 's'}`, body: `The backup of ${r.createdAt.slice(0, 10)} is deleted automatically if it is not downloaded. Open Settings & Backups.`, link: '#/settings', kind: 'backup', urgent: stage === 2 });
    }
  }
  // Downloaded copies that are still on the server: only the newest few stay (they are safe on the admin's computer).
  const kept = db.all('SELECT id FROM full_backups WHERE removed_at IS NULL AND downloaded_at IS NOT NULL ORDER BY id DESC');
  for (const r of kept.slice(config.fullBackupKeep)) removeFull(r.id, 'An older copy, already downloaded');
  // Is the next one due? The first period starts the day the system first runs this.
  let since = settings.get('fullBackupSince');
  if (!since) { since = iso(now); settings.set('fullBackupSince', since); }
  const last = db.get('SELECT MAX(created_at) AS t FROM full_backups').t || since;
  if (now - Date.parse(last) >= config.fullBackupDays * DAY) {
    try { console.log('[backup] full backup created', createFull('auto', now).name); } catch (e) { console.error('[backup] full backup failed', e.message); }
  }
}

// One automatic backup per day (taken at start-up if none exists today, then re-checked hourly).
function startScheduler() {
  const check = () => {
    const todayTag = stamp().slice(0, 8);
    if (!list().some((b) => b.name.includes(`-auto-${todayTag}`))) {
      try { console.log('[backup] created', create('auto')); } catch (e) { console.error('[backup] failed', e.message); }
    }
    try { maintain(); } catch (e) { console.error('[backup] full-backup upkeep failed', e.message); }
  };
  check();
  setInterval(check, 3600e3).unref();
}

module.exports = { create, list, filePath, startScheduler, createFull, listFull, removeFull, markDownloaded, fullFile, summary, maintain };
