'use strict';
const auth = require('../../core/auth');
const db = require('../../core/db');
const credentials = require('../../core/credentials');
const { HttpError, str, int, time, bad } = require('../../core/util');

const DEPARTMENTS = [
  ['eBay Department', 'ebay', '#4F8DF7'],
  ['TikTok Shop Department', 'tiktok', '#FF4D79'],
  ['Etsy Department', 'etsy', '#FF8A3D'],
  ['Walmart Department', 'walmart', '#3DB8FF'],
  ['Shopify Department', 'shopify', '#7BD94F'],
  ['Amazon Department', 'amazon', '#FFC23D'],
];

const SHIFTS = [
  ['Day (9 AM - 6 PM)', '09:00', '18:00', 60, 10],
  ['Evening (3 PM - 12 AM)', '15:00', '00:00', 60, 10],
  ['Night (9 PM - 6 AM)', '21:00', '06:00', 60, 10],
];

function validatePassword(pw, label) {
  const s = str(pw, label, { required: true, max: 100 });
  if (s.length < 8) throw bad(`${label} must be at least 8 characters`);
  return s;
}

module.exports = {
  id: 'org',
  name: 'Departments, Teams & Shifts',
  description: 'Department portals, teams with leaders, and shift definitions.',
  core: true,
  order: 10,

  migrations: [
    `CREATE TABLE departments (
       id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#A8FF5A',
       description TEXT, leader_hash TEXT NOT NULL, member_hash TEXT NOT NULL,
       active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
     CREATE TABLE teams (
       id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id),
       name TEXT NOT NULL, leader_employee_id INTEGER, created_at TEXT NOT NULL,
       UNIQUE (department_id, name));
     CREATE TABLE shifts (
       id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
       break_minutes INTEGER NOT NULL DEFAULT 60, grace_minutes INTEGER NOT NULL DEFAULT 10,
       active INTEGER NOT NULL DEFAULT 1);`,
  ],

  seed() {
    if (db.get('SELECT 1 AS x FROM departments LIMIT 1')) return;
    const now = new Date().toISOString();
    db.tx(() => {
      DEPARTMENTS.forEach(([name, slug, color], i) => {
        const leaderPw = auth.generatePassword();
        const memberPw = auth.generatePassword();
        db.insert('departments', { name, slug, color, leaderHash: auth.hashSecret(leaderPw), memberHash: auth.hashSecret(memberPw), sort: (i + 1) * 10, createdAt: now });
        credentials.append(`${name.padEnd(26)} leader password: ${leaderPw}   member password: ${memberPw}`);
      });
      for (const [name, start, end, brk, grace] of SHIFTS) {
        db.insert('shifts', { name, startTime: start, endTime: end, breakMinutes: brk, graceMinutes: grace });
      }
    });
    console.log(`[seed] 6 departments created. Passwords saved to ${credentials.file}`);
  },

  routes(m) {
    const any = ['admin', 'leader', 'member'];
    const lead = ['admin', 'leader'];

    // ---- departments ----
    m.get('/api/departments', { roles: any }, (ctx) => {
      const rows = db.all(
        `SELECT d.id, d.name, d.slug, d.color, d.description, d.active,
                (SELECT COUNT(*) FROM employees e WHERE e.department_id=d.id AND e.status='active') AS employee_count,
                (SELECT COUNT(*) FROM teams t WHERE t.department_id=d.id) AS team_count
           FROM departments d ${ctx.user.role === 'admin' ? '' : 'WHERE d.id=' + Number(ctx.user.departmentId)}
          ORDER BY d.sort, d.name`);
      return rows;
    });

    m.post('/api/departments', { roles: ['admin'] }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { required: true, max: 80 });
      const slug = str(b.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'Slug', { required: true, max: 40 });
      const r = db.insert('departments', {
        name, slug, color: str(b.color, 'Color', { max: 20 }) || '#A8FF5A', description: str(b.description, 'Description', { max: 300 }),
        leaderHash: auth.hashSecret(validatePassword(b.leaderPassword, 'Leader password')),
        memberHash: auth.hashSecret(validatePassword(b.memberPassword, 'Member password')),
        sort: 100, createdAt: new Date().toISOString(),
      });
      ctx.audit('create', 'department', r.id, name, r.id);
      return { id: r.id };
    });

    m.put('/api/departments/:id', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Department', { required: true });
      if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', id)) throw new HttpError(404, 'Department not found');
      const b = ctx.body;
      db.update('departments', id, {
        name: str(b.name, 'Name', { required: true, max: 80 }),
        color: str(b.color, 'Color', { max: 20 }) || '#A8FF5A',
        description: str(b.description, 'Description', { max: 300 }),
        active: b.active === false || b.active === 0 ? 0 : 1,
      });
      ctx.audit('update', 'department', id, b.name, id);
      return { ok: true };
    });

    // Admin may change both passwords; a leader may only change their own department's member password.
    m.put('/api/departments/:id/passwords', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Department', { required: true });
      ctx.assertDept(id);
      if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', id)) throw new HttpError(404, 'Department not found');
      const changed = [];
      if (ctx.body.memberPassword) {
        db.update('departments', id, { memberHash: auth.hashSecret(validatePassword(ctx.body.memberPassword, 'Member password')) });
        changed.push('member');
      }
      if (ctx.body.leaderPassword) {
        if (ctx.user.role !== 'admin') throw new HttpError(403, 'Only the admin can change the leader password');
        db.update('departments', id, { leaderHash: auth.hashSecret(validatePassword(ctx.body.leaderPassword, 'Leader password')) });
        changed.push('leader');
      }
      if (!changed.length) throw bad('Nothing to change');
      ctx.audit('password_changed', 'department', id, `${changed.join(' + ')} portal password`, id);
      return { ok: true };
    });

    // ---- teams ----
    m.get('/api/teams', { roles: any }, (ctx) => {
      const dept = ctx.scopeDept(ctx.query.departmentId);
      return db.all(
        `SELECT t.id, t.name, t.department_id, t.leader_employee_id, d.name AS department_name, l.name AS leader_name,
                (SELECT COUNT(*) FROM employees e WHERE e.team_id=t.id AND e.status='active') AS member_count
           FROM teams t JOIN departments d ON d.id=t.department_id
           LEFT JOIN employees l ON l.id=t.leader_employee_id
          WHERE (? IS NULL OR t.department_id=?) ORDER BY d.sort, t.name`, dept, dept);
    });

    const teamInput = (ctx, existing) => {
      const b = ctx.body;
      const departmentId = existing ? existing.departmentId : ctx.scopeDept(b.departmentId);
      if (!departmentId) throw bad('Department is required');
      ctx.assertDept(departmentId);
      const leaderId = int(b.leaderEmployeeId, 'Team leader');
      if (leaderId && !db.get('SELECT 1 AS x FROM employees WHERE id=? AND department_id=?', leaderId, departmentId)) {
        throw bad('Team leader must be an employee of this department');
      }
      return { departmentId, name: str(b.name, 'Team name', { required: true, max: 80 }), leaderEmployeeId: leaderId };
    };

    m.post('/api/teams', { roles: lead }, (ctx) => {
      const t = teamInput(ctx);
      try {
        const r = db.insert('teams', { ...t, createdAt: new Date().toISOString() });
        ctx.audit('create', 'team', r.id, t.name, t.departmentId);
        return { id: r.id };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw bad('A team with this name already exists in the department');
        throw e;
      }
    });

    m.put('/api/teams/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Team', { required: true });
      const existing = db.get('SELECT * FROM teams WHERE id=?', id);
      if (!existing) throw new HttpError(404, 'Team not found');
      ctx.assertDept(existing.departmentId);
      const t = teamInput(ctx, existing);
      db.update('teams', id, { name: t.name, leaderEmployeeId: t.leaderEmployeeId });
      ctx.audit('update', 'team', id, t.name, existing.departmentId);
      return { ok: true };
    });

    m.del('/api/teams/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Team', { required: true });
      const t = db.get('SELECT * FROM teams WHERE id=?', id);
      if (!t) throw new HttpError(404, 'Team not found');
      ctx.assertDept(t.departmentId);
      if (db.get('SELECT 1 AS x FROM employees WHERE team_id=?', id)) throw bad('Move the employees to another team first');
      db.run('DELETE FROM teams WHERE id=?', id);
      ctx.audit('delete', 'team', id, t.name, t.departmentId);
      return { ok: true };
    });

    // ---- shifts ----
    m.get('/api/shifts', { roles: any }, () => db.all('SELECT * FROM shifts WHERE active=1 ORDER BY start_time'));

    const shiftInput = (b) => ({
      name: str(b.name, 'Name', { required: true, max: 60 }),
      startTime: time(b.startTime, 'Start time', { required: true }),
      endTime: time(b.endTime, 'End time', { required: true }),
      breakMinutes: int(b.breakMinutes ?? 60, 'Break minutes', { min: 0, max: 480 }),
      graceMinutes: int(b.graceMinutes ?? 10, 'Grace minutes', { min: 0, max: 120 }),
    });
    m.post('/api/shifts', { roles: ['admin'] }, (ctx) => {
      const s = shiftInput(ctx.body);
      try {
        const r = db.insert('shifts', s);
        ctx.audit('create', 'shift', r.id, s.name, null);
        return { id: r.id };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw bad('A shift with this name already exists');
        throw e;
      }
    });
    m.put('/api/shifts/:id', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Shift', { required: true });
      const s = shiftInput(ctx.body);
      db.update('shifts', id, { ...s, active: ctx.body.active === false ? 0 : 1 });
      ctx.audit('update', 'shift', id, s.name, null);
      return { ok: true };
    });
  },
};
