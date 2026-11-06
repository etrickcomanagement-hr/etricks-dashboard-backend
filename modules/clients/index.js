'use strict';
const auth = require('../../core/auth');
const accounts = require('../../core/accounts');
const db = require('../../core/db');
const notify = require('../../core/notify');
const { HttpError, str, int, num, date, oneOf, bad, today, addDays, round } = require('../../core/util');

/*
 * Clients. Every department can have client portals. The admin creates each client (a client ID + password) and keeps the
 * private details; the client sees only their own sales and a chat with "eTricks".
 *
 *   - Team members write the day's work (orders, investment, sales ...) against the client ID. The client sees the numbers
 *     and the notes, labelled "eTricks": never the name of the person who wrote them.
 *   - Two chats per client: "inquiry" (ordinary messages) and "alert" (urgent: an OTP, a confidential detail, ...). Alerts
 *     raise a loud notification on the other side and are never put into notification texts.
 *   - The admin picks WHICH people work for a client (the team leader and members, chosen one by one). Only those people, the
 *     head of the department and the admin can see that client, its chat and its alerts. Nobody is added just because they are
 *     in the same team. Staff see only the client ID; the real name, contact and secret details are for the admin.
 *   - A chat is private to the person who answers it. While nobody has answered, the chosen people (and the head) can read and
 *     answer it; the first reply makes that person the owner, and from then on only the owner and the admin can read the
 *     conversation or get its notifications. The owner or the admin can release it; the admin can hand it to someone else.
 */
const STAFF = ['admin', 'hod', 'leader', 'member'];
const CHANNELS = ['inquiry', 'alert'];
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/;

const revenueOf = (r) => round((r.sales || 0) - (r.investment || 0));
const sums = (rows) => {
  const t = { orders: 0, investment: 0, sales: 0 };
  for (const r of rows) { t.orders += r.orders; t.investment += r.investment; t.sales += r.sales; }
  return { orders: t.orders, investment: round(t.investment), sales: round(t.sales), revenue: round(t.sales - t.investment) };
};

// ---- who may see which client ----
function myTeam(ctx) {
  if (ctx.user.role === 'leader') return ctx.myTeamId();
  if (ctx.user.role === 'member') return db.get('SELECT team_id FROM employees WHERE id=?', ctx.user.employeeId)?.teamId ?? -1;
  return null;
}
// The clients this leader / member was chosen for (read once per request).
function assignedTo(ctx) {
  return (ctx.assignedClients ||= new Set(db.all('SELECT client_id FROM client_staff WHERE employee_id=?', ctx.user.employeeId).map((r) => r.clientId)));
}
function inScope(ctx, c) {
  if (ctx.user.role === 'admin') return true;
  if (c.departmentId !== ctx.user.departmentId) return false;
  if (ctx.user.role === 'hod') return true;
  // chosen for this client, and still in the client's team (a person who moved to another team loses the client)
  return assignedTo(ctx).has(c.id) && (c.teamId == null || c.teamId === myTeam(ctx));
}
function staffClient(ctx, id) {
  const c = db.get(`${CLIENT_SELECT} WHERE c.id=?`, int(id, 'Client', { required: true }));
  if (!c || !inScope(ctx, c)) throw new HttpError(404, 'Client not found'); // a stranger is not told it exists
  return c;
}

const CLIENT_SELECT = `
  SELECT c.*, d.name AS department_name, t.name AS team_name
    FROM clients c JOIN departments d ON d.id=c.department_id LEFT JOIN teams t ON t.id=c.team_id`;

// The staff view of a client: the ID only. The admin also gets the private details (but never the secret text here).
function shape(ctx, c) {
  const base = { id: c.id, username: c.username, departmentId: c.departmentId, teamId: c.teamId, status: c.status };
  if (ctx.user.role !== 'admin') return base;
  return { ...base, displayName: c.displayName, contact: c.contact, departmentName: c.departmentName, teamName: c.teamName, hasSecret: !!c.secretInfo, lastLoginAt: c.lastLoginAt, createdAt: c.createdAt, staffCount: staffIds(c).length };
}

