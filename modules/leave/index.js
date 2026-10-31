'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const settings = require('../../core/settings');
const { HttpError, int, str, oneOf, date, range, today, addDays, eachDay, parseYmd, bad } = require('../../core/util');

const SELECT = `
  SELECT l.*, e.name AS employee_name, e.emp_code, e.role, e.department_id, e.team_id, d.name AS department_name, t.name AS team_name
    FROM leave_requests l
    JOIN employees e ON e.id=l.employee_id
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id`;

const workingDays = (from, to) => {
  const off = settings.get('weeklyOff');
  return eachDay(from, to).filter((d) => !off.includes(parseYmd(d).getDay())).length;
};

const personOf = (l) => ({ id: l.employeeId, role: l.role, departmentId: l.departmentId, teamId: l.teamId });

module.exports = {
  id: 'leave',
  name: 'Leave Management',
  description: 'Leave requests from members, team leaders and heads, decided by the person above them.',
  order: 40,

  migrations: [
    `CREATE TABLE leave_requests (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), leave_type TEXT NOT NULL,
       from_date TEXT NOT NULL, to_date TEXT NOT NULL, days INTEGER NOT NULL, reason TEXT,
       status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL);
     CREATE INDEX idx_leave_emp ON leave_requests(employee_id, from_date);
     CREATE INDEX idx_leave_status ON leave_requests(status);`,
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['hod', 'leader', 'member'];

    m.get('/api/leave/types', { roles: ['admin', 'hod', 'leader', 'member'] }, () => settings.get('leaveTypes'));

    m.get('/api/leave/me', { roles: self }, (ctx) =>
      db.all(`${SELECT} WHERE l.employee_id=? ORDER BY l.from_date DESC`, ctx.user.employeeId));

    m.post('/api/leave', { roles: self }, (ctx) => {
      const b = ctx.body;
      const from = date(b.fromDate, 'From date', { required: true });
      const to = date(b.toDate, 'To date', { required: true });
      if (to < from) throw bad('"To" date cannot be before "From" date');
      if (from < addDays(today(), -7)) throw bad('Leave cannot start more than 7 days in the past');
      const days = workingDays(from, to);
      if (days < 1) throw bad('The selected dates are all weekly off days');
      if (db.get("SELECT 1 AS x FROM leave_requests WHERE employee_id=? AND status IN ('pending','approved') AND from_date<=? AND to_date>=?", ctx.user.employeeId, to, from)) {
        throw bad('You already have a leave request overlapping these dates');
      }
      const r = db.insert('leave_requests', {
        employeeId: ctx.user.employeeId, leaveType: oneOf(b.leaveType, 'Leave type', settings.get('leaveTypes'), { required: true }),
        fromDate: from, toDate: to, days, reason: str(b.reason, 'Reason', { required: true, max: 500 }), createdAt: new Date().toISOString(),
      });
      ctx.audit('leave_requested', 'leave', r.id, `${from} to ${to} (${days} day/s)`);
      const me = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId);
      notify.toSuperiors(ctx.user.employeeId, { title: `${me.name} requested leave`, body: `${from === to ? from : `${from} to ${to}`} · ${days} working day(s) · ${b.leaveType}`, link: '#/leave', kind: 'leave' });
      return { id: r.id, days };
    });

    m.post('/api/leave/:id/cancel', { roles: self }, (ctx) => {
      const id = int(ctx.params.id, 'Request', { required: true });
      const l = db.get('SELECT * FROM leave_requests WHERE id=? AND employee_id=?', id, ctx.user.employeeId);
      if (!l) throw new HttpError(404, 'Request not found');
      if (l.status !== 'pending') throw bad('Only pending requests can be cancelled');
      db.update('leave_requests', id, { status: 'cancelled' });
      ctx.audit('leave_cancelled', 'leave', id, null);
      return { ok: true };
    });

    m.get('/api/leave', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const { from, to } = range(q, { defFrom: '2000-01-01', defTo: '2999-12-31' });
      const rows = db.all(
        `${SELECT}
          WHERE instr(?, ',' || e.role || ',') > 0 AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
            AND (? IS NULL OR l.status=?) AND (? IS NULL OR l.employee_id=?) AND (? IS NULL OR e.role=?)
            AND l.to_date>=? AND l.from_date<=? AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ?)
          ORDER BY (l.status='pending') DESC, l.from_date DESC LIMIT 2000`,
        ctx.rolesCsv(), dept, dept, team, team, q.status || null, q.status || null, q.employeeId || null, q.employeeId || null,
        q.role || null, q.role || null, from, to,
        q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`).map((l) => ({ ...l, canDecide: ctx.canManage(personOf(l)) }));
      if (q.format === 'csv') {
        return ctx.csv('leave-requests.csv', [
          { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' }, { label: 'Role', key: 'role' }, { label: 'Department', key: 'departmentName' },
          { label: 'Type', key: 'leaveType' }, { label: 'From', key: 'fromDate' }, { label: 'To', key: 'toDate' }, { label: 'Days', key: 'days' },
          { label: 'Reason', key: 'reason' }, { label: 'Status', key: 'status' }, { label: 'Decided by', key: 'decidedBy' }, { label: 'Note', key: 'decisionNote' },
        ], rows);
      }
      return rows;
    });

    // A member's leave is decided by their leader (or head / admin), a leader's by the head (or admin), a head's by the admin.
    m.post('/api/leave/:id/decision', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Request', { required: true });
      const l = db.get(`${SELECT} WHERE l.id=?`, id);
      if (!l) throw new HttpError(404, 'Request not found');
      ctx.assertSee(personOf(l));
      if (!ctx.canManage(personOf(l))) throw new HttpError(403, 'You cannot decide on this leave request');
      if (l.status === 'cancelled') throw bad('This request was cancelled by the employee');
      const status = oneOf(ctx.body.status, 'Decision', ['approved', 'rejected'], { required: true });
      db.update('leave_requests', id, { status, decidedBy: ctx.user.label, decidedAt: new Date().toISOString(), decisionNote: str(ctx.body.note, 'Note', { max: 300 }) });
      ctx.audit(`leave_${status}`, 'leave', id, `${l.employeeName}: ${l.fromDate} to ${l.toDate}`, l.departmentId);
      notify.send({ employeeId: l.employeeId }, { title: `Your leave was ${status}`, body: `${l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} to ${l.toDate}`}${ctx.body.note ? ` · ${ctx.body.note}` : ''}`, link: '#/my-leave', kind: 'leave' });
      return { ok: true };
    });
  },
};
