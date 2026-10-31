'use strict';
const auth = require('../../core/auth');
const accounts = require('../../core/accounts');
const db = require('../../core/db');
const notify = require('../../core/notify');
const people = require('../../core/people');
const { HttpError, str, int, time, bad, today } = require('../../core/util');

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

const TEAM_SELECT = `
  SELECT t.id, t.name, t.department_id, t.leader_employee_id, d.name AS department_name, l.name AS leader_name,
         (t.member_hash IS NOT NULL) AS has_member_password,
         (SELECT COUNT(*) FROM employees e WHERE e.team_id=t.id AND e.role='member' AND e.status='active') AS member_count
    FROM teams t JOIN departments d ON d.id=t.department_id LEFT JOIN employees l ON l.id=t.leader_employee_id`;

const randomHash = () => auth.hashSecret(auth.generatePassword(24)); // departments no longer have their own sign-in passwords

function loadTeam(id) {
  const t = db.get('SELECT * FROM teams WHERE id=?', id);
  if (!t) throw new HttpError(404, 'Team not found');
  return t;
}

module.exports = {
  id: 'org',
  name: 'Departments, Teams & Shifts',
  description: 'Departments with a head, teams with leaders, member passwords per team, and shifts.',
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
    // 2: (no longer used) a name field on the department
    'ALTER TABLE departments ADD COLUMN leader_name TEXT;',
    // 3: every team has its own member password; the head of department and team leaders sign in with their own password
    'ALTER TABLE teams ADD COLUMN member_hash TEXT;',
  ],

  seed() {
    if (db.get('SELECT 1 AS x FROM departments LIMIT 1')) return;
    const now = new Date().toISOString();
    db.tx(() => {
      DEPARTMENTS.forEach(([name, slug, color], i) => {
        db.insert('departments', { name, slug, color, leaderHash: randomHash(), memberHash: randomHash(), sort: (i + 1) * 10, createdAt: now });
      });
      for (const [name, start, end, brk, grace] of SHIFTS) {
        db.insert('shifts', { name, startTime: start, endTime: end, breakMinutes: brk, graceMinutes: grace });
      }
    });
    console.log('[seed] 6 departments created. Add each head of department from the Admin portal (Departments).');
  },

  routes(m) {
    const any = ['admin', 'hod', 'leader', 'member'];
    const mgmt = ['admin', 'hod', 'leader'];
    const heads = ['admin', 'hod'];

    // ---- departments ----
    m.get('/api/departments', { roles: any }, (ctx) => {
      return db.all(
        `SELECT d.id, d.name, d.slug, d.color, d.description, d.active,
                (SELECT COUNT(*) FROM employees e WHERE e.department_id=d.id AND e.status='active') AS employee_count,
                (SELECT COUNT(*) FROM teams t WHERE t.department_id=d.id) AS team_count,
                (SELECT e.id FROM employees e WHERE e.department_id=d.id AND e.role='hod' AND e.status='active' ORDER BY e.id LIMIT 1) AS head_id,
                (SELECT e.name FROM employees e WHERE e.department_id=d.id AND e.role='hod' AND e.status='active' ORDER BY e.id LIMIT 1) AS head_name
           FROM departments d ${ctx.user.role === 'admin' ? '' : 'WHERE d.id=' + Number(ctx.user.departmentId)}
          ORDER BY d.sort, d.name`);
    });

    m.post('/api/departments', { roles: ['admin'] }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { required: true, max: 80 });
      const slug = str(b.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'Slug', { required: true, max: 40 });
      const r = db.insert('departments', {
        name, slug, color: str(b.color, 'Color', { max: 20 }) || '#A8FF5A', description: str(b.description, 'Description', { max: 300 }),
        leaderHash: randomHash(), memberHash: randomHash(), sort: 100, createdAt: new Date().toISOString(),
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

    // The admin names the department's head and sets (or changes) their password.
    m.put('/api/departments/:id/head', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Department', { required: true });
      const dept = db.get('SELECT * FROM departments WHERE id=?', id);
      if (!dept) throw new HttpError(404, 'Department not found');
      const b = ctx.body;
      const head = db.get("SELECT * FROM employees WHERE department_id=? AND role='hod' AND status='active' ORDER BY id LIMIT 1", id);
      const password = b.password ? accounts.validatePassword(b.password, 'Password') : null;
      if (password) accounts.assertEmployeePasswordFree(id, 'hod', password, head?.id);
      let result;
      if (head) {
        db.update('employees', head.id, {
          name: str(b.name, 'Name', { required: true, max: 100 }), phone: str(b.phone, 'Phone', { max: 30 }), email: str(b.email, 'Email', { max: 120 }),
          ...(password ? { passwordHash: auth.hashSecret(password) } : {}),
        });
        if (password) db.run('DELETE FROM sessions WHERE employee_id=?', head.id); // a new password signs the old session out
        result = { id: head.id, empCode: head.empCode };
        ctx.audit(password ? 'password_changed' : 'update', 'head_of_department', head.id, `${b.name} (${dept.name})`, id);
      } else {
        if (!password) throw bad('Set a password for the head of department');
        result = db.tx(() => people.createEmployee({
          name: str(b.name, 'Name', { required: true, max: 100 }), phone: str(b.phone, 'Phone', { max: 30 }), email: str(b.email, 'Email', { max: 120 }),
          designation: 'Head of Department', role: 'hod', departmentId: id, joinDate: today(), password,
        }, ctx.user.label));
        ctx.audit('create', 'head_of_department', result.id, `${b.name} (${dept.name})`, id);
      }
      return result;
    });

    // ---- teams (the admin and the head of department create them; a leader sees only their own) ----
    m.get('/api/teams', { roles: mgmt }, (ctx) => {
      const dept = ctx.scopeDept(ctx.query.departmentId);
      const team = ctx.scopeTeam(ctx.query.teamId);
      return db.all(`${TEAM_SELECT} WHERE (? IS NULL OR t.department_id=?) AND (? IS NULL OR t.id=?) ORDER BY d.sort, t.name`, dept, dept, team, team);
    });

    m.post('/api/teams', { roles: heads }, (ctx) => {
      const departmentId = ctx.scopeDept(ctx.body.departmentId);
      if (!departmentId) throw bad('Department is required');
      if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', departmentId)) throw bad('Department not found');
      const name = str(ctx.body.name, 'Team name', { required: true, max: 80 });
      try {
        const r = db.insert('teams', { departmentId, name, createdAt: new Date().toISOString() });
        ctx.audit('create', 'team', r.id, name, departmentId);
        return { id: r.id };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw bad('A team with this name already exists in the department');
        throw e;
      }
    });

    m.put('/api/teams/:id', { roles: heads }, (ctx) => {
      const t = loadTeam(int(ctx.params.id, 'Team', { required: true }));
      ctx.assertDept(t.departmentId);
      const name = str(ctx.body.name, 'Team name', { required: true, max: 80 });
      try { db.update('teams', t.id, { name }); } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('A team with this name already exists in the department'); throw e; }
      ctx.audit('update', 'team', t.id, name, t.departmentId);
      return { ok: true };
    });

    m.del('/api/teams/:id', { roles: heads }, (ctx) => {
      const t = loadTeam(int(ctx.params.id, 'Team', { required: true }));
      ctx.assertDept(t.departmentId);
      if (db.get('SELECT 1 AS x FROM employees WHERE team_id=?', t.id)) throw bad('Move everyone out of this team first (use Transfer), then delete it');
      db.run('DELETE FROM teams WHERE id=?', t.id);
      ctx.audit('delete', 'team', t.id, t.name, t.departmentId);
      return { ok: true };
    });

    // The password every member of the team types before their own PIN.
    m.put('/api/teams/:id/member-password', { roles: mgmt }, (ctx) => {
      const t = loadTeam(int(ctx.params.id, 'Team', { required: true }));
      ctx.assertDept(t.departmentId);
      if (ctx.user.role === 'leader' && t.id !== ctx.myTeamId()) throw new HttpError(403, 'You can only change the password of your own team');
      const pw = accounts.validatePassword(ctx.body.password, 'Member password');
      accounts.assertTeamPasswordFree(t.departmentId, pw, t.id);
      db.update('teams', t.id, { memberHash: auth.hashSecret(pw) });
      ctx.audit('password_changed', 'team', t.id, `Member password of ${t.name}`, t.departmentId);
      return { ok: true };
    });

    // Put a team leader in charge of a team: an existing person, or a new person with a password.
    m.post('/api/teams/:id/leader', { roles: heads }, (ctx) => {
      const t = loadTeam(int(ctx.params.id, 'Team', { required: true }));
      ctx.assertDept(t.departmentId);
      const b = ctx.body;
      const password = b.password ? accounts.validatePassword(b.password, 'Password') : null;
      const result = db.tx(() => {
        let leaderId;
        let empCode;
        if (b.employeeId) {
          const e = db.get('SELECT * FROM employees WHERE id=? AND department_id=? AND status=\'active\'', int(b.employeeId, 'Person', { required: true }), t.departmentId);
          if (!e) throw bad('That person is not an active employee of this department');
          if (e.role === 'hod') throw bad('The head of department cannot lead a team');
          const other = db.get('SELECT name FROM teams WHERE leader_employee_id=? AND id<>?', e.id, t.id);
          if (other) throw bad(`${e.name} already leads ${other.name}`);
          if (e.role === 'member' && !password) throw bad('Set a password for the new team leader');
          if (password) accounts.assertEmployeePasswordFree(t.departmentId, 'team_leader', password, e.id);
          db.update('employees', e.id, { role: 'team_leader', teamId: t.id, designation: e.designation || 'Team Leader', ...(password ? { passwordHash: auth.hashSecret(password) } : {}) });
          if (password) db.run('DELETE FROM sessions WHERE employee_id=?', e.id);
          if (e.role === 'member') people.addHistory(e.id, 'promotion', today(), `Became team leader of ${t.name}`, ctx.user.label);
          leaderId = e.id; empCode = e.empCode;
        } else {
          if (!password) throw bad('Set a password for the new team leader');
          accounts.assertEmployeePasswordFree(t.departmentId, 'team_leader', password);
          const made = people.createEmployee({
            name: str(b.name, 'Name', { required: true, max: 100 }), phone: str(b.phone, 'Phone', { max: 30 }), email: str(b.email, 'Email', { max: 120 }),
            designation: 'Team Leader', role: 'team_leader', departmentId: t.departmentId, teamId: t.id, shiftId: int(b.shiftId, 'Shift'), joinDate: today(), password,
          }, ctx.user.label);
          leaderId = made.id; empCode = made.empCode;
        }
        // The previous leader stays an employee (a member without a team) until they are transferred somewhere.
        if (t.leaderEmployeeId && t.leaderEmployeeId !== leaderId) people.stepDown(t.leaderEmployeeId, t.name, ctx.user.label);
        db.update('teams', t.id, { leaderEmployeeId: leaderId });
        return { id: leaderId, empCode };
      });
      const name = db.get('SELECT name FROM employees WHERE id=?', result.id).name;
      ctx.audit('team_leader_set', 'team', t.id, `${name} leads ${t.name}`, t.departmentId);
      notify.send({ employeeId: result.id }, { title: `You are now the team leader of ${t.name}`, body: 'Sign in to the Team Leader portal to manage your team.', link: '#/dashboard', kind: 'team' });
      return result;
    });

    m.del('/api/teams/:id/leader', { roles: heads }, (ctx) => {
      const t = loadTeam(int(ctx.params.id, 'Team', { required: true }));
      ctx.assertDept(t.departmentId);
      db.tx(() => {
        db.update('teams', t.id, { leaderEmployeeId: null });
        if (t.leaderEmployeeId) people.stepDown(t.leaderEmployeeId, t.name, ctx.user.label);
      });
      ctx.audit('team_leader_removed', 'team', t.id, t.name, t.departmentId);
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
