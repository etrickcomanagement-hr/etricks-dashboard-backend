'use strict';
const db = require('./db');

/*
 * In-app notifications. Recipients:
 *   { role: 'member', employeeId }   one employee
 *   { role: 'leader', departmentId } the team leader portal of a department
 *   { role: 'admin' }                the admin portal
 * send() never throws: a failed notification must not break the action that caused it.
 */
const recipient = (to) => (to.role === 'member' ? ['member', to.employeeId] : to.role === 'leader' ? ['leader', to.departmentId] : ['admin', 0]);
const forUser = (user) => recipient({ role: user.role, employeeId: user.employeeId, departmentId: user.departmentId });

function send(to, { title, body = null, link = null, kind = null }) {
  try {
    const [role, id] = recipient(to);
    if (id == null) return;
    const text = String(title).slice(0, 150);
    const detail = body ? String(body).slice(0, 300) : null;
    const row = db.run(
      'INSERT INTO notifications(recipient_role, recipient_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)',
      role, id, kind, text, detail, link, new Date().toISOString());
    // Also pop up on the person's phone / computer (system notification), even if eTricks is closed.
    require('./webpush').pushTo(role, id, { id: row.id, title: text, body: detail, link, kind });
  } catch (e) {
    console.error('[notify] failed', e.message);
  }
}

// Tell the leader portal of a department and, optionally, the admin as well.
function leaderOf(departmentId, payload, alsoAdmin = false) {
  send({ role: 'leader', departmentId }, payload);
  if (alsoAdmin) send({ role: 'admin' }, payload);
}

const prune = () => db.run("DELETE FROM notifications WHERE created_at < ?", new Date(Date.now() - 90 * 864e5).toISOString());

module.exports = { send, leaderOf, forUser, prune };