// The person who is answering this client's chat (null = nobody yet). An owner who left the client, the department or the
// company no longer counts, so the chat is never locked behind someone who cannot open it.
function chatOwner(c) {
  if (!c.chatOwnerId) return null;
  const e = db.get("SELECT id, name, role, department_id, status FROM employees WHERE id=?", c.chatOwnerId);
  if (!e || e.status !== 'active' || e.departmentId !== c.departmentId) return null;
  if (e.role === 'hod' || staffIds(c).includes(e.id)) return e;
  return null;
}
// Admin: always. Everyone else: only while the chat has no owner, or when they are the owner.
function canReadChat(ctx, c) {
  if (ctx.user.role === 'admin') return true;
  const o = chatOwner(c);
  return !o || o.id === ctx.user.employeeId;
}
function chatGate(ctx, c) {
  if (!canReadChat(ctx, c)) throw new HttpError(403, 'This conversation is private to the colleague who is answering this client');
}
// 'open' (nobody yet), 'mine' or 'colleague'; the admin also learns who.
function chatInfo(ctx, c) {
  const o = chatOwner(c);
  const state = !o ? 'open' : o.id === ctx.user.employeeId ? 'mine' : 'colleague';
  return ctx.user.role === 'admin' ? { chat: state, chatOwnerId: o?.id ?? null, chatOwnerName: o?.name ?? null } : { chat: state };
}

// The people chosen for a client who can still work on it (active, same department, same team when the client has one).
const ASSIGNED_SQL = `SELECT e.id, e.name, e.role, e.team_id, t.name AS team_name FROM client_staff s
  JOIN employees e ON e.id=s.employee_id LEFT JOIN teams t ON t.id=e.team_id
  WHERE s.client_id=? AND e.status='active' AND e.department_id=? AND (? IS NULL OR e.team_id=?) ORDER BY e.role DESC, e.name`;
const staffRows = (c) => db.all(ASSIGNED_SQL, c.id, c.departmentId, c.teamId ?? null, c.teamId ?? null);
const staffIds = (c) => staffRows(c).map((e) => e.id);

// Everyone who works with a client: the chosen people, the head of the department and the admin.
function staffOf(c) {
  const heads = db.all("SELECT id FROM employees WHERE status='active' AND role='hod' AND department_id=?", c.departmentId).map((e) => e.id);
  return [...new Set([...staffIds(c), ...heads])].map((employeeId) => ({ employeeId })).concat([{ role: 'admin' }]);
}

// After the people of a client changed: an owner who no longer fits is dropped, so the chat opens up again.
function tidyOwner(clientId) {
  const c = db.get(`${CLIENT_SELECT} WHERE c.id=?`, clientId);
  if (c && c.chatOwnerId && !chatOwner(c)) db.run('UPDATE clients SET chat_owner_id=NULL WHERE id=?', clientId);
}

// Who is told when the client writes: the owner of the chat and the admin, or (while nobody owns it) everyone who works with the client.
function chatRecipients(c) {
  const o = chatOwner(c);
  return o ? [{ employeeId: o.id }, { role: 'admin' }] : staffOf(c);
}

// Who the admin can pick from: the leader and members of the team (or of the department when the client has no team).
function candidates(departmentId, teamId) {
  return db.all(
    `SELECT e.id, e.name, e.emp_code, e.role, e.team_id, t.name AS team_name FROM employees e LEFT JOIN teams t ON t.id=e.team_id
      WHERE e.status='active' AND e.department_id=? AND e.role IN ('team_leader','member') AND (? IS NULL OR e.team_id=?)
      ORDER BY (e.role='team_leader') DESC, t.name, e.name`, departmentId, teamId ?? null, teamId ?? null)
    .map((e) => ({ id: e.id, name: e.name, empCode: e.empCode, role: e.role === 'team_leader' ? 'Team leader' : 'Member', teamName: e.teamName }));
}

// Replace the chosen people of a client. Only people from the right department/team are accepted. Call inside db.tx.
function setStaff(c, employeeIds, ctx) {
  const wanted = [...new Set((Array.isArray(employeeIds) ? employeeIds : []).map((x) => int(x, 'Person', { required: true })))];
  const ok = new Set(candidates(c.departmentId, c.teamId).map((e) => e.id));
  if (wanted.some((id) => !ok.has(id))) throw bad('Some of the chosen people do not belong to that team');
  const before = new Set(db.all('SELECT employee_id FROM client_staff WHERE client_id=?', c.id).map((r) => r.employeeId));
  db.run('DELETE FROM client_staff WHERE client_id=?', c.id);
  for (const id of wanted) db.run('INSERT INTO client_staff(client_id, employee_id, added_at) VALUES (?,?,?)', c.id, id, new Date().toISOString());
  const added = wanted.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !wanted.includes(id));
  for (const id of added) notify.send({ employeeId: id }, { title: `You were added to client ${c.username}`, body: 'You can now see its updates and chat.', link: '#/client-updates', kind: 'chat' });
  for (const id of removed) notify.send({ employeeId: id }, { title: `You were removed from client ${c.username}`, body: 'You no longer have access to it.', kind: 'chat' });
  tidyOwner(c.id);
  if (added.length || removed.length) ctx.audit('client_team_changed', 'client', c.id, `${c.username}: +${added.length} -${removed.length}, now ${wanted.length} people`, c.departmentId);
  return { added: added.length, removed: removed.length, total: wanted.length };
}

