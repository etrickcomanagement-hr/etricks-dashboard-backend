'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { camel, snakeKey } = require('./util');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
// WAL + synchronous NORMAL is the standard fast setting: a power cut can lose the very last moments, never corrupt the database.
// (The default, FULL, waits for the disk on every single save, which is slow on a shared cloud disk.)
db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -32768; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 134217728; PRAGMA journal_size_limit = 33554432;');

const cache = new Map();
const prep = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};
const bind = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));

const all = (sql, ...p) => prep(sql).all(...bind(p)).map(camel);
const get = (sql, ...p) => {
  const r = prep(sql).get(...bind(p));
  return r ? camel(r) : null;
};
const run = (sql, ...p) => {
  const r = prep(sql).run(...bind(p));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Table/column names always come from code, never from user input.
function insert(table, data) {
  const keys = Object.keys(data);
  return run(
    `INSERT INTO ${table} (${keys.map(snakeKey).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => data[k]),
  );
}
function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return { changes: 0 };
  return run(`UPDATE ${table} SET ${keys.map((k) => snakeKey(k) + '=?').join(',')} WHERE id=?`, ...keys.map((k) => data[k]), id);
}

// Consistent online snapshot (safe while the app is running).
function snapshotTo(file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

// Called when the server stops (and once a day): the planner statistics are refreshed and the write-ahead log is folded into the file.
function tidy() {
  try { db.exec('PRAGMA optimize'); db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (e) { console.error('[db] tidy failed', e.message); }
}
function close() {
  try { db.exec('PRAGMA optimize'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ }
}

module.exports = { all, get, run, tx, insert, update, snapshotTo, tidy, close, raw: db };
