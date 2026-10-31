'use strict';
const db = require('./db');

/*
 * In-app notifications (and phone pop-ups through Web Push). Recipients:
 *   { employeeId }  one person: a member, a team leader or a head of department
 *   { role: 'admin' }
 * send() never throws: a failed notification must not break the action that caused it.
 */
const recipient = (to) => (to.role === 'admin' ? ['admin', 0] : ['employee', to.employeeId]);
const forUser = (user) => recipient({ role: user.role, employeeId: user.employeeId });
const key = (to) => recipient(to).join(':');

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

const headOf = (departmentId) => db.get("SELECT id FROM employees WHERE department_id=? AND role='hod' AND status='active' ORDER BY id LIMIT 1", departmentId)?.id ?? null;
const leaderOfTeam = (teamId) => (teamId ? db.get("SELECT e.id FROM teams t JOIN employees e ON e.id=t.leader_employee_id WHERE t.id=? AND e.status='active'", teamId)?.id ?? null : null);

// The person above somebody: member -> team leader (or the head if the team has none), team leader -> head, head -> admin.
function superiorsOf(employeeId) {
  const e = db.get('SELECT id, role, team_id, department_id FROM employees WHERE id=?', employeeId);
  if (!e) return [];
  const hod = headOf(e.departmentId);
  if (e.role === 'hod') return [{ role: 'admin' }];
  if (e.role === 'team_leader') return hod ? [{ employeeId: hod }] : [{ role: 'admin' }];
  const leader = leaderOfTeam(e.teamId);
  if (leader) return [{ employeeId: leader }];
  return hod ? [{ employeeId: hod }] : [{ role: 'admin' }];
}

// Tell the people above an employee, and optionally also the head and / or the admin.
// exceptEmployeeId / exceptAdmin leave out whoever caused the news (they know already).
function toSuperiors(employeeId, payload, { alsoHead = false, alsoAdmin = false, exceptEmployeeId = null, exceptAdmin = false } = {}) {
  const targets = [...superiorsOf(employeeId)];
  const e = db.get('SELECT department_id, team_id FROM employees WHERE id=?', employeeId);
  if (alsoHead && e) { const h = headOf(e.departmentId); if (h && h !== employeeId) targets.push({ employeeId: h }); }
  if (alsoAdmin) targets.push({ role: 'admin' });
  const seen = new Set();
  for (const t of targets) {
    if (t.employeeId === employeeId || seen.has(key(t))) continue;
    if ((exceptEmployeeId && t.employeeId === exceptEmployeeId) || (exceptAdmin && t.role === 'admin')) continue;
    seen.add(key(t));
    send(t, payload);
  }
}

const toHead = (departmentId, payload) => { const h = headOf(departmentId); if (h) send({ employeeId: h }, payload); };
const toTeamLeader = (teamId, payload) => { const l = leaderOfTeam(teamId); if (l) send({ employeeId: l }, payload); };
const toAdmin = (payload) => send({ role: 'admin' }, payload);

const prune = () => db.run('DELETE FROM notifications WHERE created_at < ?', new Date(Date.now() - 90 * 864e5).toISOString());

module.exports = { send, forUser, superiorsOf, toSuperiors, toHead, toTeamLeader, toAdmin, headOf, leaderOfTeam, prune };
