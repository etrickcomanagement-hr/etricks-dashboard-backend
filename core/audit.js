'use strict';
const db = require('./db');

// Append-only activity log. Never throws: logging must not break the action being logged.
function log(ctx, action, entity, entityId, details, departmentId) {
  try {
    const u = ctx.user;
    db.run(
      'INSERT INTO activity_log(ts, actor_role, actor_name, department_id, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?,?,?,?)',
      new Date().toISOString(), u ? u.role : 'anonymous', u ? u.label : null, departmentId ?? null,
      action, entity ?? null, entityId ?? null, details ? String(details).slice(0, 1000) : null, ctx.ip ?? null,
    );
  } catch (e) {
    console.error('[audit] failed', e.message);
  }
}

module.exports = { log };
