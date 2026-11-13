'use strict';
const auth = require('../../core/auth');
const accounts = require('../../core/accounts');
const db = require('../../core/db');
const notify = require('../../core/notify');
const attachments = require('../../core/attachments');
const clientAccounts = require('../../core/clientaccounts');
const settings = require('../../core/settings');
const { CURRENCIES, converter, converterTo } = require('../../core/currency');
const { HttpError, str, int, num, date, oneOf, bad, today, addDays, round } = require('../../core/util');

/*
 * Clients. Every department can have client portals. The admin creates each client (a client ID + password) and keeps the
 * private details; the client sees only their own sales and a chat with "eTricks".
 *
 *   - Team members write the day's work (orders, investment, sales ...) against the client ID. The client sees the numbers
 *     and the notes, labelled "eTricks": never the name of the person who wrote them.
 *   - Two chats per client: "inquiry" (ordinary messages) and "alert" (urgent: an OTP, a confidential detail, ...). Alerts
 *     raise a loud notification on the other side and are never put into notification texts.
 *   - The admin picks WHICH people work for a client (team leaders and members, chosen one by one, from ANY department or team).
 *     Only those people, the head of the client's department and the admin can see that client, its chat and its alerts. Nobody is
 *     added just because they are in the same team. Staff see only the client ID; the real name, contact and secret details are for the admin.
 *   - One portal per client, one section per person who works for it: "Account 1", "Account 2" ... (never a name).
 *   - A chat is shared: everybody chosen for the client, the head of the department and the admin can read and write it.
 *   - Every client has a currency (AUD, USD or GBP) chosen by the admin: the client sees all its figures in it. An update has a
 *     currency too (it starts as the client's); one written in another currency is converted with the exchange rates in Settings.
 */
const STAFF = ['admin', 'hod', 'leader', 'member'];
const CHANNELS = ['inquiry', 'alert'];
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/;

const revenueOf = (r) => round((r.sales || 0) - (r.investment || 0));
// The currency of an update that does not say one: the company currency when it is one of ours, else USD.
const defaultCurrency = () => { const c = settings.get('currency'); return CURRENCIES.includes(c) ? c : 'USD'; };
// Totals per currency: [{ currency, orders, investment, sales, revenue }], the biggest sales first.
const sumsBy = (rows) => {
  const by = {};
  for (const r of rows) (by[r.currency || 'USD'] ||= []).push(r);
  return Object.entries(by).map(([currency, list]) => ({ currency, ...sums(list) })).sort((a, b) => b.sales - a.sales || a.currency.localeCompare(b.currency));
};
// Totals of the rows in ONE currency: every row is converted into it first (rows already in it stay exactly as written).
const sumsIn = (rows, to) => {
  const conv = converterTo(to);
  return sums(rows.map((r) => ({ ...r, investment: conv(r.investment, r.currency), sales: conv(r.sales, r.currency) })));
};
// All currencies converted into the company currency with the admin's exchange rates (for totals over several clients).
const sumsConverted = (rows) => {
  const conv = converter();
  const t = { orders: 0, investment: 0, sales: 0 };
  for (const r of rows) { t.orders += r.orders; t.investment += conv(r.investment, r.currency); t.sales += conv(r.sales, r.currency); }
  return { orders: t.orders, investment: round(t.investment), sales: round(t.sales), revenue: round(t.sales - t.investment) };
};
const sums = (rows) => {
  const t = { orders: 0, investment: 0, sales: 0 };
  for (const r of rows) { t.orders += r.orders; t.investment += r.investment; t.sales += r.sales; }
  return { orders: t.orders, investment: round(t.investment), sales: round(t.sales), revenue: round(t.sales - t.investment) };
};

// ---- who may see which client ----
// The clients this leader / member was chosen for (read once per request).
function assignedTo(ctx) {
  return (ctx.assignedClients ||= new Set(db.all('SELECT client_id FROM client_staff WHERE employee_id=?', ctx.user.employeeId).map((r) => r.clientId)));
}
// The admin sees every client. The head of a department sees every client of HIS department. A team leader or member sees the
// clients the admin chose them for: from ANY department or team (a person of another department can work for a client).
function inScope(ctx, c) {
  if (ctx.user.role === 'admin') return true;
  if (ctx.user.role === 'hod') return c.departmentId === ctx.user.departmentId;
  return assignedTo(ctx).has(c.id);
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
  const base = { id: c.id, username: c.username, departmentId: c.departmentId, teamId: c.teamId, status: c.status, currency: c.currency };
  if (ctx.user.role !== 'admin') return base;
  return { ...base, displayName: c.displayName, contact: c.contact, departmentName: c.departmentName, teamName: c.teamName, hasSecret: !!c.secretInfo, lastLoginAt: c.lastLoginAt, createdAt: c.createdAt, staffCount: staffIds(c).length };
}

