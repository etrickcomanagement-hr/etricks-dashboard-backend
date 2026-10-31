'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const http = require('./http');
const settings = require('./settings');

/*
 * Module contract (modules/<id>/index.js):
 *   id, name, description, order, core (cannot be disabled)
 *   migrations: [sql | fn(db)]  - applied once, in order, tracked per module
 *   routes(m): register API routes with m.get/post/put/patch/del(path, { roles }, handler)
 *   Front-end: public/modules/<id>.js is loaded automatically when it exists.
 * To add a feature (payroll, CRM, ...): create a folder in modules/, nothing else needs editing.
 */
const CORE_MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, department_id INTEGER, employee_id INTEGER,
     label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
   CREATE TABLE activity_log (
     id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor_role TEXT, actor_name TEXT, department_id INTEGER,
     action TEXT NOT NULL, entity TEXT, entity_id INTEGER, details TEXT, ip TEXT);
   CREATE INDEX idx_log_ts ON activity_log(ts);
   CREATE INDEX idx_log_dept ON activity_log(department_id, ts);`,
  `CREATE TABLE notifications (
     id INTEGER PRIMARY KEY, recipient_role TEXT NOT NULL, recipient_id INTEGER NOT NULL DEFAULT 0, kind TEXT,
     title TEXT NOT NULL, body TEXT, link TEXT, created_at TEXT NOT NULL, read_at TEXT);
   CREATE INDEX idx_notif_rcpt ON notifications(recipient_role, recipient_id, id);`,
  `CREATE TABLE push_subscriptions (
     id INTEGER PRIMARY KEY, recipient_role TEXT NOT NULL, recipient_id INTEGER NOT NULL DEFAULT 0,
     endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at TEXT NOT NULL);
   CREATE INDEX idx_push_rcpt ON push_subscriptions(recipient_role, recipient_id);`,
  // 4: every member, team leader and head of department is a person with their own notifications ('employee').
  //    Old department-wide leader notifications and everybody's sessions are dropped: people sign in again.
  `UPDATE notifications SET recipient_role='employee' WHERE recipient_role='member';
   DELETE FROM notifications WHERE recipient_role='leader';
   UPDATE push_subscriptions SET recipient_role='employee' WHERE recipient_role='member';
   DELETE FROM push_subscriptions WHERE recipient_role='leader';
   DELETE FROM sessions;`,
];

const loaded = [];

function migrate(id, migrations = []) {
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (module TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (module, version))');
  migrations.forEach((m, i) => {
    const version = i + 1;
    if (db.get('SELECT 1 AS x FROM schema_migrations WHERE module=? AND version=?', id, version)) return;
    db.tx(() => {
      if (typeof m === 'function') m(db);
      else db.raw.exec(m);
      db.run('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?,?,?)', id, version, new Date().toISOString());
    });
    console.log(`[migrate] ${id} #${version}`);
  });
}

function isEnabled(id) {
  const mod = loaded.find((m) => m.id === id);
  if (!mod) return false;
  return mod.core || !settings.get('disabledModules').includes(id);
}

function loadAll() {
  migrate('core', CORE_MIGRATIONS);
  const dir = path.join(config.root, 'modules');
  const found = fs.readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, 'index.js')))
    .map((n) => require(path.join(dir, n, 'index.js')));
  found.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  for (const mod of found) {
    migrate(mod.id, mod.migrations);
    const reg = (method) => (p, opts, handler) => http.add(method, p, typeof opts === 'function' ? { module: mod.id } : { ...opts, module: mod.id }, handler || opts);
    const m = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') };
    if (mod.routes) mod.routes(m);
    loaded.push(mod);
  }
  http.setModuleGate(isEnabled);
  for (const mod of loaded) if (mod.seed) mod.seed(); // first-run data, must be idempotent
  return loaded;
}

function describe() {
  return loaded.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description || '',
    core: !!m.core,
    enabled: isEnabled(m.id),
    ui: m.ui === false ? null : `/modules/${m.id}.js`, // screens are loaded by the website (a module with no screens sets ui: false)
  }));
}

module.exports = { loadAll, describe, isEnabled };
