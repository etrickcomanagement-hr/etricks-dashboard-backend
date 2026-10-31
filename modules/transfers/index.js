'use strict';
const auth = require('../../core/auth');
const db = require('../../core/db');
const notify = require('../../core/notify');
const people = require('../../core/people');
const { HttpError, str, int, bad, today } = require('../../core/util');

/*
 * Moving a team member to another team (or department) keeps everything: the person's profile, joining history,
 * attendance, leave, tasks, orders, salaries and complaints stay attached to them and simply continue in the new team.
 *
 *   admin  moves anybody directly
 *   head   moves members of their department between its teams directly; a move to another department is a request for the admin
 *   leader asks for a move of a member of their team (the head, or the admin for another department, decides)
 *   member asks to move themselves
 */
const TRANSFER_SELECT = `
  SELECT t.*, e.name AS employee_name, e.emp_code
    FROM employee_transfers t JOIN employees e ON e.id=t.employee_id`;

// Tables that belong to a person and also carry a department follow the person to the new department.
const FOLLOWS_PERSON_SKIP = new Set(['employees', 'employee_history', 'employee_transfers', 'notifications', 'push_subscriptions', 'sessions', 'activity_log']);
function personTables() {
  return db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => r.name)
    .filter((n) => !FOLLOWS_PERSON_SKIP.has(n))
    .filter((n) => {
      const cols = db.all(`PRAGMA table_info(${n})`).map((c) => c.name);
      return cols.includes('employee_id') && cols.includes('department_id');
    });
}

function loadTransfer(id) {
  const t = db.get(`${TRANSFER_SELECT} WHERE t.id=?`, int(id, 'Transfer', { required: true }));
  if (!t) throw new HttpError(404, 'Transfer not found');
  return t;
}

// Who may decide on a request: the admin, or the head when the move stays inside their department.
const mayDecide = (user, t) => user.role === 'admin' || (user.role === 'hod' && t.fromDepartmentId === user.departmentId && t.toDepartmentId === user.departmentId);

function tell(targets, payload, exceptEmployeeId) {
  const seen = new Set();
  for (const to of targets) {
    if (!to) continue;
    const k = to.role === 'admin' ? 'admin' : `e${to.employeeId}`;
    if (seen.has(k) || (to.employeeId && to.employeeId === exceptEmployeeId)) continue;
    seen.add(k);
    notify.send(to, payload);
  }
}
const person = (id) => (id ? { employeeId: id } : null);

// Does the move: updates the person, keeps their records with them, writes the history and tells everybody involved.
function perform(t, decidedBy, note, actorEmployeeId) {
  const emp = db.get('SELECT * FROM employees WHERE id=?', t.employeeId);
  if (!emp || emp.status !== 'active') throw bad('This person is not an active employee any more');
  if (emp.role !== 'member') throw bad('Only team members can be transferred. A team leader first steps down from the team (Teams page).');
  const to = db.get('SELECT t.*, d.name AS department_name FROM teams t JOIN departments d ON d.id=t.department_id WHERE t.id=?', t.toTeamId);
  if (!to) throw bad('The destination team does not exist any more');
  if (emp.teamId === to.id) throw bad('That person is already in this team');
  const from = emp.teamId ? db.get('SELECT t.*, d.name AS department_name FROM teams t JOIN departments d ON d.id=t.department_id WHERE t.id=?', emp.teamId) : null;
  const fromDeptId = emp.departmentId;
  const crossDept = fromDeptId !== to.departmentId;
  const fromDeptName = db.get('SELECT name FROM departments WHERE id=?', fromDeptId)?.name;
  const label = (team, dept) => (team ? `${team} (${dept})` : 'no team');
  let newPin = null;

  db.tx(() => {
    const patch = { departmentId: to.departmentId, teamId: to.id };
    if (!emp.pinHash) { newPin = auth.generatePin(); patch.pinHash = auth.hashSecret(newPin); }
    db.update('employees', emp.id, patch);
    if (crossDept) for (const table of personTables()) db.run(`UPDATE ${table} SET department_id=? WHERE employee_id=?`, to.departmentId, emp.id);
    const text = `${label(from?.name, fromDeptName)} -> ${label(to.name, to.departmentName)}${t.reason ? `. Reason: ${t.reason}` : ''}`;
    people.addHistory(emp.id, crossDept ? 'transfer' : 'team_change', today(), `Transferred: ${text}`, decidedBy);
    db.update('employee_transfers', t.id, {
      status: 'done', decidedBy, decidedAt: new Date().toISOString(), decisionNote: note || null,
      fromTeamName: from?.name ?? null, fromDepartmentName: fromDeptName, toTeamName: to.name, toDepartmentName: to.departmentName,
      fromTeamId: from?.id ?? null, fromDepartmentId: fromDeptId, toDepartmentId: to.departmentId,
    });
  });
  db.run('DELETE FROM sessions WHERE employee_id=?', emp.id); // they sign in again with the new team's password

  const payload = (body) => ({ title: `Transfer: ${emp.name}`, body, link: '#/transfers', kind: 'transfer' });
  const summary = `${emp.name} moved from ${label(from?.name, fromDeptName)} to ${label(to.name, to.departmentName)}.`;
  tell([person(emp.id)], { title: 'You were moved to another team', body: `You are now in ${to.name} (${to.departmentName}). Use your new team's password to sign in; your PIN stays the same${newPin ? ' (ask your leader for it)' : ''}.`, link: '#/dashboard', kind: 'transfer' }, actorEmployeeId);
  tell([person(notify.leaderOfTeam(from?.id)), person(notify.leaderOfTeam(to.id)), person(notify.headOf(fromDeptId)), person(notify.headOf(to.departmentId)), { role: 'admin' }], payload(summary), actorEmployeeId);
  return { fromDepartmentId: fromDeptId, toDepartmentId: to.departmentId, pin: newPin, summary };
}

