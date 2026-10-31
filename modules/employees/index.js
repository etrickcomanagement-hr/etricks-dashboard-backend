'use strict';
const auth = require('../../core/auth');
const accounts = require('../../core/accounts');
const db = require('../../core/db');
const cf = require('../../core/customfields');
const notify = require('../../core/notify');
const people = require('../../core/people');
const { HttpError, str, int, oneOf, date, bad, today, parseJson } = require('../../core/util');

const STATUSES = ['active', 'inactive', 'resigned', 'terminated'];
const EVENT_TYPES = ['joined', 'promotion', 'transfer', 'team_change', 'shift_change', 'status_change', 'warning', 'appreciation', 'note', 'rejoined'];

const BASE_SELECT = `
  SELECT e.id, e.emp_code, e.name, e.email, e.phone, e.cnic, e.address, e.date_of_birth, e.gender,
         e.emergency_name, e.emergency_phone, e.designation, e.role, e.status, e.join_date, e.custom,
         e.department_id, e.team_id, e.shift_id, (e.password_hash IS NOT NULL) AS has_password, (e.pin_hash IS NOT NULL) AS has_pin,
         d.name AS department_name, t.name AS team_name, s.name AS shift_name,
         (SELECT x.name FROM teams x WHERE x.leader_employee_id=e.id LIMIT 1) AS leads_team
    FROM employees e
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id
    LEFT JOIN shifts s ON s.id=e.shift_id`;

const shape = (r) => r && { ...r, custom: parseJson(r.custom, {}) };

// A PIN chosen by the leader/admin: exactly 6 digits and not trivially guessable. Empty means "generate one".
function chosenPin(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const p = String(v).trim();
  if (!/^\d{6}$/.test(p)) throw bad('PIN must be exactly 6 digits');
  if (/^(\d)\1{5}$/.test(p) || '01234567890123'.includes(p) || '98765432109876'.includes(p)) throw bad('That PIN is too easy to guess (like 111111 or 123456). Choose another.');
  return p;
}

function load(id) {
  const e = db.get('SELECT * FROM employees WHERE id=?', int(id, 'Employee', { required: true }));
  if (!e) throw new HttpError(404, 'Employee not found');
  return e;
}

const history = (id) => db.all('SELECT * FROM employee_history WHERE employee_id=? ORDER BY event_date DESC, id DESC', id);