// Last message of each chat, to know who has to answer.
function lastMessages(clientIds) {
  if (!clientIds.length) return {};
  const rows = db.all(
    `SELECT m.client_id, m.channel, m.from_client, m.created_at FROM client_messages m
      WHERE m.id IN (SELECT MAX(id) FROM client_messages WHERE client_id IN (${clientIds.map(() => '?').join(',')}) GROUP BY client_id, channel)`, ...clientIds);
  const out = {};
  for (const r of rows) (out[r.clientId] ||= {})[r.channel] = { fromClient: !!r.fromClient, at: r.createdAt };
  return out;
}

// What the client sees of a message: "eTricks" or "You". Never a staff name or ID.
const toClientMessage = (m) => ({ id: m.id, from: m.fromClient ? 'you' : 'etricks', body: m.body, createdAt: m.createdAt, seen: !!m.readAt });
const toStaffMessage = (m) => ({ id: m.id, fromClient: !!m.fromClient, author: m.fromClient ? 'Client' : m.staffLabel || 'Team', body: m.body, createdAt: m.createdAt, seen: !!m.readAt });

function nextUsername() {
  const n = (db.get('SELECT COALESCE(MAX(id),0)+1 AS n FROM clients').n);
  let u = `CL-${String(n).padStart(4, '0')}`;
  while (db.get('SELECT 1 AS x FROM clients WHERE username=?', u)) u = `CL-${String(Number(u.slice(3)) + 1).padStart(4, '0')}`;
  return u;
}

function checkTeam(departmentId, teamId) {
  if (teamId && !db.get('SELECT 1 AS x FROM teams WHERE id=? AND department_id=?', teamId, departmentId)) throw bad('That team does not belong to the department');
}