module.exports = {
  id: 'transfers',
  name: 'Transfers',
  description: 'Move a member to another team or department and keep their full history.',
  core: true,
  order: 25,

  migrations: [
    `CREATE TABLE employee_transfers (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
       from_team_id INTEGER, from_department_id INTEGER NOT NULL, to_team_id INTEGER NOT NULL, to_department_id INTEGER NOT NULL,
       from_team_name TEXT, from_department_name TEXT, to_team_name TEXT, to_department_name TEXT,
       status TEXT NOT NULL DEFAULT 'pending', reason TEXT,
       requested_by TEXT, requested_by_employee_id INTEGER, requested_at TEXT NOT NULL,
       decided_by TEXT, decided_at TEXT, decision_note TEXT);
     CREATE INDEX idx_transfer_emp ON employee_transfers(employee_id, id);
     CREATE INDEX idx_transfer_status ON employee_transfers(status, id);`,
  ],

  routes(m) {
    const everyone = ['admin', 'hod', 'leader', 'member'];

    // Every team a person could move to (names only).
    m.get('/api/transfers/targets', { roles: everyone }, () => db.all(
      `SELECT t.id, t.name, t.department_id, d.name AS department_name, l.name AS leader_name
         FROM teams t JOIN departments d ON d.id=t.department_id LEFT JOIN employees l ON l.id=t.leader_employee_id
        WHERE d.active=1 ORDER BY d.sort, t.name`));

    m.get('/api/transfers', { roles: everyone }, (ctx) => {
      const u = ctx.user;
      const where = [];
      const args = [];
      if (u.role === 'hod') { where.push('(t.from_department_id=? OR t.to_department_id=?)'); args.push(u.departmentId, u.departmentId); }
      if (u.role === 'leader') { const mine = ctx.myTeamId(); where.push('(t.from_team_id=? OR t.to_team_id=?)'); args.push(mine, mine); }
      if (u.role === 'member') { where.push('t.employee_id=?'); args.push(u.employeeId); }
      if (ctx.query.status) { where.push('t.status=?'); args.push(ctx.query.status); }
      if (ctx.query.employeeId) { where.push('t.employee_id=?'); args.push(Number(ctx.query.employeeId)); }
      return db.all(`${TRANSFER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (t.status='pending') DESC, t.id DESC LIMIT 300`, ...args)
        .map((t) => ({ ...t, canDecide: t.status === 'pending' && mayDecide(u, t), canCancel: t.status === 'pending' && (mayDecide(u, t) || t.requestedByEmployeeId === u.employeeId) }));
    });

    m.post('/api/transfers', { roles: everyone }, (ctx) => {
      const u = ctx.user;
      const emp = db.get('SELECT * FROM employees WHERE id=?', u.role === 'member' ? u.employeeId : int(ctx.body.employeeId, 'Person', { required: true }));
      if (!emp) throw new HttpError(404, 'Employee not found');
      if (u.role !== 'member') ctx.assertManage(emp);
      if (emp.role !== 'member') throw bad('Only team members can be transferred. A team leader first steps down from the team (Teams page).');
      if (emp.status !== 'active') throw bad('This person is not active');
      const to = db.get('SELECT t.*, d.name AS department_name FROM teams t JOIN departments d ON d.id=t.department_id WHERE t.id=?', int(ctx.body.toTeamId, 'Destination team', { required: true }));
      if (!to) throw bad('Destination team not found');
      if (emp.teamId === to.id) throw bad('That person is already in this team');
      if (db.get("SELECT 1 AS x FROM employee_transfers WHERE employee_id=? AND status='pending'", emp.id)) throw bad('There is already a pending transfer request for this person');
      const from = emp.teamId ? db.get('SELECT t.*, d.name AS department_name FROM teams t JOIN departments d ON d.id=t.department_id WHERE t.id=?', emp.teamId) : null;
      const reason = str(ctx.body.reason, 'Reason', { max: 300 });

      const row = db.insert('employee_transfers', {
        employeeId: emp.id, fromTeamId: from?.id ?? null, fromDepartmentId: emp.departmentId, toTeamId: to.id, toDepartmentId: to.departmentId,
        fromTeamName: from?.name ?? null, fromDepartmentName: db.get('SELECT name FROM departments WHERE id=?', emp.departmentId).name,
        toTeamName: to.name, toDepartmentName: to.departmentName,
        status: 'pending', reason, requestedBy: u.label, requestedByEmployeeId: u.employeeId ?? null, requestedAt: new Date().toISOString(),
      });
      const t = loadTransfer(row.id);

      if (mayDecide(u, t) && u.role !== 'member') { // admin, or the head within their own department: done at once
        const done = perform(t, u.label, null, u.employeeId);
        ctx.audit('transfer', 'employee', emp.id, done.summary, t.fromDepartmentId);
        return { id: t.id, status: 'done', pin: done.pin, summary: done.summary };
      }
      ctx.audit('transfer_requested', 'employee', emp.id, `${emp.name}: ${t.fromTeamName || 'no team'} -> ${t.toTeamName}`, t.fromDepartmentId);
      const sameDept = t.fromDepartmentId === t.toDepartmentId;
      tell(
        [sameDept ? person(notify.headOf(t.fromDepartmentId)) : { role: 'admin' }, person(notify.leaderOfTeam(t.fromTeamId)), person(notify.leaderOfTeam(t.toTeamId))],
        { title: 'Transfer request', body: `${u.label} asks to move ${emp.name} from ${t.fromTeamName || 'no team'} to ${t.toTeamName} (${t.toDepartmentName}).`, link: '#/transfers', kind: 'transfer' },
        u.employeeId);
      return { id: t.id, status: 'pending' };
    });

    m.put('/api/transfers/:id/approve', { roles: ['admin', 'hod'] }, (ctx) => {
      const t = loadTransfer(ctx.params.id);
      if (t.status !== 'pending') throw bad('This request was already decided');
      if (!mayDecide(ctx.user, t)) throw new HttpError(403, 'Only the admin can approve a move to another department');
      const done = perform(t, ctx.user.label, str(ctx.body.note, 'Note', { max: 300 }), ctx.user.employeeId);
      ctx.audit('transfer', 'employee', t.employeeId, done.summary, t.fromDepartmentId);
      return { ok: true, pin: done.pin, summary: done.summary };
    });

    m.put('/api/transfers/:id/reject', { roles: ['admin', 'hod'] }, (ctx) => {
      const t = loadTransfer(ctx.params.id);
      if (t.status !== 'pending') throw bad('This request was already decided');
      if (!mayDecide(ctx.user, t)) throw new HttpError(403, 'Only the admin can decide on a move to another department');
      const note = str(ctx.body.note, 'Note', { max: 300 });
      db.update('employee_transfers', t.id, { status: 'rejected', decidedBy: ctx.user.label, decidedAt: new Date().toISOString(), decisionNote: note });
      ctx.audit('transfer_rejected', 'employee', t.employeeId, `${t.employeeName}: ${t.toTeamName}`, t.fromDepartmentId);
      tell([person(t.requestedByEmployeeId), person(t.employeeId)], { title: 'Transfer request declined', body: `${t.employeeName} stays in ${t.fromTeamName || 'the current team'}.${note ? ` Note: ${note}` : ''}`, link: '#/transfers', kind: 'transfer' }, ctx.user.employeeId);
      return { ok: true };
    });

    // The person who asked (or whoever may decide) can withdraw a request that is still waiting.
    m.del('/api/transfers/:id', { roles: everyone }, (ctx) => {
      const t = loadTransfer(ctx.params.id);
      if (t.status !== 'pending') throw bad('Only a pending request can be cancelled');
      const own = t.requestedByEmployeeId != null && t.requestedByEmployeeId === ctx.user.employeeId;
      if (!own && !mayDecide(ctx.user, t)) throw new HttpError(403, 'You cannot cancel this request');
      db.update('employee_transfers', t.id, { status: 'cancelled', decidedBy: ctx.user.label, decidedAt: new Date().toISOString() });
      ctx.audit('transfer_cancelled', 'employee', t.employeeId, t.employeeName, t.fromDepartmentId);
      return { ok: true };
    });
  },
};