// Personal details and job info. Department, team and role are not edited here: use Transfer / Teams for those.
function input(ctx, existing) {
  const b = ctx.body;
  const shiftId = int(b.shiftId, 'Shift');
  if (shiftId && !db.get('SELECT 1 AS x FROM shifts WHERE id=?', shiftId)) throw bad('Shift not found');
  const email = str(b.email, 'Email', { max: 120 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email is invalid');
  return {
    name: str(b.name, 'Name', { required: true, max: 100 }),
    email, phone: str(b.phone, 'Phone', { max: 30 }), cnic: str(b.cnic, 'CNIC', { max: 30 }),
    address: str(b.address, 'Address', { max: 300 }), dateOfBirth: date(b.dateOfBirth, 'Date of birth'),
    gender: oneOf(b.gender, 'Gender', ['male', 'female', 'other']),
    emergencyName: str(b.emergencyName, 'Emergency contact', { max: 100 }), emergencyPhone: str(b.emergencyPhone, 'Emergency phone', { max: 30 }),
    designation: str(b.designation, 'Designation', { max: 80 }),
    status: oneOf(b.status, 'Status', STATUSES, { def: existing?.status || 'active' }),
    joinDate: date(b.joinDate, 'Join date', { required: true }),
    shiftId,
    custom: JSON.stringify(cf.sanitize('employee', b.custom, existing ? parseJson(existing.custom, {}) : {})),
  };
}

module.exports = {
  id: 'employees',
  name: 'Employees',
  description: 'Employee profiles, joining history, personal PINs and leader / head passwords.',
  core: true,
  order: 20,

  migrations: [
    `CREATE TABLE employees (
       id INTEGER PRIMARY KEY, emp_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, phone TEXT, cnic TEXT,
       address TEXT, date_of_birth TEXT, gender TEXT, emergency_name TEXT, emergency_phone TEXT,
       designation TEXT, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
       join_date TEXT NOT NULL, department_id INTEGER NOT NULL REFERENCES departments(id),
       team_id INTEGER REFERENCES teams(id), shift_id INTEGER REFERENCES shifts(id),
       pin_hash TEXT, custom TEXT DEFAULT '{}', created_at TEXT NOT NULL);
     CREATE INDEX idx_emp_dept ON employees(department_id, status);
     CREATE TABLE employee_history (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), event_type TEXT NOT NULL,
       event_date TEXT NOT NULL, details TEXT, recorded_by TEXT, created_at TEXT NOT NULL);
     CREATE INDEX idx_hist_emp ON employee_history(employee_id, event_date);`,
    // 2: heads of department and team leaders sign in with their own password
    'ALTER TABLE employees ADD COLUMN password_hash TEXT; CREATE INDEX idx_emp_team ON employees(team_id, status);',
  ],

  routes(m) {
    const staff = ['admin', 'hod', 'leader'];
    const everyone = ['admin', 'hod', 'leader', 'member'];

    m.get('/api/employees', { roles: staff }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${BASE_SELECT}
          WHERE instr(?, ',' || e.role || ',') > 0
            AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
            AND (? IS NULL OR e.status=?) AND (? IS NULL OR e.role=?) AND (? IS NULL OR e.shift_id=?)
            AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR e.phone LIKE ? OR e.email LIKE ? OR e.designation LIKE ?)
            AND (? IS NULL OR e.team_id IS NULL)
          ORDER BY d.sort, CASE e.role WHEN 'hod' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END, t.name, e.name`,
        ctx.rolesCsv(), dept, dept, team, team, q.status || null, q.status || null,
        q.role || null, q.role || null, q.shiftId || null, q.shiftId || null,
        search, search, search, search, search, search,
        q.unassigned ? 1 : null).map(shape);
      if (q.format === 'csv') {
        return ctx.csv('employees.csv', [
          { label: 'Code', key: 'empCode' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'departmentName' },
          { label: 'Team', key: 'teamName' }, { label: 'Designation', key: 'designation' }, { label: 'Role', key: 'role' },
          { label: 'Shift', key: 'shiftName' }, { label: 'Status', key: 'status' }, { label: 'Join date', key: 'joinDate' },
          { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' }, { label: 'CNIC', key: 'cnic' },
          ...cf.definitions('employee').map((d) => ({ label: d.label, value: (r) => r.custom[d.key] })),
        ], rows);
      }
      return rows;
    });

    // Own profile and joining history (members, team leaders and heads of department).
    m.get('/api/employees/me', { roles: ['hod', 'leader', 'member'] }, (ctx) => {
      const e = shape(db.get(`${BASE_SELECT} WHERE e.id=?`, ctx.user.employeeId));
      return { ...e, history: history(e.id) };
    });

    m.get('/api/employees/:id', { roles: staff }, (ctx) => {
      const row = load(ctx.params.id);
      ctx.assertSee(row);
      return { ...shape(db.get(`${BASE_SELECT} WHERE e.id=?`, row.id)), history: history(row.id) };
    });

    // New team members. Heads and team leaders are created from the Teams / Departments screens.
    m.post('/api/employees', { roles: staff }, (ctx) => {
      const teamId = ctx.user.role === 'leader' ? ctx.myTeamId() : int(ctx.body.teamId, 'Team', { required: true });
      const team = teamId > 0 && db.get('SELECT * FROM teams WHERE id=?', teamId);
      if (!team) throw bad(ctx.user.role === 'leader' ? 'You do not lead a team yet, ask the head of department' : 'Choose the team the new member joins');
      ctx.assertDept(team.departmentId);
      const e = input(ctx, null);
      const pin = chosenPin(ctx.body.pin) || auth.generatePin();
      const result = db.tx(() => people.createEmployee({ ...e, role: 'member', departmentId: team.departmentId, teamId: team.id, pin }, ctx.user.label));
      ctx.audit('create', 'employee', result.id, `${e.name} (${result.empCode}) in ${team.name}`, team.departmentId);
      notify.toTeamLeader(team.id, { title: `New member in ${team.name}`, body: `${e.name} joined your team.`, link: '#/employees', kind: 'team' });
      return { ...result, pin }; // only the hash is stored; the PIN is shown once so it can be handed over
    });

    m.put('/api/employees/:id', { roles: staff }, (ctx) => {
      const old = load(ctx.params.id);
      ctx.assertManage(old);
      const e = input(ctx, old);
      db.tx(() => {
        db.update('employees', old.id, e);
        const by = ctx.user.label;
        const name = (table, rid) => (rid ? db.get(`SELECT name FROM ${table} WHERE id=?`, rid)?.name : 'none');
        if ((old.designation || '') !== (e.designation || '')) people.addHistory(old.id, 'promotion', today(), `Designation: ${old.designation || 'none'} -> ${e.designation || 'none'}`, by);
        if (old.shiftId !== e.shiftId) people.addHistory(old.id, 'shift_change', today(), `Shift: ${name('shifts', old.shiftId)} -> ${name('shifts', e.shiftId)}`, by);
        if (old.status !== e.status) people.addHistory(old.id, e.status === 'active' ? 'rejoined' : 'status_change', today(), `Status: ${old.status} -> ${e.status}`, by);
        // A leader who leaves no longer leads the team.
        if (e.status !== 'active' && old.role === 'team_leader') db.run('UPDATE teams SET leader_employee_id=NULL WHERE leader_employee_id=?', old.id);
      });
      if (e.status !== 'active') db.run('DELETE FROM sessions WHERE employee_id=?', old.id);
      ctx.audit('update', 'employee', old.id, e.name, old.departmentId);
      return { ok: true };
    });

    m.post('/api/employees/:id/history', { roles: staff }, (ctx) => {
      const e = load(ctx.params.id);
      ctx.assertManage(e);
      const type = oneOf(ctx.body.eventType, 'Event type', EVENT_TYPES, { required: true });
      people.addHistory(e.id, type, date(ctx.body.eventDate, 'Date') || today(), str(ctx.body.details, 'Details', { required: true, max: 500 }), ctx.user.label);
      ctx.audit('history_added', 'employee', e.id, `${type}: ${e.name}`, e.departmentId);
      return { ok: true };
    });

    // A member's own PIN (set by their leader, their head or the admin).
    m.post('/api/employees/:id/reset-pin', { roles: staff }, (ctx) => {
      const e = load(ctx.params.id);
      if (e.role !== 'member') throw bad('Team leaders and heads sign in with a password, not a PIN');
      ctx.assertManage(e);
      const pin = chosenPin(ctx.body.pin) || auth.generatePin();
      db.update('employees', e.id, { pinHash: auth.hashSecret(pin) });
      db.run('DELETE FROM sessions WHERE employee_id=?', e.id);
      ctx.audit('pin_reset', 'employee', e.id, e.name, e.departmentId);
      return { pin };
    });

    // Password of a team leader (set by their head or the admin) or of a head (set by the admin).
    m.put('/api/employees/:id/password', { roles: ['admin', 'hod'] }, (ctx) => {
      const e = load(ctx.params.id);
      if (e.role === 'member') throw bad('Members use their team password and their own PIN');
      if (e.role === 'hod' && ctx.user.role !== 'admin') throw new HttpError(403, 'Only the admin can change the head of department password');
      ctx.assertManage(e);
      const pw = accounts.validatePassword(ctx.body.password);
      accounts.assertEmployeePasswordFree(e.departmentId, e.role, pw, e.id);
      db.update('employees', e.id, { passwordHash: auth.hashSecret(pw) });
      db.run('DELETE FROM sessions WHERE employee_id=?', e.id); // the old password stops working at once
      ctx.audit('password_changed', e.role === 'hod' ? 'head_of_department' : 'team_leader', e.id, e.name, e.departmentId);
      notify.send({ employeeId: e.id }, { title: 'Your password was changed', body: `${ctx.user.label} set a new password for your account.`, kind: 'security' });
      return { ok: true };
    });
  },
};
