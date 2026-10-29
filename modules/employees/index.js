'use strict';
const auth = require('../../core/auth');
const db = require('../../core/db');
const cf = require('../../core/customfields');
const { HttpError, str, int, oneOf, date, bad, today, parseJson } = require('../../core/util');

const STATUSES = ['active', 'inactive', 'resigned', 'terminated'];
const ROLES = ['member', 'team_leader'];
const EVENT_TYPES = ['joined', 'promotion', 'transfer', 'team_change', 'shift_change', 'status_change', 'warning', 'appreciation', 'note', 'rejoined'];

const BASE_SELECT = `
  SELECT e.id, e.emp_code, e.name, e.email, e.phone, e.cnic, e.address, e.date_of_birth, e.gender,
         e.emergency_name, e.emergency_phone, e.designation, e.role, e.status, e.join_date, e.custom,
         e.department_id, e.team_id, e.shift_id,
         d.name AS department_name, t.name AS team_name, s.name AS shift_name
    FROM employees e
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id
    LEFT JOIN shifts s ON s.id=e.shift_id`;

const shape = (r) => r && { ...r, custom: parseJson(r.custom, {}) };

function addHistory(employeeId, type, eventDate, details, by) {
  db.insert('employee_history', { employeeId, eventType: type, eventDate: eventDate || today(), details, recordedBy: by, createdAt: new Date().toISOString() });
}

function input(ctx, existing) {
  const b = ctx.body;
  const departmentId = ctx.user.role === 'admin' ? int(b.departmentId ?? existing?.departmentId, 'Department', { required: true }) : ctx.user.departmentId;
  if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', departmentId)) throw bad('Department not found');
  const teamId = int(b.teamId, 'Team');
  if (teamId && !db.get('SELECT 1 AS x FROM teams WHERE id=? AND department_id=?', teamId, departmentId)) throw bad('Team does not belong to this department');
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
    role: oneOf(b.role, 'Role', ROLES, { def: 'member' }),
    status: oneOf(b.status, 'Status', STATUSES, { def: 'active' }),
    joinDate: date(b.joinDate, 'Join date', { required: true }),
    departmentId, teamId, shiftId,
    custom: JSON.stringify(cf.sanitize('employee', b.custom, existing ? parseJson(existing.custom, {}) : {})),
  };
}