// There is no private owner of a chat: everybody chosen for a client (leader / members), the head of the department and the admin
// can read and write its chat, and the client can too. Nobody has to "take" it.

// The people chosen for a client who can still work on it (active; from any department or team).
const ASSIGNED_SQL = `SELECT e.id, e.name, e.role, e.team_id, e.department_id, t.name AS team_name FROM client_staff s
  JOIN employees e ON e.id=s.employee_id LEFT JOIN teams t ON t.id=e.team_id
  WHERE s.client_id=? AND e.status='active' ORDER BY e.role DESC, e.name`;
const staffRows = (c) => db.all(ASSIGNED_SQL, c.id);
const staffIds = (c) => staffRows(c).map((e) => e.id);

// Everyone who works with a client: the chosen people, the head of the department and the admin.
function staffOf(c) {
  const heads = db.all("SELECT id FROM employees WHERE status='active' AND role='hod' AND department_id=?", c.departmentId).map((e) => e.id);
  return [...new Set([...staffIds(c), ...heads])].map((employeeId) => ({ employeeId })).concat([{ role: 'admin' }]);
}

// Who is told when the client writes: everyone who works with the client, the head of the department and the admin.
const chatRecipients = (c) => staffOf(c);

// Who the admin can pick from: every active team leader and member of ANY department (optionally only one department / team).
// One person can work for at most this many clients (each client is a separate sheet of that person).
const MAX_CLIENTS_PER_PERSON = 30;

// `otherClients` = how many OTHER clients the person already works for (so the list can show who is full).
function candidates(departmentId = null, teamId = null, exceptClientId = null) {
  return db.all(
    `SELECT e.id, e.name, e.emp_code, e.role, e.team_id, e.department_id, t.name AS team_name, d.name AS department_name,
            (SELECT COUNT(*) FROM client_staff s WHERE s.employee_id=e.id AND s.client_id<>COALESCE(?, 0)) AS other_clients
       FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN teams t ON t.id=e.team_id
      WHERE e.status='active' AND e.role IN ('team_leader','member') AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
      ORDER BY d.sort, d.name, (e.role='team_leader') DESC, t.name, e.name`, exceptClientId, departmentId, departmentId, teamId, teamId)
    .map((e) => ({ id: e.id, name: e.name, empCode: e.empCode, role: e.role === 'team_leader' ? 'Team leader' : 'Member', teamName: e.teamName, departmentId: e.departmentId, departmentName: e.departmentName, otherClients: e.otherClients, limit: MAX_CLIENTS_PER_PERSON }));
}

