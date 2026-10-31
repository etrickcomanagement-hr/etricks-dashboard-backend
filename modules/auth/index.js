'use strict';
const auth = require('../../core/auth');
const accounts = require('../../core/accounts');
const config = require('../../core/config');
const db = require('../../core/db');
const settings = require('../../core/settings');
const credentials = require('../../core/credentials');
const { HttpError, str, int, oneOf, bad } = require('../../core/util');

const cookie = (token, maxAgeSec) =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`;

function startSession(ctx, info) {
  const { token } = auth.createSession(info);
  ctx.res.setHeader('Set-Cookie', cookie(token, config.sessionHours * 3600));
  ctx.user = { role: info.role, label: info.label, departmentId: info.departmentId ?? null, employeeId: info.employeeId ?? null };
}

// What the website needs to know about whoever is signed in (name, department, team).
function publicUser(u) {
  if (!u) return null;
  const out = { role: u.role, label: u.label, departmentId: u.departmentId, employeeId: u.employeeId, name: null, departmentName: null, teamId: null, teamName: null };
  if (u.role === 'admin') return out;
  const e = db.get('SELECT e.name, e.team_id, d.name AS department_name FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=?', u.employeeId);
  if (!e) return out;
  out.name = e.name;
  out.departmentName = e.departmentName;
  // A leader's team is the one they lead; a member's is the one they belong to.
  const team = u.role === 'leader'
    ? db.get('SELECT id, name FROM teams WHERE leader_employee_id=? ORDER BY id LIMIT 1', u.employeeId)
    : u.role === 'member' && e.teamId ? db.get('SELECT id, name FROM teams WHERE id=?', e.teamId) : null;
  if (team) { out.teamId = team.id; out.teamName = team.name; }
  return out;
}

function activeDepartment(id) {
  const dept = db.get('SELECT * FROM departments WHERE id=? AND active=1', id);
  if (!dept) throw new HttpError(404, 'Department not found');
  return dept;
}

const LABELS = {
  hod: (name) => `${name} (Head of Department)`,
  leader: (name) => `${name} (Team Leader)`,
  member: (name) => name,
};

module.exports = {
  id: 'auth',
  name: 'Sign-in & Security',
  description: 'Sign-in for the admin, heads of department, team leaders and members; sessions and brute-force protection.',
  core: true,
  ui: false, // no screens of its own: sign-in is part of the website shell
  order: 5,

  seed() {
    if (settings.get('adminHash')) return;
    // ADMIN_PASSWORD lets a hosted deployment (Railway, Render, a server) start with a password you chose.
    const fromEnv = process.env.ADMIN_PASSWORD;
    if (fromEnv && fromEnv.length >= 8) {
      settings.set('adminHash', auth.hashSecret(fromEnv));
      console.log('[seed] Admin password set from the ADMIN_PASSWORD variable.');
      return;
    }
    const pw = auth.generatePassword();
    settings.set('adminHash', auth.hashSecret(pw));
    credentials.append(`ADMIN PORTAL password : ${pw}`);
    console.log(`[seed] First start: generated ADMIN password (shown once, change it in the Admin portal): ${pw}`);
  },

  routes(m) {
    m.get('/api/auth/me', (ctx) => ({ user: publicUser(ctx.user) }));

    m.get('/api/public/departments', () =>
      db.all('SELECT id, name, slug, color FROM departments WHERE active=1 ORDER BY sort, name'));

    // Team members: step 1 - the team's member password opens the list of that team's names.
    m.post('/api/auth/members', (ctx) => {
      const deptId = int(ctx.body.departmentId, 'Department', { required: true });
      const key = `members|${ctx.ip}|${deptId}`;
      auth.throttle.check(key);
      activeDepartment(deptId);
      const team = accounts.findTeamByPassword(deptId, String(ctx.body.password || ''));
      if (!team) {
        auth.throttle.fail(key);
        throw new HttpError(401, 'Incorrect password');
      }
      auth.throttle.ok(key);
      return {
        team: { id: team.id, name: team.name },
        members: db.all("SELECT id, emp_code, name FROM employees WHERE team_id=? AND role='member' AND status='active' ORDER BY name", team.id),
      };
    });

    m.post('/api/auth/login', (ctx) => {
      const portal = oneOf(ctx.body.portal, 'Portal', ['admin', 'hod', 'leader', 'member'], { required: true });
      const password = String(ctx.body.password || '');
      if (!password) throw bad('Password is required');
      const deptId = portal === 'admin' ? 0 : int(ctx.body.departmentId, 'Department', { required: true });
      const key = `login|${ctx.ip}|${portal}|${deptId}`;
      auth.throttle.check(key);
      const denied = (msg = 'Incorrect password') => {
        auth.throttle.fail(key);
        ctx.user = null;
        ctx.audit('login_failed', 'portal', null, `${portal} portal${deptId ? ` (dept ${deptId})` : ''}`, deptId || null);
        throw new HttpError(401, msg);
      };

      if (portal === 'admin') {
        if (!auth.verifySecret(password, settings.get('adminHash'))) denied();
        auth.throttle.ok(key);
        startSession(ctx, { role: 'admin', label: 'Administrator' });
        ctx.audit('login', 'portal', null, 'Admin portal');
        return { user: publicUser(ctx.user) };
      }

      activeDepartment(deptId);

      // Head of department / team leader: one password each; the password tells us who is signing in.
      if (portal === 'hod' || portal === 'leader') {
        const person = accounts.findEmployeeByPassword(deptId, portal === 'hod' ? 'hod' : 'team_leader', password);
        if (!person) denied();
        auth.throttle.ok(key);
        startSession(ctx, { role: portal, departmentId: deptId, employeeId: person.id, label: LABELS[portal](person.name) });
        ctx.audit('login', 'portal', person.id, portal === 'hod' ? 'Head of department portal' : 'Team leader portal', deptId);
        return { user: publicUser(ctx.user) };
      }

      // Member: the team's member password (it identifies the team) + the person's own PIN.
      const team = accounts.findTeamByPassword(deptId, password);
      if (!team) denied();
      const employeeId = int(ctx.body.employeeId, 'Employee', { required: true });
      const pinKey = `pin|${ctx.ip}|${employeeId}`;
      auth.throttle.check(pinKey);
      const emp = db.get("SELECT * FROM employees WHERE id=? AND team_id=? AND role='member' AND status='active'", employeeId, team.id);
      if (!emp || !auth.verifySecret(String(ctx.body.pin || ''), emp.pinHash)) {
        auth.throttle.fail(pinKey);
        denied('Incorrect PIN');
      }
      auth.throttle.ok(key);
      auth.throttle.ok(pinKey);
      startSession(ctx, { role: 'member', departmentId: deptId, employeeId: emp.id, label: LABELS.member(emp.name) });
      ctx.audit('login', 'portal', emp.id, 'Member portal', deptId);
      return { user: publicUser(ctx.user) };
    });

    m.post('/api/auth/logout', { roles: ['admin', 'hod', 'leader', 'member'] }, (ctx) => {
      ctx.audit('logout', 'portal', null, null);
      auth.destroySession(ctx.user.tokenHash);
      ctx.res.setHeader('Set-Cookie', cookie('', 0));
      return { ok: true };
    });

    m.put('/api/auth/admin-password', { roles: ['admin'] }, (ctx) => {
      const next = str(ctx.body.newPassword, 'New password', { required: true, max: 100 });
      if (next.length < 8) throw bad('Password must be at least 8 characters');
      if (!auth.verifySecret(String(ctx.body.currentPassword || ''), settings.get('adminHash'))) throw new HttpError(401, 'Current password is incorrect');
      settings.set('adminHash', auth.hashSecret(next));
      ctx.audit('password_changed', 'portal', null, 'Admin password changed');
      return { ok: true };
    });
  },
};
