'use strict';
const db = require('../../core/db');
const settings = require('../../core/settings');
const backup = require('../../core/backup');
const modules = require('../../core/modules');
const notify = require('../../core/notify');
const webpush = require('../../core/webpush');
const { HttpError, str, int, date, bad } = require('../../core/util');

module.exports = {
  id: 'system',
  name: 'Settings, Logs & Backups',
  description: 'Company settings, activity log, database backups and module switches.',
  core: true,
  order: 90,

  routes(m) {
    const any = ['admin', 'hod', 'leader', 'member'];
    const lead = ['admin', 'hod']; // the activity log is for the admin and (for their department) the head

    m.get('/api/health', () => ({ ok: true }));

    m.get('/api/public/settings', () => ({ companyName: settings.get('companyName') }));

    m.get('/api/settings', { roles: any }, () => {
      const s = settings.all();
      return { companyName: s.companyName, currency: s.currency, weeklyOff: s.weeklyOff, leaveTypes: s.leaveTypes, expenseCategories: s.expenseCategories, scoreWeights: s.scoreWeights };
    });

    m.put('/api/settings', { roles: ['admin'] }, (ctx) => {
      const b = ctx.body;
      if (b.companyName !== undefined) settings.set('companyName', str(b.companyName, 'Company name', { required: true, max: 60 }));
      if (b.currency !== undefined) {
        const c = str(b.currency, 'Currency', { required: true, max: 3 }).toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a 3-letter code such as USD');
        settings.set('currency', c);
      }
      if (b.weeklyOff !== undefined) {
        const days = (Array.isArray(b.weeklyOff) ? b.weeklyOff : []).map(Number);
        if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || days.length > 6) throw bad('Weekly off days are invalid');
        settings.set('weeklyOff', days);
      }
      if (b.leaveTypes !== undefined) {
        const types = (Array.isArray(b.leaveTypes) ? b.leaveTypes : String(b.leaveTypes).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
        if (!types.length) throw bad('Add at least one leave type');
        settings.set('leaveTypes', types.slice(0, 20));
      }
      if (b.expenseCategories !== undefined) {
        const cats = (Array.isArray(b.expenseCategories) ? b.expenseCategories : String(b.expenseCategories).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
        if (!cats.length) throw bad('Add at least one expense category');
        settings.set('expenseCategories', [...new Set(cats)].slice(0, 40));
      }
      if (b.scoreWeights !== undefined) {
        const w = {};
        for (const k of ['attendance', 'tasks', 'rating']) {
          w[k] = int(b.scoreWeights[k], `${k} weight`, { required: true, min: 0, max: 100 });
        }
        if (w.attendance + w.tasks + w.rating <= 0) throw bad('At least one weight must be above 0');
        settings.set('scoreWeights', w);
      }
      ctx.audit('settings_changed', 'settings', null, Object.keys(b).join(', '), null);
      return { ok: true };
    });

    // ---- modules ----
    m.get('/api/modules', { roles: any }, () => modules.describe());

    m.put('/api/modules/:id', { roles: ['admin'] }, (ctx) => {
      const mod = modules.describe().find((x) => x.id === ctx.params.id);
      if (!mod) throw new HttpError(404, 'Module not found');
      if (mod.core) throw bad('Core modules cannot be disabled');
      const disabled = new Set(settings.get('disabledModules'));
      if (ctx.body.enabled) disabled.delete(mod.id); else disabled.add(mod.id);
      settings.set('disabledModules', [...disabled]);
      ctx.audit('module_toggled', 'module', null, `${mod.name}: ${ctx.body.enabled ? 'enabled' : 'disabled'}`, null);
      return { ok: true };
    });

    // ---- notifications (each role/person only ever sees their own) ----
    m.get('/api/notifications', { roles: any }, (ctx) => {
      const [role, id] = notify.forUser(ctx.user);
      const limit = Math.min(int(ctx.query.limit ?? 30, 'Limit', { min: 1, max: 100 }), 100);
      const items = db.all('SELECT * FROM notifications WHERE recipient_role=? AND recipient_id=? ORDER BY id DESC LIMIT ?', role, id, limit);
      const unread = db.get('SELECT COUNT(*) AS n FROM notifications WHERE recipient_role=? AND recipient_id=? AND read_at IS NULL', role, id).n;
      return { items, unread };
    });

    m.post('/api/notifications/read', { roles: any }, (ctx) => {
      const [role, id] = notify.forUser(ctx.user);
      const now = new Date().toISOString();
      if (ctx.body.all) db.run('UPDATE notifications SET read_at=? WHERE recipient_role=? AND recipient_id=? AND read_at IS NULL', now, role, id);
      else {
        const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 100);
        for (const nid of ids) db.run('UPDATE notifications SET read_at=? WHERE id=? AND recipient_role=? AND recipient_id=? AND read_at IS NULL', now, nid, role, id);
      }
      return { ok: true };
    });

    // ---- push: phone / computer pop-ups (the browser subscribes, the server sends) ----
    m.get('/api/push/key', { roles: any }, () => ({ key: webpush.publicKey() }));

    m.post('/api/push/subscribe', { roles: any }, (ctx) => {
      const s = ctx.body.subscription || {};
      const p256dh = str(s.keys?.p256dh, 'Subscription key', { required: true, max: 200 });
      const authKey = str(s.keys?.auth, 'Subscription secret', { required: true, max: 100 });
      const endpoint = str(s.endpoint, 'Endpoint', { required: true, max: 1000 });
      if (!webpush.validEndpoint(endpoint)) throw bad('This device\'s push service is not supported');
      if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(authKey, 'base64url').length !== 16) throw bad('Invalid subscription keys');
      const [role, id] = notify.forUser(ctx.user);
      // The same browser may be used by different people over time: the newest sign-in owns the endpoint.
      db.run(
        `INSERT INTO push_subscriptions(recipient_role, recipient_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET recipient_role=excluded.recipient_role, recipient_id=excluded.recipient_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent`,
        role, id, endpoint, p256dh, authKey, String(ctx.req.headers['user-agent'] || '').slice(0, 200), new Date().toISOString());
      // Keep at most 10 devices per person.
      db.run('DELETE FROM push_subscriptions WHERE recipient_role=? AND recipient_id=? AND id NOT IN (SELECT id FROM push_subscriptions WHERE recipient_role=? AND recipient_id=? ORDER BY id DESC LIMIT 10)', role, id, role, id);
      return { ok: true };
    });

    m.post('/api/push/unsubscribe', { roles: any }, (ctx) => {
      const [role, id] = notify.forUser(ctx.user);
      db.run('DELETE FROM push_subscriptions WHERE endpoint=? AND recipient_role=? AND recipient_id=?', String(ctx.body.endpoint || ''), role, id);
      return { ok: true };
    });

    m.post('/api/push/test', { roles: any }, (ctx) => {
      const to = ctx.user.role === 'admin' ? { role: 'admin' } : { employeeId: ctx.user.employeeId };
      notify.send(to, { title: 'Test notification', body: 'Notifications are working on this device.', link: '#/dashboard', kind: 'test' });
      return { ok: true };
    });

    // ---- activity log ----
    m.get('/api/logs', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const from = date(q.from, 'from'), to = date(q.to, 'to');
      const limit = Math.min(int(q.limit ?? 200, 'Limit', { min: 1, max: 5000 }), 5000);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `SELECT l.*, d.name AS department_name FROM activity_log l LEFT JOIN departments d ON d.id=l.department_id
          WHERE (? IS NULL OR l.department_id=?) AND (? IS NULL OR l.action=?) AND (? IS NULL OR l.entity=?)
            AND (? IS NULL OR l.ts>=?) AND (? IS NULL OR l.ts<?)
            AND (? IS NULL OR l.actor_name LIKE ? OR l.details LIKE ? OR l.action LIKE ?)
          ORDER BY l.id DESC LIMIT ? OFFSET ?`,
        dept, dept, q.action || null, q.action || null, q.entity || null, q.entity || null,
        from ? new Date(`${from}T00:00:00`).toISOString() : null, from ? new Date(`${from}T00:00:00`).toISOString() : null,
        to ? new Date(`${to}T23:59:59.999`).toISOString() : null, to ? new Date(`${to}T23:59:59.999`).toISOString() : null,
        search, search, search, search, limit, int(q.offset ?? 0, 'Offset', { min: 0 }));
      if (q.format === 'csv') {
        return ctx.csv('activity-log.csv', [
          { label: 'Time', key: 'ts' }, { label: 'Who', key: 'actorName' }, { label: 'Role', key: 'actorRole' },
          { label: 'Department', key: 'departmentName' }, { label: 'Action', key: 'action' }, { label: 'Item', key: 'entity' },
          { label: 'Details', key: 'details' }, { label: 'IP', key: 'ip' },
        ], rows);
      }
      return rows;
    });

    // ---- backups (admin only) ----
    m.get('/api/backups', { roles: ['admin'] }, () => backup.list());

    m.post('/api/backups', { roles: ['admin'] }, (ctx) => {
      const name = backup.create('manual');
      ctx.audit('backup_created', 'backup', null, name, null);
      return { name };
    });

    m.get('/api/backups/:name/download', { roles: ['admin'] }, (ctx) => {
      const p = backup.filePath(ctx.params.name);
      if (!p) throw new HttpError(404, 'Backup not found');
      ctx.audit('backup_downloaded', 'backup', null, ctx.params.name, null);
      return { __file: true, path: p, name: ctx.params.name };
    });
  },
};