module.exports = {
  id: 'employees',
  name: 'Employees',
  description: 'Employee profiles, joining history and personal PINs.',
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
  ],

  routes(m) {
    const lead = ['admin', 'leader'];

    m.get('/api/employees', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${BASE_SELECT}
          WHERE (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
            AND (? IS NULL OR e.status=?) AND (? IS NULL OR e.role=?) AND (? IS NULL OR e.shift_id=?)
            AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR e.phone LIKE ? OR e.email LIKE ? OR e.designation LIKE ?)
          ORDER BY d.sort, e.name`,
        dept, dept, q.teamId || null, q.teamId || null, q.status || null, q.status || null,
        q.role || null, q.role || null, q.shiftId || null, q.shiftId || null,
        search, search, search, search, search, search).map(shape);
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

    m.get('/api/employees/me', { roles: ['member'] }, (ctx) => {
      const e = shape(db.get(`${BASE_SELECT} WHERE e.id=?`, ctx.user.employeeId));
      return { ...e, history: db.all('SELECT * FROM employee_history WHERE employee_id=? ORDER BY event_date DESC, id DESC', e.id) };
    });

    m.get('/api/employees/:id', { roles: lead }, (ctx) => {
      const e = shape(db.get(`${BASE_SELECT} WHERE e.id=?`, int(ctx.params.id, 'Employee', { required: true })));
      if (!e) throw new HttpError(404, 'Employee not found');
      ctx.assertDept(e.departmentId);
      return { ...e, history: db.all('SELECT * FROM employee_history WHERE employee_id=? ORDER BY event_date DESC, id DESC', e.id) };
    });

    m.post('/api/employees', { roles: lead }, (ctx) => {
      const e = input(ctx, null);
      const pin = auth.generatePin();
      const result = db.tx(() => {
        const next = db.get('SELECT COALESCE(MAX(id),0)+1 AS n FROM employees').n;
        const empCode = `ETX-${String(next).padStart(4, '0')}`;
        const r = db.insert('employees', { ...e, empCode, pinHash: auth.hashSecret(pin), createdAt: new Date().toISOString() });
        addHistory(r.id, 'joined', e.joinDate, `Joined ${db.get('SELECT name FROM departments WHERE id=?', e.departmentId).name} as ${e.designation || 'team member'}`, ctx.user.label);
        return { id: r.id, empCode };
      });
      ctx.audit('create', 'employee', result.id, `${e.name} (${result.empCode})`, e.departmentId);
      return { ...result, pin }; // PIN is shown once; only its hash is stored
    });

    m.put('/api/employees/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Employee', { required: true });
      const old = db.get('SELECT * FROM employees WHERE id=?', id);
      if (!old) throw new HttpError(404, 'Employee not found');
      ctx.assertDept(old.departmentId);
      const e = input(ctx, old);
      const name = (table, rid) => (rid ? db.get(`SELECT name FROM ${table} WHERE id=?`, rid)?.name : 'none');
      db.tx(() => {
        db.update('employees', id, e);
        const by = ctx.user.label;
        if (old.departmentId !== e.departmentId) addHistory(id, 'transfer', today(), `Department: ${name('departments', old.departmentId)} -> ${name('departments', e.departmentId)}`, by);
        else if (old.teamId !== e.teamId) addHistory(id, 'team_change', today(), `Team: ${name('teams', old.teamId)} -> ${name('teams', e.teamId)}`, by);
        if ((old.designation || '') !== (e.designation || '')) addHistory(id, 'promotion', today(), `Designation: ${old.designation || 'none'} -> ${e.designation || 'none'}`, by);
        if (old.shiftId !== e.shiftId) addHistory(id, 'shift_change', today(), `Shift: ${name('shifts', old.shiftId)} -> ${name('shifts', e.shiftId)}`, by);
        if (old.status !== e.status) addHistory(id, e.status === 'active' ? 'rejoined' : 'status_change', today(), `Status: ${old.status} -> ${e.status}`, by);
        if (old.role !== e.role) addHistory(id, 'promotion', today(), `Role: ${old.role} -> ${e.role}`, by);
      });
      if (e.status !== 'active') db.run('DELETE FROM sessions WHERE employee_id=?', id);
      ctx.audit('update', 'employee', id, e.name, e.departmentId);
      return { ok: true };
    });

    m.post('/api/employees/:id/history', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Employee', { required: true });
      const e = db.get('SELECT * FROM employees WHERE id=?', id);
      if (!e) throw new HttpError(404, 'Employee not found');
      ctx.assertDept(e.departmentId);
      const type = oneOf(ctx.body.eventType, 'Event type', EVENT_TYPES, { required: true });
      addHistory(id, type, date(ctx.body.eventDate, 'Date') || today(), str(ctx.body.details, 'Details', { required: true, max: 500 }), ctx.user.label);
      ctx.audit('history_added', 'employee', id, `${type}: ${e.name}`, e.departmentId);
      return { ok: true };
    });

    m.post('/api/employees/:id/reset-pin', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Employee', { required: true });
      const e = db.get('SELECT * FROM employees WHERE id=?', id);
      if (!e) throw new HttpError(404, 'Employee not found');
      ctx.assertDept(e.departmentId);
      const pin = auth.generatePin();
      db.update('employees', id, { pinHash: auth.hashSecret(pin) });
      db.run('DELETE FROM sessions WHERE employee_id=?', id);
      ctx.audit('pin_reset', 'employee', id, e.name, e.departmentId);
      return { pin };
    });
  },
};
