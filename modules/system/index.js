'use strict';
const db = require('../../core/db');
const settings = require('../../core/settings');
const backup = require('../../core/backup');
const modules = require('../../core/modules');
const notify = require('../../core/notify');
const currency = require('../../core/currency');
const webpush = require('../../core/webpush');
const metrics = require('../../core/metrics');
const { HttpError, str, int, date, bad } = require('../../core/util');

module.exports = {
  id: 'system',
  name: 'Settings, Logs & Backups',
  description: 'Company settings, activity log, database backups and module switches.',
  core: true,
  order: 90,

  migrations: [
    // The full backups made every 30 days: one row each, kept as a history even after the file is deleted.
    `CREATE TABLE full_backups (
       id INTEGER PRIMARY KEY, file TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, created_at TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
       table_count INTEGER, row_count INTEGER, expires_at TEXT, downloaded_at TEXT, downloaded_by TEXT, warned INTEGER NOT NULL DEFAULT 0,
       removed_at TEXT, removed_reason TEXT);`,
  ],

  routes(m) {
    const any = ['admin', 'hod', 'leader', 'member', 'client'];
    const lead = ['admin', 'hod']; // the activity log is for the admin and (for their department) the head

    // Answers only when the database answers too (the watchdog on the server restarts the service when this stops answering).
    m.get('/api/health', () => { db.get('SELECT 1 AS ok'); return { ok: true, uptime: Math.round(process.uptime()) }; });
    // The website tells the server when a screen failed (blank page, broken screen), so it is seen in the log and under Settings.
    // No sign-in needed (it may be the sign-in page itself that failed); small, and limited per visitor.
    const reported = new Map();
    m.post('/api/public/client-error', { maxBody: 6000 }, (ctx) => {
      const now = Date.now();
      const rec = reported.get(ctx.ip) || { n: 0, since: now };
      if (now - rec.since > 60e3) { rec.n = 0; rec.since = now; }
      reported.set(ctx.ip, rec);
      if (reported.size > 2000) reported.clear();
      if (++rec.n > 10) return { ok: true }; // enough from one visitor
      const clip = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
      const e = { message: clip(ctx.body.message, 300), where: clip(ctx.body.where, 80), page: clip(ctx.body.page, 60), role: clip(ctx.body.role, 12), agent: clip(ctx.body.agent, 120) };
      metrics.browserError(e);
      console.warn(`[browser-error] ${e.role || 'visitor'} ${e.page} ${e.where}: ${e.message} | ${e.agent}`);
      return { ok: true };
    });
    // How the server is doing since it started: slowest routes, how long it was stuck, memory. The admin only; no request content.
    m.get('/api/metrics', { roles: ['admin'] }, () => metrics.snapshot());
    m.post('/api/metrics/reset', { roles: ['admin'] }, () => { metrics.reset(); return { ok: true }; });

    m.get('/api/public/settings', () => ({ companyName: settings.get('companyName') }));

    m.get('/api/settings', { roles: any }, (ctx) => {
      const s = settings.all();
      if (ctx.user.role === 'client') return { companyName: s.companyName, currency: s.currency };
      return { companyName: s.companyName, currency: s.currency, weeklyOff: s.weeklyOff, leaveTypes: s.leaveTypes, expenseCategories: s.expenseCategories, scoreWeights: s.scoreWeights, fxRates: currency.rates() };
    });

    m.put('/api/settings', { roles: ['admin'] }, (ctx) => {
      const b = ctx.body;
      if (b.companyName !== undefined) settings.set('companyName', str(b.companyName, 'Company name', { required: true, max: 60 }));
      if (b.currency !== undefined) {
        const c = str(b.currency, 'Currency', { required: true, max: 3 }).toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a 3-letter code such as USD');
        settings.set('currency', c);
      }
      if (b.fxRates !== undefined) {
        const r = {};
        for (const c of currency.CURRENCIES) {
          const n = Number(b.fxRates?.[c]);
          if (!Number.isFinite(n) || n <= 0 || n > 100000) throw bad(`The rate of ${c} must be a number above 0`);
          r[c] = Math.round(n * 1e6) / 1e6;
        }
        settings.set('fxRates', r);
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
      const to = ctx.user.role === 'admin' ? { role: 'admin' } : ctx.user.role === 'client' ? { clientId: ctx.user.clientId } : { employeeId: ctx.user.employeeId };
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

    // ---- full backups: every 30 days, download within 7 days or they are deleted (admin only) ----
    m.get('/api/backups/full', { roles: ['admin'] }, () => ({ ...backup.summary(), items: backup.listFull() }));
    m.get('/api/backups/summary', { roles: ['admin'] }, () => backup.summary()); // light call for the warning bar

    m.post('/api/backups/full', { roles: ['admin'] }, (ctx) => {
      let b;
      try { b = backup.createFull('manual'); } catch (e) { throw bad(e.message); }
      ctx.audit('backup_full_created', 'backup', b.id, `${b.name} (${b.tables} tables, ${b.rows} rows)`, null);
      return b;
    });

    m.get('/api/backups/full/:id/download', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Backup', { required: true });
      const f = backup.fullFile(id);
      if (!f) throw new HttpError(404, 'This backup is no longer on the server');
      ctx.audit('backup_full_download_started', 'backup', id, f.row.file, null);
      // It counts as downloaded only once the whole file has been sent; then it no longer expires.
      return {
        __file: true, path: f.path, name: f.row.file,
        onDone: () => { backup.markDownloaded(id, ctx.user.label); ctx.audit('backup_full_downloaded', 'backup', id, f.row.file, null); },
      };
    });

    // After downloading, the admin can remove the copy from the server. A copy that was never downloaded cannot be deleted by mistake.
    m.del('/api/backups/full/:id', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Backup', { required: true });
      const f = backup.fullFile(id);
      if (!f) throw new HttpError(404, 'This backup is no longer on the server');
      if (!f.row.downloadedAt) throw bad('Download this backup first. It can be deleted from the server only after you have downloaded it.');
      backup.removeFull(id, 'Deleted by the admin after downloading');
      ctx.audit('backup_full_deleted', 'backup', id, f.row.file, null);
      return { ok: true };
    });

    // ---- daily safety copies (admin only) ----
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