// Replace the chosen people of a client. Any active team leader or member is accepted, whatever department or team. Call inside db.tx.
function setStaff(c, employeeIds, ctx) {
  const wanted = [...new Set((Array.isArray(employeeIds) ? employeeIds : []).map((x) => int(x, 'Person', { required: true })))];
  const ok = new Set(candidates().map((e) => e.id));
  if (wanted.some((id) => !ok.has(id))) throw bad('Only active team leaders and members can work for a client');
  const before = new Set(db.all('SELECT employee_id FROM client_staff WHERE client_id=?', c.id).map((r) => r.employeeId));
  // nobody can be given a sixth client
  for (const id of wanted.filter((x) => !before.has(x))) {
    const n = db.get('SELECT COUNT(*) AS n FROM client_staff WHERE employee_id=? AND client_id<>?', id, c.id).n;
    if (n >= MAX_CLIENTS_PER_PERSON) throw bad(`${db.get('SELECT name FROM employees WHERE id=?', id)?.name || 'This person'} already works for ${MAX_CLIENTS_PER_PERSON} clients, the most one person can have. Remove them from one of those clients first`);
  }
  db.run('DELETE FROM client_staff WHERE client_id=?', c.id);
  for (const id of wanted) db.run('INSERT INTO client_staff(client_id, employee_id, added_at) VALUES (?,?,?)', c.id, id, new Date().toISOString());
  const added = wanted.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !wanted.includes(id));
  for (const id of added) notify.send({ employeeId: id }, { title: `You were added to client ${c.username}`, body: 'You can now see its updates and chat.', link: '#/client-updates', kind: 'chat' });
  for (const id of removed) notify.send({ employeeId: id }, { title: `You were removed from client ${c.username}`, body: 'You no longer have access to it.', kind: 'chat' });
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
// The pictures and voice notes of some messages (id, kind, type, size: never the bytes).
const filesOf = (rows) => {
  const ids = rows.map((m) => m.id);
  const out = new Map();
  if (!ids.length) return out;
  for (const a of db.all(`SELECT id, message_id, kind, mime, size FROM chat_attachments WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids)) out.set(a.messageId, { id: a.id, kind: a.kind, mime: a.mime, size: a.size });
  return out;
};
const toClientMessage = (m, files) => ({ id: m.id, from: m.fromClient ? 'you' : 'etricks', body: m.body, createdAt: m.createdAt, seen: !!m.readAt, file: files?.get(m.id) ?? null });
const toStaffMessage = (m, files) => ({ id: m.id, fromClient: !!m.fromClient, author: m.fromClient ? 'Client' : m.staffLabel || 'Team', body: m.body, createdAt: m.createdAt, seen: !!m.readAt, file: files?.get(m.id) ?? null });

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
    // 5: every client is a sheet of its own. A member who works for exactly one client keeps what they wrote so far on that
    // client's sheet; a member with several keeps it on the general sheet (nothing is lost, nothing is guessed).
    `UPDATE member_orders SET client_id = (SELECT s.client_id FROM client_staff s JOIN clients c ON c.id=s.client_id WHERE s.employee_id=member_orders.employee_id AND c.status='active')
      WHERE client_id IS NULL AND (SELECT COUNT(*) FROM client_staff s JOIN clients c ON c.id=s.client_id WHERE s.employee_id=member_orders.employee_id AND c.status='active') = 1;
     UPDATE order_columns SET client_id = (SELECT s.client_id FROM client_staff s JOIN clients c ON c.id=s.client_id WHERE s.employee_id=order_columns.employee_id AND c.status='active')
      WHERE client_id IS NULL AND (SELECT COUNT(*) FROM client_staff s JOIN clients c ON c.id=s.client_id WHERE s.employee_id=order_columns.employee_id AND c.status='active') = 1;`,
    // 6: pictures and voice notes in the chat. Stored in the database (so they are in every backup) and removed together with their message.
    `CREATE TABLE chat_attachments (
       id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE REFERENCES client_messages(id) ON DELETE CASCADE,
       client_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
     CREATE INDEX idx_chatatt_client ON chat_attachments(client_id);`,
    // 7: no private owner of a chat any more: every chat is open to everybody chosen for the client
    'UPDATE clients SET chat_owner_id=NULL;',
    // 8: every client update has a currency. What was written before keeps the company currency when that is AUD, USD or GBP (else USD).
    (d) => {
      d.raw.exec("ALTER TABLE client_reports ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
      let cur = 'USD';
      try { cur = JSON.parse(d.get("SELECT value FROM settings WHERE key='currency'")?.value ?? '"USD"'); } catch { /* keep USD */ }
      if (['AUD', 'USD', 'GBP'].includes(cur) && cur !== 'USD') d.run('UPDATE client_reports SET currency=?', cur);
    },
    // 9: every client has a currency: the one its figures are shown in. Existing clients keep what they had (the company currency).
    (d) => {
      d.raw.exec("ALTER TABLE clients ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
      let cur = 'USD';
      try { cur = JSON.parse(d.get("SELECT value FROM settings WHERE key='currency'")?.value ?? '"USD"'); } catch { /* keep USD */ }
      if (['AUD', 'USD', 'GBP'].includes(cur) && cur !== 'USD') d.run('UPDATE clients SET currency=?', cur);
    },
    // 10: one portal, a section ("Account N") for every person who writes for the client. Numbers follow the order in which people
    // first wrote an update or sent a sheet, so they are 1, 2, 3 ... without gaps; what exists now gets its number, nothing is lost.
    (d) => {
      d.raw.exec(`CREATE TABLE client_accounts (
        id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, who TEXT NOT NULL, number INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (client_id, who), UNIQUE (client_id, number));
        ALTER TABLE client_reports ADD COLUMN account_no INTEGER;`);
      const events = [];
      const who = (id) => (id ? `e${id}` : 'x');
      for (const r of d.all('SELECT client_id, submitted_by, MIN(created_at) AS at FROM client_reports GROUP BY client_id, submitted_by')) events.push({ clientId: r.clientId, who: who(r.submittedBy), at: r.at || '' });
      for (const p of d.all('SELECT client_id, employee_id, MIN(published_at) AS at FROM sheet_publications GROUP BY client_id, employee_id')) events.push({ clientId: p.clientId, who: who(p.employeeId), at: p.at || '' });
      events.sort((a, b) => a.clientId - b.clientId || a.at.localeCompare(b.at) || a.who.localeCompare(b.who));
      const next = {};
      const seen = new Set();
      for (const e of events) {
        const key = `${e.clientId}|${e.who}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next[e.clientId] = (next[e.clientId] || 0) + 1;
        d.run('INSERT INTO client_accounts(client_id, who, number, created_at) VALUES (?,?,?,?)', e.clientId, e.who, next[e.clientId], new Date().toISOString());
      }
      d.raw.exec(`UPDATE client_reports SET account_no = (SELECT a.number FROM client_accounts a WHERE a.client_id=client_reports.client_id AND a.who = COALESCE('e' || client_reports.submitted_by, 'x'));
        UPDATE sheet_publications SET account_no = (SELECT a.number FROM client_accounts a WHERE a.client_id=sheet_publications.client_id AND a.who = COALESCE('e' || sheet_publications.employee_id, 'x'));`);
    },
  ],

  routes(m) {
    // =============================== admin: the clients ===============================
    // Staff get a short list (client IDs of their scope) with the numbers they need; the admin gets the full records.
    m.get('/api/clients', { roles: STAFF }, (ctx) => {
      const rows = db.all(`${CLIENT_SELECT} ORDER BY d.sort, c.username`).filter((c) => inScope(ctx, c) && (ctx.user.role === 'admin' || c.status === 'active'));
      const ids = rows.map((c) => c.id);
      const last = lastMessages(ids);
      const day = today();
      const reports = ids.length ? db.all(`SELECT client_id, date, orders, investment, sales, currency FROM client_reports WHERE client_id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
      const by = {};
      for (const r of reports) (by[r.clientId] ||= []).push(r);
      return rows.map((c) => {
        return {
          ...shape(ctx, c),
          today: sumsIn((by[c.id] || []).filter((r) => r.date === day), c.currency), total: sumsIn(by[c.id] || [], c.currency), // in the client's currency
          todayBy: sumsBy((by[c.id] || []).filter((r) => r.date === day)), totalBy: sumsBy(by[c.id] || []), // as written, each currency on its own
          inquiryNeedsReply: !!last[c.id]?.inquiry?.fromClient, alertNeedsReply: !!last[c.id]?.alert?.fromClient,
          lastInquiryAt: last[c.id]?.inquiry?.at ?? null, lastAlertAt: last[c.id]?.alert?.at ?? null,
        };
      });
    });

    // The people the admin can choose from (used by the "Select team members" list): everybody, or one department / team.
    m.get('/api/clients/candidates', { roles: ['admin'] }, (ctx) => {
      const departmentId = ctx.query.departmentId ? int(ctx.query.departmentId, 'Department', { required: true }) : null;
      const teamId = int(ctx.query.teamId, 'Team');
      if (departmentId) checkTeam(departmentId, teamId);
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
      const ok = new Set(candidates().map((e) => e.id));
      if (wanted.some((id) => !ok.has(Number(id)))) throw bad('Only active team leaders and members can work for a client');
      const r = db.tx(() => {
        const row = db.insert('clients', {
          username, departmentId, teamId, displayName: str(b.displayName, 'Name', { max: 100 }), contact: str(b.contact, 'Contact', { max: 200 }),
          secretInfo: str(b.secretInfo, 'Account details', { max: 5000 }), passwordHash: auth.hashSecret(password), status: 'active', createdAt: now, updatedAt: now,
          currency: oneOf(b.currency === undefined || b.currency === null || b.currency === '' ? defaultCurrency() : b.currency, 'Currency', CURRENCIES, { required: true }),
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
      return { candidates: candidates(null, null, c.id).map((e) => ({ ...e, chosen: chosen.has(e.id), accountNo: clientAccounts.numberOf(c.id, e.id) })) };
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
      if (b.staffIds !== undefined) {
        const ok = new Set(candidates().map((e) => e.id));
        if (!Array.isArray(b.staffIds) || b.staffIds.some((id) => !ok.has(Number(id)))) throw bad('Only active team leaders and members can work for a client');
      }
      db.tx(() => {
        db.update('clients', c.id, {
          username, departmentId, teamId, status, displayName: str(b.displayName, 'Name', { max: 100 }), contact: str(b.contact, 'Contact', { max: 200 }),
          currency: b.currency === undefined || b.currency === null || b.currency === '' ? c.currency : oneOf(b.currency, 'Currency', CURRENCIES, { required: true }),
          ...(b.secretInfo !== undefined ? { secretInfo: str(b.secretInfo, 'Account details', { max: 5000 }) } : {}), updatedAt: new Date().toISOString(),
        });
        if (b.staffIds !== undefined) setStaff({ ...c, username, departmentId, teamId }, b.staffIds, ctx); // moving the client to another department or team keeps its people
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
    const reportInput = (b, fallbackCurrency = null) => {
      const day = date(b.date, 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      const e = {
        date: day, market: str(b.market, 'Market', { max: 100 }), store: str(b.store, 'Store / account', { max: 100 }),
        orders: int(b.orders ?? 0, 'Orders', { min: 0, max: 1e7 }), investment: num(b.investment ?? 0, 'Investment', { min: 0, max: 1e9 }), sales: num(b.sales ?? 0, 'Sales', { min: 0, max: 1e9 }),
        note: str(b.note, 'Update for the client', { max: 1000 }),
        currency: oneOf(b.currency === undefined || b.currency === null || b.currency === '' ? (fallbackCurrency || defaultCurrency()) : b.currency, 'Currency', CURRENCIES, { required: true }),
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
      if (!ids.length) return { rows: [], totals: sumsConverted([]), totalsBy: [] };
      const rows = db.all(`${REPORT_SELECT} WHERE r.client_id IN (${ids.map(() => '?').join(',')}) AND r.date BETWEEN ? AND ? ORDER BY r.date DESC, r.id DESC LIMIT 1000`, ...ids, from, to)
        .map((r) => ({ ...r, revenue: revenueOf(r), canEdit: canEditReport(ctx, r, clients[r.clientId]), by: r.submittedLabel || 'Team' }));
      return { rows, totals: sumsConverted(rows), totalsBy: sumsBy(rows) };
    });

    m.post('/api/client-reports', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.body.clientId);
      if (c.status !== 'active') throw bad('This client is disabled');
      const e = reportInput(ctx.body, c.currency);
      if (ctx.user.role === 'member' && e.date < addDays(today(), -31)) throw bad('You can only add updates from the last 31 days');
      const now = new Date().toISOString();
      const label = ctx.user.role === 'admin' ? 'Administrator' : db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId)?.name;
      const r = db.insert('client_reports', { clientId: c.id, ...e, submittedBy: ctx.user.employeeId ?? null, submittedLabel: label, accountNo: clientAccounts.ensure(c.id, ctx.user.employeeId ?? null), createdAt: now, updatedAt: now });
      ctx.audit('client_update', 'client', c.id, `${c.username} ${e.date}: ${e.orders} orders, sales ${e.sales} ${e.currency}`, c.departmentId);
      return { id: r.id };
    });

    m.put('/api/client-reports/:id', { roles: STAFF }, (ctx) => {
      const r = db.get('SELECT * FROM client_reports WHERE id=?', int(ctx.params.id, 'Update', { required: true }));
      if (!r) throw new HttpError(404, 'Update not found');
      const c = staffClient(ctx, r.clientId);
      if (!canEditReport(ctx, r, c)) throw new HttpError(403, 'You can only change your own updates for 7 days');
      const e = reportInput(ctx.body, r.currency);
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
      const channel = oneOf(ctx.query.channel, 'Channel', CHANNELS, { required: true });
      const after = Number(ctx.query.after) || 0;
      const rows = db.all('SELECT * FROM client_messages WHERE client_id=? AND channel=? AND id>? ORDER BY id DESC LIMIT 300', c.id, channel, after).reverse();
      // the client sees that their messages were read (by "eTricks": not by whom)
      db.run('UPDATE client_messages SET read_at=? WHERE client_id=? AND channel=? AND from_client=1 AND read_at IS NULL', new Date().toISOString(), c.id, channel);
      const last = db.get('SELECT from_client FROM client_messages WHERE client_id=? AND channel=? ORDER BY id DESC LIMIT 1', c.id, channel);
      const files = filesOf(rows);
      return { client: { id: c.id, username: c.username }, messages: rows.map((r) => toStaffMessage(r, files)), needsReply: !!last?.fromClient };
    });

    m.post('/api/clients/:id/chat', { roles: STAFF, maxBody: attachments.MAX_BODY }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      if (c.status !== 'active') throw bad('This client is disabled');
      const channel = oneOf(ctx.body.channel, 'Channel', CHANNELS, { required: true });
      const file = attachments.parse(ctx.body.attachment);
      const body = str(ctx.body.body, 'Message', { required: !file, max: 2000 }) ?? '';
      if (file && db.get('SELECT COUNT(*) AS n FROM chat_attachments WHERE client_id=? AND created_at>=? AND message_id IN (SELECT id FROM client_messages WHERE from_client=0)', c.id, new Date(Date.now() - 3600e3).toISOString()).n >= 60) throw new HttpError(429, 'Too many files in the last hour. Please wait a little.');
      const label = ctx.user.role === 'admin' ? 'Administrator' : db.get('SELECT name, role FROM employees WHERE id=?', ctx.user.employeeId);
      const who = typeof label === 'string' ? label : label.name;
      const now = new Date().toISOString();
      const r = db.tx(() => {
        const msg = db.insert('client_messages', { clientId: c.id, channel, fromClient: 0, staffId: ctx.user.employeeId ?? null, staffLabel: who, body, createdAt: now });
        if (file) db.insert('chat_attachments', { messageId: msg.id, clientId: c.id, kind: file.kind, mime: file.mime, size: file.size, data: file.data, createdAt: now });
        return msg;
      });
      ctx.audit(channel === 'alert' ? 'client_alert_sent' : 'client_message_sent', 'client', c.id, file ? `${c.username} (${file.kind})` : c.username, c.departmentId); // never the text
      // The text is never put into a notification: an alert may carry a code or a secret.
      notify.send({ clientId: c.id }, channel === 'alert'
        ? { title: 'URGENT: eTricks needs your attention now', body: 'Open the Alerts section of your portal.', link: '#/portal-alerts', kind: 'alert', urgent: true }
        : { title: 'New message from eTricks', link: '#/portal-chat', kind: 'chat' });
      return { id: r.id };
    });

    m.get('/api/clients/:id/chat/files/:fid', { roles: STAFF }, (ctx) => {
      const c = staffClient(ctx, ctx.params.id);
      const a = db.get('SELECT * FROM chat_attachments WHERE id=? AND client_id=?', int(ctx.params.fid, 'File', { required: true }), c.id);
      if (!a) throw new HttpError(404, 'File not found');
      return attachments.serve(ctx, a);
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
      const clients = db.all(`${CLIENT_SELECT} WHERE c.status='active'`).filter((c) => inScope(ctx, c));
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

    // Sales of the client: today, every day, every month and the total, all in the currency the admin chose for this client.
    // An update written in another currency is converted into it with the exchange rates of Settings (`converted` says so).
    m.get('/api/portal/sales', { roles: CLIENT }, (ctx) => {
      const c = me(ctx);
      const day = today();
      const from = ctx.query.from ? date(ctx.query.from, 'From') : addDays(day, -29);
      const to = ctx.query.to ? date(ctx.query.to, 'To') : day;
      if (from > to) throw bad('"To" cannot be before "From"');
      const conv = converterTo(c.currency);
      let converted = false;
      const everyRow = db.all('SELECT date, market, store, orders, investment, sales, note, currency, account_no FROM client_reports WHERE client_id=? ORDER BY date, id', c.id);
      // the sections of this client's portal: one per account that has something to show (updates or a sheet)
      const accountNos = [...new Set([...everyRow.map((r) => r.accountNo), ...db.all('SELECT account_no FROM sheet_publications WHERE client_id=?', c.id).map((r) => r.accountNo)].filter((n) => n != null))].sort((x, y) => x - y);
      const askedAccount = ctx.query.account === undefined || ctx.query.account === '' || ctx.query.account === 'all' ? null : int(ctx.query.account, 'Account', { required: true });
      if (askedAccount !== null && !accountNos.includes(askedAccount)) throw new HttpError(404, 'That section does not exist');
      const all = everyRow.filter((r) => askedAccount === null || r.accountNo === askedAccount).map((r) => {
        if (r.currency === c.currency) return r;
        converted = true;
        return { ...r, investment: round(conv(r.investment, r.currency)), sales: round(conv(r.sales, r.currency)) };
      });
      const monthStart = `${day.slice(0, 8)}01`;
      const inRange = all.filter((r) => r.date >= from && r.date <= to);
      const byDay = new Map();
      for (const r of inRange) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
      const days = [...byDay.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([d, rs]) => ({
        date: d, ...sums(rs),
        // what was done that day, as written for the client: always "eTricks"
        updates: rs.map((r) => ({ market: r.market, store: r.store, orders: r.orders, investment: r.investment, sales: r.sales, revenue: revenueOf(r), note: r.note })),
      }));
      const chart = [];
      for (let i = 13; i >= 0; i--) { const d = addDays(day, -i); chart.push({ date: d, ...sums(all.filter((r) => r.date === d)) }); }
      const block = {
        currency: c.currency,
        today: { date: day, ...sums(all.filter((r) => r.date === day)) },
        month: sums(all.filter((r) => r.date >= monthStart)),
        total: { ...sums(all), since: all[0]?.date ?? null, days: new Set(all.map((r) => r.date)).size },
        range: sums(inRange), days, chart,
      };
      return {
        username: c.username, departmentName: c.departmentName, currency: c.currency, from, to, date: day, converted, currencies: all.length ? [block] : [],
        accounts: accountNos.map((n) => ({ no: n, label: `Account ${n}` })), account: askedAccount === null ? 'all' : askedAccount,
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
      const files = filesOf(rows);
      return { messages: rows.map((r) => toClientMessage(r, files)) };
    });

    m.get('/api/portal/chat/files/:fid', { roles: CLIENT }, (ctx) => {
      const a = db.get('SELECT * FROM chat_attachments WHERE id=? AND client_id=?', int(ctx.params.fid, 'File', { required: true }), ctx.user.clientId);
      if (!a) throw new HttpError(404, 'File not found');
      return attachments.serve(ctx, a);
    });

    m.post('/api/portal/chat', { roles: CLIENT, maxBody: attachments.MAX_BODY }, (ctx) => {
      const c = me(ctx);
      const channel = oneOf(ctx.body.channel, 'Channel', CHANNELS, { required: true });
      const file = attachments.parse(ctx.body.attachment);
      const body = str(ctx.body.body, 'Message', { required: !file, max: 2000 }) ?? '';
      const hour = new Date(Date.now() - 3600e3).toISOString();
      if (file && db.get('SELECT COUNT(*) AS n FROM chat_attachments WHERE client_id=? AND created_at>=? AND message_id IN (SELECT id FROM client_messages WHERE from_client=1)', c.id, hour).n >= 30) throw new HttpError(429, 'Too many files in the last hour. Please wait a little.');
      if (db.get('SELECT COUNT(*) AS n FROM client_messages WHERE client_id=? AND from_client=1 AND created_at>=?', c.id, hour).n >= 120) throw new HttpError(429, 'Too many messages in the last hour. Please wait a little.');
      const now = new Date().toISOString();
      const r = db.tx(() => {
        const msg = db.insert('client_messages', { clientId: c.id, channel, fromClient: 1, body, createdAt: now });
        if (file) db.insert('chat_attachments', { messageId: msg.id, clientId: c.id, kind: file.kind, mime: file.mime, size: file.size, data: file.data, createdAt: now });
        return msg;
      });
      ctx.audit(channel === 'alert' ? 'client_alert' : 'client_message', 'client', c.id, file ? `${c.username} (${file.kind})` : c.username, c.departmentId); // never the text
      const payload = channel === 'alert'
        ? { title: `ALERT from client ${c.username}`, body: 'Needs an immediate reply.', link: '#/client-alerts', kind: 'alert', urgent: true }
        : { title: `New message from client ${c.username}`, link: '#/client-chat', kind: 'chat' };
      for (const to of chatRecipients(c)) notify.send(to, payload);
      return { id: r.id };
    });
  },
};
