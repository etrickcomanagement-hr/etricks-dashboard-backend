'use strict';
const auth = require('../../core/auth');
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

// A team leader's own name (set by the admin) is looked up fresh, so a change shows without signing in again.
const leaderName = (u) => (u.role === 'leader' ? db.get('SELECT leader_name FROM departments WHERE id=?', u.departmentId)?.leaderName || null : null);
const publicUser = (u) => u && { role: u.role, label: u.label, departmentId: u.departmentId, employeeId: u.employeeId, name: leaderName(u) };

function activeDepartment(id) {
  const dept = db.get('SELECT * FROM departments WHERE id=? AND active=1', id);
  if (!dept) throw new HttpError(404, 'Department not found');
  return dept;
}

module.exports = {
  id: 'auth',
  name: 'Sign-in & Security',
  description: 'Portal passwords, member PINs, sessions and brute-force protection.',
  core: true,
  ui: false, // no screens of its own: sign-in is part of the website shell
  order: 5,

  seed() {
    if (settings.get('adminHash')) return;
    // ADMIN_PASSWORD lets a hosted deployment (Railway) start with a password you chose.
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

    // Step 1 of member sign-in: department member password unlocks the list of names.
    m.post('/api/auth/members', (ctx) => {
      const deptId = int(ctx.body.departmentId, 'Department', { required: true });
      const key = `members|${ctx.ip}|${deptId}`;
      auth.throttle.check(key);
      const dept = activeDepartment(deptId);
      if (!auth.verifySecret(String(ctx.body.password || ''), dept.memberHash)) {
        auth.throttle.fail(key);
        throw new HttpError(401, 'Incorrect password');
      }
      auth.throttle.ok(key);
      return db.all("SELECT id, emp_code, name FROM employees WHERE department_id=? AND status='active' ORDER BY name", deptId);
    });

    m.post('/api/auth/login', (ctx) => {
      const portal = oneOf(ctx.body.portal, 'Portal', ['admin', 'leader', 'member'], { required: true });
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

      const dept = activeDepartment(deptId);
      if (portal === 'leader') {
        if (!auth.verifySecret(password, dept.leaderHash)) denied();
        auth.throttle.ok(key);
        startSession(ctx, { role: 'leader', departmentId: deptId, label: `Team Leader - ${dept.name}` });
        ctx.audit('login', 'portal', null, 'Team leader portal', deptId);
        return { user: publicUser(ctx.user) };
      }

      // member: department password + personal PIN
      if (!auth.verifySecret(password, dept.memberHash)) denied();
      const employeeId = int(ctx.body.employeeId, 'Employee', { required: true });
      const pinKey = `pin|${ctx.ip}|${employeeId}`;
      auth.throttle.check(pinKey);
      const emp = db.get("SELECT * FROM employees WHERE id=? AND department_id=? AND status='active'", employeeId, deptId);
      if (!emp || !auth.verifySecret(String(ctx.body.pin || ''), emp.pinHash)) {
        auth.throttle.fail(pinKey);
        denied('Incorrect PIN');
      }
      auth.throttle.ok(key);
      auth.throttle.ok(pinKey);
      startSession(ctx, { role: 'member', departmentId: deptId, employeeId: emp.id, label: emp.name });
      ctx.audit('login', 'portal', emp.id, 'Member portal', deptId);
      return { user: publicUser(ctx.user) };
    });

    m.post('/api/auth/logout', { roles: ['admin', 'leader', 'member'] }, (ctx) => {
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