module.exports = {
  id: 'clients',
  name: 'Clients',
  description: 'Client portals: daily sales, chat and urgent alerts, with clients seeing only "eTricks".',
  order: 55,

  migrations: [
    `CREATE TABLE clients (
       id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, department_id INTEGER NOT NULL REFERENCES departments(id),
       team_id INTEGER REFERENCES teams(id), display_name TEXT, contact TEXT, secret_info TEXT, password_hash TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active', last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_client_dept ON clients(department_id, status);
     CREATE TABLE client_reports (
       id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, date TEXT NOT NULL,
       market TEXT, store TEXT, orders INTEGER NOT NULL DEFAULT 0, investment REAL NOT NULL DEFAULT 0, sales REAL NOT NULL DEFAULT 0,
       note TEXT, submitted_by INTEGER, submitted_label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_clientrep ON client_reports(client_id, date);
     CREATE TABLE client_messages (
       id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, channel TEXT NOT NULL,
       from_client INTEGER NOT NULL, staff_id INTEGER, staff_label TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
     CREATE INDEX idx_clientmsg ON client_messages(client_id, channel, id);`,
    // 2: the admin chooses which leader / members work for each client. Until now a whole team did, so every existing client keeps
    // exactly the people it had (the admin can then remove the ones who should not see it).
    `CREATE TABLE client_staff (
       client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
       added_at TEXT NOT NULL, PRIMARY KEY (client_id, employee_id));
     CREATE INDEX idx_clientstaff_emp ON client_staff(employee_id);
     INSERT INTO client_staff(client_id, employee_id, added_at)
       SELECT c.id, e.id, c.created_at FROM clients c JOIN employees e ON e.department_id=c.department_id
        WHERE e.status='active' AND e.role IN ('team_leader','member') AND (c.team_id IS NULL OR e.team_id=c.team_id);`,
    // 3: the person who answers a client's chat owns the conversation
    `ALTER TABLE clients ADD COLUMN chat_owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;`,
    // 4: a member sees only the clients the admin chose for them. Migration 2 had given every client its whole team automatically
    // (rows whose added_at equals the client's creation time, for clients that existed back then): those automatic rows are removed,
    // the admin chooses the people per client (Members button). People the admin chose by hand are kept.
    `DELETE FROM client_staff WHERE rowid IN (
       SELECT s.rowid FROM client_staff s JOIN clients c ON c.id=s.client_id
        WHERE s.added_at = c.created_at
          AND c.created_at < COALESCE((SELECT applied_at FROM schema_migrations WHERE module='clients' AND version=2), '0000'));
     UPDATE clients SET chat_owner_id=NULL WHERE chat_owner_id IS NOT NULL
        AND chat_owner_id NOT IN (SELECT id FROM employees WHERE role='hod')
        AND chat_owner_id NOT IN (SELECT employee_id FROM client_staff WHERE client_id=clients.id);`,
  ],

  routes(m) {
    // =============================== admin: the clients ===============================
    // Staff get a short list (client IDs of their scope) with the numbers they need; the admin gets the full records.
    m.get('/api/clients', { roles: STAFF }, (ctx) => {
      const rows = db.all(`${CLIENT_SELECT} ORDER BY d.sort, c.username`).filter((c) => inScope(ctx, c) && (ctx.user.role === 'admin' || c.status === 'active'));
      const ids = rows.map((c) => c.id);
      const last = lastMessages(ids);
      const day = today();
      const reports = ids.length ? db.all(`SELECT client_id, date, orders, investment, sales FROM client_reports WHERE client_id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
      const by = {};
      for (const r of reports) (by[r.clientId] ||= []).push(r);
      return rows.map((c) => {
        const info = chatInfo(ctx, c);
        const hide = info.chat === 'colleague' && ctx.user.role !== 'admin'; // somebody else answers this client: no chat details
        return {
          ...shape(ctx, c), ...info,
          today: sums((by[c.id] || []).filter((r) => r.date === day)), total: sums(by[c.id] || []),
          inquiryNeedsReply: !hide && !!last[c.id]?.inquiry?.fromClient, alertNeedsReply: !hide && !!last[c.id]?.alert?.fromClient,
          lastInquiryAt: hide ? null : last[c.id]?.inquiry?.at ?? null, lastAlertAt: hide ? null : last[c.id]?.alert?.at ?? null,
        };
      });
    });

    // The people the admin can choose from for a department / team (used by the "Select team members" list).
    m.get('/api/clients/candidates', { roles: ['admin'] }, (ctx) => {
      const departmentId = int(ctx.query.departmentId, 'Department', { required: true });
      const teamId = int(ctx.query.teamId, 'Team');
      checkTeam(departmentId, teamId);
      return candidates(departmentId, teamId);
    });

    m.post('/api/clients', { roles: ['admin'] }, (ctx) => {
      const b = ctx.body;
      const departmentId = int(b.departmentId, 'Department', { required: true });
      if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', departmentId)) throw bad('Department not found');
      const teamId = int(b.teamId, 'Team');
      checkTeam(departmentId, teamId);
      const username = b.username && String(b.username).trim() ? String(b.username).trim() : nextUsername();
      if (!USERNAME.test(username)) throw bad('Client ID must be 3-30 characters: letters, numbers, dot, dash or underscore');
      if (db.get('SELECT 1 AS x FROM clients WHERE username=?', username)) throw bad('That client ID is already used');
      const password = accounts.validatePassword(b.password, 'Client password');
      const now = new Date().toISOString();
      const wanted = Array.isArray(b.staffIds) ? b.staffIds : [];
      const ok = new Set(candidates(departmentId, teamId).map((e) => e.id));
      if (wanted.some((id) => !ok.has(Number(id)))) throw bad('Some of the chosen people do not belong to that team');
      const r = db.tx(() => {
        const row = db.insert('clients', {
          username, departmentId, teamId, displayName: str(b.displayName, 'Name', { max: 100 }), contact: str(b.contact, 'Contact', { max: 200 }),
          secretInfo: str(b.secretInfo, 'Account details', { max: 5000 }), passwordHash: auth.hashSecret(password), status: 'active', createdAt: now, updatedAt: now,
        });
        setStaff({ id: row.id, username, departmentId, teamId }, wanted, ctx);
        return row;
      });
      ctx.audit('client_created', 'client', r.id, username, departmentId);
      return { id: r.id, username };
    });

    m.get('/api/clients/:id', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      return shape(ctx, c);
    });

    // Who works for this client (admin): the chosen people, and who else could be added.
    m.get('/api/clients/:id/staff', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const chosen = new Set(staffIds(c));
      return { candidates: candidates(c.departmentId, c.teamId).map((e) => ({ ...e, chosen: chosen.has(e.id) })) };
    });

    // Add or remove people later: send the full list of people who should be in the client's chat.
    m.put('/api/clients/:id/staff', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      return db.tx(() => setStaff(c, ctx.body.employeeIds, ctx));
    });

    m.put('/api/clients/:id', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const b = ctx.body;
      const departmentId = b.departmentId ? int(b.departmentId, 'Department', { required: true }) : c.departmentId;
      if (!db.get('SELECT 1 AS x FROM departments WHERE id=?', departmentId)) throw bad('Department not found');
      const teamId = b.teamId === undefined ? (departmentId === c.departmentId ? c.teamId : null) : int(b.teamId, 'Team');
      checkTeam(departmentId, teamId);
      const username = b.username !== undefined ? String(b.username).trim() : c.username;
      if (!USERNAME.test(username)) throw bad('Client ID must be 3-30 characters: letters, numbers, dot, dash or underscore');
      if (db.get('SELECT 1 AS x FROM clients WHERE username=? AND id<>?', username, c.id)) throw bad('That client ID is already used');
      const status = oneOf(b.status, 'Status', ['active', 'disabled'], { def: c.status });
      const moved = departmentId !== c.departmentId || (teamId ?? null) !== (c.teamId ?? null);
      if (b.staffIds !== undefined) {
        const ok = new Set(candidates(departmentId, teamId).map((e) => e.id));
        if (!Array.isArray(b.staffIds) || b.staffIds.some((id) => !ok.has(Number(id)))) throw bad('Some of the chosen people do not belong to that team');
      }
      db.tx(() => {
        db.update('clients', c.id, {
          username, departmentId, teamId, status, displayName: str(b.displayName, 'Name', { max: 100 }), contact: str(b.contact, 'Contact', { max: 200 }),
          ...(b.secretInfo !== undefined ? { secretInfo: str(b.secretInfo, 'Account details', { max: 5000 }) } : {}), updatedAt: new Date().toISOString(),
        });
        if (b.staffIds !== undefined) setStaff({ ...c, username, departmentId, teamId }, b.staffIds, ctx);
        else if (moved) { db.run('DELETE FROM client_staff WHERE client_id=?', c.id); tidyOwner(c.id); } // another team: the old people no longer fit
      });
      // a changed ID, department or status signs the client out
      if (status !== 'active' || departmentId !== c.departmentId || username !== c.username) db.run('DELETE FROM sessions WHERE client_id=?', c.id);
      ctx.audit(status !== c.status ? `client_${status}` : 'client_updated', 'client', c.id, username, departmentId);
      return { ok: true };
    });

    m.put('/api/clients/:id/password', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const password = accounts.validatePassword(ctx.body.password, 'Client password');
      db.update('clients', c.id, { passwordHash: auth.hashSecret(password), updatedAt: new Date().toISOString() });
      db.run('DELETE FROM sessions WHERE client_id=?', c.id);
      ctx.audit('client_password_changed', 'client', c.id, c.username, c.departmentId);
      return { ok: true };
    });

    // The private account details are shown only on request, and every viewing is written to the activity log.
    m.get('/api/clients/:id/secret', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      ctx.audit('client_secret_viewed', 'client', c.id, c.username, c.departmentId);
      return { secretInfo: c.secretInfo || '' };
    });

    m.del('/api/clients/:id', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      db.run('DELETE FROM sessions WHERE client_id=?', c.id);
      db.run("DELETE FROM notifications WHERE recipient_role='client' AND recipient_id=?", c.id);
      db.run("DELETE FROM push_subscriptions WHERE recipient_role='client' AND recipient_id=?", c.id);
      db.run('UPDATE member_orders SET client_id=NULL WHERE client_id=?', c.id); // daily-report rows stay, only the sharing ends
      db.run('DELETE FROM sheet_publications WHERE client_id=?', c.id);
      db.run('DELETE FROM clients WHERE id=?', c.id); // reports and messages go with it
      ctx.audit('client_deleted', 'client', c.id, c.username, c.departmentId);
      return { ok: true };
    });

    // =============================== staff: the daily numbers for a client ===============================
    const REPORT_SELECT = 'SELECT r.*, c.username FROM client_reports r JOIN clients c ON c.id=r.client_id';
    const reportInput = (b) => {
      const day = date(b.date, 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      const e = {
        date: day, market: str(b.market, 'Market', { max: 100 }), store: str(b.store, 'Store / account', { max: 100 }),
        orders: int(b.orders ?? 0, 'Orders', { min: 0, max: 1e7 }), investment: num(b.investment ?? 0, 'Investment', { min: 0, max: 1e9 }), sales: num(b.sales ?? 0, 'Sales', { min: 0, max: 1e9 }),
        note: str(b.note, 'Update for the client', { max: 1000 }),
      };
      if (!e.orders && !e.investment && !e.sales && !e.note) throw bad('Enter at least orders, investment, sales or an update');
      return e;
    };
    // A person edits their own entry for 7 days; leaders and heads (of that client) and the admin any entry.
    const canEditReport = (ctx, r, c) => {
      if (ctx.user.role === 'admin') return true;
      if ((ctx.user.role === 'leader' || ctx.user.role === 'hod') && inScope(ctx, c)) return true;
      return r.submittedBy != null && r.submittedBy === ctx.user.employeeId && r.createdAt >= addDays(today(), -7);
    };

    m.get('/api/client-reports', { roles: STAFF }, (ctx) => {
      const q = ctx.query;
      const from = q.from ? date(q.from, 'From') : addDays(today(), -30);
      const to = q.to ? date(q.to, 'To') : today();
      const clients = Object.fromEntries(db.all(`${CLIENT_SELECT}`).filter((c) => inScope(ctx, c) && (!q.clientId || c.id === Number(q.clientId))).map((c) => [c.id, c]));
      const ids = Object.keys(clients).map(Number);
      if (!ids.length) return { rows: [], totals: sums([]) };
      const rows = db.all(`${REPORT_SELECT} WHERE r.client_id IN (${ids.map(() => '?').join(',')}) AND r.date BETWEEN ? AND ? ORDER BY r.date DESC, r.id DESC LIMIT 1000`, ...ids, from, to)
        .map((r) => ({ ...r, revenue: revenueOf(r), canEdit: canEditReport(ctx, r, clients[r.clientId]), by: r.submittedLabel || 'Team' }));
      return { rows, totals: sums(rows) };
    });

    m.post('/api/client-reports', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.body.clientId);
      if (c.status !== 'active') throw bad('This client is disabled');
      const e = reportInput(ctx.body);
      if (ctx.user.role === 'member' && e.date < addDays(today(), -31)) throw bad('You can only add updates from the last 31 days');
      const now = new Date().toISOString();
      const label = ctx.user.role === 'admin' ? 'Administrator' : db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId)?.name;
      const r = db.insert('client_reports', { clientId: c.id, ...e, submittedBy: ctx.user.employeeId ?? null, submittedLabel: label, createdAt: now, updatedAt: now });
      ctx.audit('client_update', 'client', c.id, `${c.username} ${e.date}: ${e.orders} orders, sales ${e.sales}`, c.departmentId);
      return { id: r.id };
    });

    m.put('/api/client-reports/:id', { roles: STAFF }, (ctx) => {
      const r = db.get('SELECT * FROM client_reports WHERE id=?', int(ctx.params.id, 'Update', { required: true }));
      if (!r) throw new HttpError(404, 'Update not found');
      const c = staffClient(ctx, r.clientId);
      if (!canEditReport(ctx, r, c)) throw new HttpError(403, 'You can only change your own updates for 7 days');
      const e = reportInput(ctx.body);
      db.update('client_reports', r.id, { ...e, updatedAt: new Date().toISOString() });
      ctx.audit('client_update_edited', 'client', c.id, `${c.username} ${e.date}`, c.departmentId);
      return { ok: true };
    });

    m.del('/api/client-reports/:id', { roles: STAFF }, (ctx) => {
      const r = db.get('SELECT * FROM client_reports WHERE id=?', int(ctx.params.id, 'Update', { required: true }));
      if (!r) throw new HttpError(404, 'Update not found');
      const c = staffClient(ctx, r.clientId);
      if (!canEditReport(ctx, r, c)) throw new HttpError(403, 'You can only delete your own updates for 7 days');
      db.run('DELETE FROM client_reports WHERE id=?', r.id);
      ctx.audit('client_update_deleted', 'client', c.id, `${c.username} ${r.date}`, c.departmentId);
      return { ok: true };
    });

    // =============================== staff: chat and alerts with a client ===============================
    m.get('/api/clients/:id/chat', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      chatGate(ctx, c);
      const channel = oneOf(ctx.query.channel, 'Channel', CHANNELS, { required: true });
      const after = Number(ctx.query.after) || 0;
      const rows = db.all('SELECT * FROM client_messages WHERE client_id=? AND channel=? AND id>? ORDER BY id DESC LIMIT 300', c.id, channel, after).reverse();
      // the client sees that their messages were read (by "eTricks": not by whom)
      db.run('UPDATE client_messages SET read_at=? WHERE client_id=? AND channel=? AND from_client=1 AND read_at IS NULL', new Date().toISOString(), c.id, channel);
      const last = db.get('SELECT from_client FROM client_messages WHERE client_id=? AND channel=? ORDER BY id DESC LIMIT 1', c.id, channel);
      return { client: { id: c.id, username: c.username }, messages: rows.map(toStaffMessage), needsReply: !!last?.fromClient, ...chatInfo(ctx, c) };
    });

    m.post('/api/clients/:id/chat', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      chatGate(ctx, c);
      if (c.status !== 'active') throw bad('This client is disabled');
      const channel = oneOf(ctx.body.channel, 'Channel', CHANNELS, { required: true });
      const body = str(ctx.body.body, 'Message', { required: true, max: 2000 });
      // the first person to answer becomes the owner of the conversation (the admin only steps in, so does not take it)
      if (ctx.user.role !== 'admin' && !chatOwner(c)) {
        db.run('UPDATE clients SET chat_owner_id=? WHERE id=?', ctx.user.employeeId, c.id);
        ctx.audit('client_chat_taken', 'client', c.id, c.username, c.departmentId);
      }
      const label = ctx.user.role === 'admin' ? 'Administrator' : db.get('SELECT name, role FROM employees WHERE id=?', ctx.user.employeeId);
      const who = typeof label === 'string' ? label : label.name;
      const r = db.insert('client_messages', { clientId: c.id, channel, fromClient: 0, staffId: ctx.user.employeeId ?? null, staffLabel: who, body, createdAt: new Date().toISOString() });
      ctx.audit(channel === 'alert' ? 'client_alert_sent' : 'client_message_sent', 'client', c.id, c.username, c.departmentId); // never the text
      // The text is never put into a notification: an alert may carry a code or a secret.
      notify.send({ clientId: c.id }, channel === 'alert'
        ? { title: 'URGENT: eTricks needs your attention now', body: 'Open the Alerts section of your portal.', link: '#/portal-alerts', kind: 'alert', urgent: true }
        : { title: 'New message from eTricks', link: '#/portal-chat', kind: 'chat' });
      return { id: r.id };
    });

    // The owner (or the admin) gives the conversation back: the chosen people can answer it again.
    m.post('/api/clients/:id/chat/release', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const o = chatOwner(c);
      if (!o) return { ok: true };
      if (ctx.user.role !== 'admin' && o.id !== ctx.user.employeeId) throw new HttpError(403, 'This conversation is private to the colleague who is answering this client');
      db.run('UPDATE clients SET chat_owner_id=NULL WHERE id=?', c.id);
      ctx.audit('client_chat_released', 'client', c.id, c.username, c.departmentId);
      return { ok: true };
    });

    // Admin: hand the conversation to a chosen person (or to nobody).
    m.put('/api/clients/:id/chat-owner', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const id = ctx.body.employeeId == null || ctx.body.employeeId === '' ? null : int(ctx.body.employeeId, 'Person', { required: true });
      if (id != null) {
        const ok = staffIds(c).includes(id) || db.get("SELECT 1 AS x FROM employees WHERE id=? AND role='hod' AND status='active' AND department_id=?", id, c.departmentId);
        if (!ok) throw bad('That person does not work for this client. Add them under Members first');
      }
      db.run('UPDATE clients SET chat_owner_id=? WHERE id=?', id, c.id);
      ctx.audit(id ? 'client_chat_assigned' : 'client_chat_released', 'client', c.id, c.username, c.departmentId);
      if (id) notify.send({ employeeId: id }, { title: `You now answer client ${c.username}`, body: 'The conversation is private to you.', link: '#/client-chat', kind: 'chat' });
      return { ok: true };
    });

    // Admin only: wipe a chat (for example after an OTP was shared).
    m.del('/api/clients/:id/chat', { roles: ['admin'] }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const channel = oneOf(ctx.query.channel, 'Channel', CHANNELS, { required: true });
      const n = db.run('DELETE FROM client_messages WHERE client_id=? AND channel=?', c.id, channel).changes;
      ctx.audit('client_chat_cleared', 'client', c.id, `${c.username} ${channel}: ${n} messages`, c.departmentId);
      return { removed: n };
    });

    // The page polls this every few seconds: how many clients are waiting for an answer, and since when.
    m.get('/api/client-alerts/summary', { roles: STAFF }, (ctx) => {
      const clients = db.all(`${CLIENT_SELECT} WHERE c.status='active'`).filter((c) => inScope(ctx, c) && canReadChat(ctx, c)); // not the chats a colleague answers
      if (!clients.length) return { alerts: 0, inquiries: 0, items: [] };
      const last = lastMessages(clients.map((c) => c.id));
      const items = [];
      let inquiries = 0;
      for (const c of clients) {
        if (last[c.id]?.inquiry?.fromClient) inquiries++;
        if (last[c.id]?.alert?.fromClient) {
          const since = db.get(
            `SELECT MIN(created_at) AS t FROM client_messages WHERE client_id=? AND channel='alert' AND from_client=1
               AND id > COALESCE((SELECT MAX(id) FROM client_messages WHERE client_id=? AND channel='alert' AND from_client=0), 0)`, c.id, c.id).t;
          items.push({ clientId: c.id, username: c.username, since });
        }
      }
      return { alerts: items.length, inquiries, items };
    });

    // =============================== the client portal ===============================
    const CLIENT = ['client'];
    const me = (ctx) => db.get(`${CLIENT_SELECT} WHERE c.id=?`, ctx.user.clientId);

    m.get('/api/portal/sales', { roles: CLIENT }, (ctx) => {
      const c = me(ctx);
      const day = today();
      const from = ctx.query.from ? date(ctx.query.from, 'From') : addDays(day, -29);
      const to = ctx.query.to ? date(ctx.query.to, 'To') : day;
      if (from > to) throw bad('"To" cannot be before "From"');
      const all = db.all('SELECT date, market, store, orders, investment, sales, note FROM client_reports WHERE client_id=? ORDER BY date', c.id);
      const inRange = all.filter((r) => r.date >= from && r.date <= to);
      const byDay = new Map();
      for (const r of inRange) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
      const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, rs]) => ({
        date: d, ...sums(rs),
        // what was done that day, as written for the client: always "eTricks"
        updates: rs.map((r) => ({ market: r.market, store: r.store, orders: r.orders, investment: r.investment, sales: r.sales, revenue: revenueOf(r), note: r.note })),
      }));
      const monthStart = `${day.slice(0, 8)}01`;
      const chart = [];
      for (let i = 13; i >= 0; i--) { const d = addDays(day, -i); chart.push({ date: d, ...sums(all.filter((r) => r.date === d)) }); }
      return {
        username: c.username, departmentName: c.departmentName, from, to,
        today: { date: day, ...sums(all.filter((r) => r.date === day)) },
        month: sums(all.filter((r) => r.date >= monthStart)),
        total: { ...sums(all), since: all[0]?.date ?? null, days: new Set(all.map((r) => r.date)).size },
        range: sums(inRange), days, chart,
      };
    });

    m.get('/api/portal/summary', { roles: CLIENT }, (ctx) => {
      const n = (channel) => db.get('SELECT COUNT(*) AS n FROM client_messages WHERE client_id=? AND channel=? AND from_client=0 AND read_at IS NULL', ctx.user.clientId, channel).n;
      return { inquiry: n('inquiry'), alert: n('alert') };
    });

    m.get('/api/portal/chat', { roles: CLIENT }, (ctx) => {
      const channel = oneOf(ctx.query.channel, 'Channel', CHANNELS, { required: true });
      const after = Number(ctx.query.after) || 0;
      const rows = db.all('SELECT * FROM client_messages WHERE client_id=? AND channel=? AND id>? ORDER BY id DESC LIMIT 300', ctx.user.clientId, channel, after).reverse();
      db.run('UPDATE client_messages SET read_at=? WHERE client_id=? AND channel=? AND from_client=0 AND read_at IS NULL', new Date().toISOString(), ctx.user.clientId, channel);
      return { messages: rows.map(toClientMessage) };
    });

    m.post('/api/portal/chat', { roles: CLIENT }, (ctx) => {
      const c = me(ctx);
      const channel = oneOf(ctx.body.channel, 'Channel', CHANNELS, { required: true });
      const body = str(ctx.body.body, 'Message', { required: true, max: 2000 });
      const hour = new Date(Date.now() - 3600e3).toISOString();
      if (db.get('SELECT COUNT(*) AS n FROM client_messages WHERE client_id=? AND from_client=1 AND created_at>=?', c.id, hour).n >= 120) throw new HttpError(429, 'Too many messages in the last hour. Please wait a little.');
      const r = db.insert('client_messages', { clientId: c.id, channel, fromClient: 1, body, createdAt: new Date().toISOString() });
      ctx.audit(channel === 'alert' ? 'client_alert' : 'client_message', 'client', c.id, c.username, c.departmentId); // never the text
      const payload = channel === 'alert'
        ? { title: `ALERT from client ${c.username}`, body: 'Needs an immediate reply.', link: '#/client-alerts', kind: 'alert', urgent: true }
        : { title: `New message from client ${c.username}`, link: '#/client-chat', kind: 'chat' };
      for (const to of chatRecipients(c)) notify.send(to, payload);
      return { id: r.id };
    });
  },
};
