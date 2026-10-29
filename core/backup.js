'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const { pad } = require('./util');

fs.mkdirSync(config.backupDir, { recursive: true });

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function create(kind = 'manual') {
  const name = `etricks-${kind}-${stamp()}.db`;
  db.snapshotTo(path.join(config.backupDir, name));
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

// One automatic backup per day (taken at start-up if none exists today, then re-checked hourly).
function startScheduler() {
  const check = () => {
    const todayTag = stamp().slice(0, 8);
    if (!list().some((b) => b.name.includes(`-auto-${todayTag}`))) {
      try { console.log('[backup] created', create('auto')); } catch (e) { console.error('[backup] failed', e.message); }
    }
  };
  check();
  setInterval(check, 3600e3).unref();
}

module.exports = { create, list, filePath, startScheduler };
