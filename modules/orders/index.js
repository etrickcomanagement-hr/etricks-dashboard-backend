'use strict';
const crypto = require('node:crypto');
const db = require('../../core/db');
const notify = require('../../core/notify');
const { loadEmployee } = require('../../core/scope');
const { converter, rates, CURRENCIES } = require('../../core/currency');
const { HttpError, int, str, num, date, oneOf, range, today, addDays, bad, round, parseJson } = require('../../core/util');

/*
 * Daily reports from each team member, kept as a sheet: one row per report with the market, store, client, currency, orders
 * received, purchasing cost, total sales and notes, plus up to MAX_COLUMNS columns of the member's own.
 *
 *   - A team leader sees their team, the head of department all teams of the department, the admin everyone. The same rows
 *     are the figures behind the reports and dashboards (converted to the company currency with the rates in Settings).
 *   - The member edits the sheet freely (leaders, heads and the admin see it live). The client sees it only when the member
 *     presses "Update client": that sends a copy of the sheet exactly as it is (every column, every row, notes too) for the
 *     period on screen. Rows tagged with another client are left out. The client never learns who wrote it.
 *   - These figures are NOT added to the department Finance page automatically (avoids double counting).
 */
const MAX_COLUMNS = 6;
const EDIT_DAYS = 7;

const SELECT = `
  SELECT o.*, (o.revenue - o.investment) AS profit, e.name AS employee_name, e.emp_code, e.team_id, e.role AS employee_role,
         d.name AS department_name, t.name AS team_name, cl.username AS client_username
    FROM member_orders o
    JOIN employees e ON e.id=o.employee_id
    JOIN departments d ON d.id=o.department_id
    LEFT JOIN teams t ON t.id=e.team_id
    LEFT JOIN clients cl ON cl.id=o.client_id`;

const shape = (r) => ({ ...r, extra: parseJson(r.extra, {}) });

// Totals in the company currency (converted row by row) and, next to them, the plain totals of each currency.
const totals = (rows) => {
  const conv = converter();
  let orders = 0, investment = 0, revenue = 0;
  const by = {};
  for (const r of rows) {
    orders += r.orders; investment += conv(r.investment, r.currency); revenue += conv(r.revenue, r.currency);
    const b = (by[r.currency] ||= { orders: 0, investment: 0, revenue: 0 });
    b.orders += r.orders; b.investment += r.investment; b.revenue += r.revenue;
  }
  return {
    orders, investment: round(investment), revenue: round(revenue), profit: round(revenue - investment), entries: rows.length,
    byCurrency: Object.fromEntries(Object.entries(by).map(([c, t]) => [c, { orders: t.orders, investment: round(t.investment), revenue: round(t.revenue), profit: round(t.revenue - t.investment) }])),
  };
};

module.exports = {
  id: 'orders',
  name: 'Member Orders',
  description: 'Daily orders, investment and sales reported by each team member.',
  order: 45,

  migrations: [
    `CREATE TABLE member_orders (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), department_id INTEGER NOT NULL,
       date TEXT NOT NULL, store TEXT, orders INTEGER NOT NULL DEFAULT 0, investment REAL NOT NULL DEFAULT 0,
       revenue REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_mo_emp ON member_orders(employee_id, date);
     CREATE INDEX idx_mo_dept ON member_orders(department_id, date);`,
    // 2: the market the report is about (free text)
    'ALTER TABLE member_orders ADD COLUMN market TEXT;',
    // 3: the report is a sheet row: a currency, the client it is shared with and the member's own columns
    `ALTER TABLE member_orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
     ALTER TABLE member_orders ADD COLUMN client_id INTEGER;
     ALTER TABLE member_orders ADD COLUMN extra TEXT;
     CREATE INDEX idx_mo_client ON member_orders(client_id, date);
     CREATE TABLE order_columns (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, label TEXT NOT NULL,
       kind TEXT NOT NULL DEFAULT 'text', client_visible INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
     CREATE INDEX idx_oc_emp ON order_columns(employee_id);`,
    // 4: "Update client": the copy of the sheet a client sees (one per member and client, replaced by every update)
    `CREATE TABLE sheet_publications (
       id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
       from_date TEXT NOT NULL, to_date TEXT NOT NULL, data TEXT NOT NULL, hash TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0,
       published_at TEXT NOT NULL, UNIQUE (client_id, employee_id));
     CREATE INDEX idx_pub_client ON sheet_publications(client_id);`,
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['leader', 'member'];

    const myColumns = (employeeId) => db.all('SELECT id, label, kind, client_visible, position FROM order_columns WHERE employee_id=? ORDER BY position, id', employeeId)
      .map((c) => ({ id: c.id, label: c.label, kind: c.kind, clientVisible: !!c.clientVisible }));
    // The clients a person may tag a row with: the ones the admin chose them for.
    const myClients = (ctx) => db.all(
      `SELECT c.id, c.username FROM client_staff s JOIN clients c ON c.id=s.client_id
        WHERE s.employee_id=? AND c.status='active' AND c.department_id=? ORDER BY c.username`, ctx.user.employeeId, ctx.user.departmentId);

    // Validates a row. `old` is the stored row when editing: fields that are not sent keep their value.
    const input = (b, ctx, old) => {
      const pick = (k, keep) => (b[k] === undefined ? keep : b[k]);
      const day = date(pick('date', old?.date), 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      if (day < addDays(today(), -31)) throw bad('You can only report orders from the last 31 days');
      const e = {
        date: day, market: str(pick('market', old?.market), 'Market', { max: 100 }), store: str(pick('store', old?.store), 'Store name', { max: 100 }),
        orders: int(pick('orders', old?.orders) ?? 0, 'Orders', { min: 0, max: 1e6 }),
        investment: num(pick('investment', old?.investment) ?? 0, 'Purchasing cost', { min: 0, max: 1e9 }), revenue: num(pick('revenue', old?.revenue) ?? 0, 'Total sales', { min: 0, max: 1e9 }),
        note: str(pick('note', old?.note), 'Notes / activities', { max: 1000 }),
        currency: oneOf(pick('currency', old?.currency) || 'USD', 'Currency', CURRENCIES),
      };
      // the client this row is shared with: only one of the person's own clients (an old tag may stay as it is)
      const cid = int(pick('clientId', old?.clientId) ?? null, 'Client');
      if (cid != null && cid !== (old?.clientId ?? null) && !myClients(ctx).some((c) => c.id === cid)) throw bad('You can only share a report with a client you work for');
      e.clientId = cid;
      // the member's own columns
      const cols = new Map(myColumns(ctx.user.employeeId).map((c) => [String(c.id), c]));
      const raw = b.extra === undefined ? parseJson(old?.extra, {}) : b.extra;
      if (raw && (typeof raw !== 'object' || Array.isArray(raw))) throw bad('Extra columns are invalid');
      const extra = {};
      for (const [k, v] of Object.entries(raw || {})) {
        const col = cols.get(k);
        if (!col || v === '' || v === null || v === undefined) continue; // a deleted column or an empty cell
        extra[k] = col.kind === 'number' ? num(v, col.label, { min: -1e9, max: 1e9 }) : str(v, col.label, { max: 200 });
      }
      e.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
      if (!e.orders && !e.investment && !e.revenue && !e.note && !e.market && !e.store && !e.extra) throw bad('Enter at least orders, purchasing cost, total sales, a note or a market / store');
      return e;
    };
    const auditText = (e) => `${e.date}: ${e.orders} orders, total sales ${e.revenue} ${e.currency}, purchasing cost ${e.investment}`;

    // ---- members and team leaders write their own daily report ----
    // The admin and the head of department see the leaders' reports; a leader sees only the reports of their team's members.
    const sheetOf = (employeeId, from, to) => db.all(`${SELECT} WHERE o.employee_id=? AND o.date BETWEEN ? AND ? ORDER BY o.date DESC, o.id DESC LIMIT 2000`, employeeId, from, to).map(shape);
    // What a client would see right now: every row of the period that is not tagged for another client, and every column.
    const snapshotFor = (employeeId, clientId, from, to) => {
      const rows = db.all(`${SELECT} WHERE o.employee_id=? AND o.date BETWEEN ? AND ? AND (o.client_id IS NULL OR o.client_id=?) ORDER BY o.date, o.id LIMIT 2000`, employeeId, from, to, clientId).map(shape);
      const data = {
        columns: myColumns(employeeId).map((c) => ({ id: c.id, label: c.label, kind: c.kind })),
        rows: rows.map((r) => ({
          date: r.date, market: r.market, store: r.store, currency: r.currency, orders: r.orders, investment: r.investment, revenue: r.revenue,
          profit: round(r.revenue - r.investment), note: r.note, extra: r.extra,
        })),
      };
      return { data, hash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 24) };
    };
    // The copies this person has sent, and whether each is still the same as the sheet now.
    const publicationsOf = (employeeId) => db.all(
      `SELECT p.client_id, p.from_date, p.to_date, p.hash, p.row_count, p.published_at, c.username FROM sheet_publications p JOIN clients c ON c.id=p.client_id WHERE p.employee_id=? ORDER BY p.id`, employeeId)
      .map((p) => ({ clientId: p.clientId, username: p.username, publishedAt: p.publishedAt, from: p.fromDate, to: p.toDate, rows: p.rowCount, upToDate: snapshotFor(employeeId, p.clientId, p.fromDate, p.toDate).hash === p.hash }));

    const csvColumns = [
      { label: 'Date', key: 'date' }, { label: 'Market', key: 'market' }, { label: 'Store name', key: 'store' }, { label: 'Client', key: 'clientUsername' }, { label: 'Currency', key: 'currency' },
      { label: 'Orders received', key: 'orders' }, { label: 'Purchasing cost', key: 'investment' }, { label: 'Total sales', key: 'revenue' }, { label: 'Profit', value: (r) => round(r.profit) },
      { label: 'Notes / activities', key: 'note' },
    ];

    m.get('/api/orders/me', { roles: self }, (ctx) => {
      const { from, to } = range(ctx.query);
      const rows = sheetOf(ctx.user.employeeId, from, to);
      if (ctx.query.format === 'csv') return ctx.csv('my-daily-reports.csv', csvColumns, rows);
      return { rows, totals: totals(rows), columns: myColumns(ctx.user.employeeId), clients: myClients(ctx), fx: rates(), currencies: CURRENCIES, editDays: EDIT_DAYS, published: publicationsOf(ctx.user.employeeId) };
    });

    // "Update client": send the client a copy of the sheet as it is now.
    m.post('/api/orders/publish', { roles: self }, (ctx) => {
      const clientId = int(ctx.body.clientId, 'Client', { required: true });
      const client = myClients(ctx).find((c) => c.id === clientId);
      if (!client) throw bad('You can only update a client you work for');
      const from = date(ctx.body.from, 'From', { required: true });
      const to = date(ctx.body.to, 'To', { required: true });
      if (from > to) throw bad('"To" cannot be before "From"');
      if (from < addDays(to, -366)) throw bad('Send up to one year at a time');
      const { data, hash } = snapshotFor(ctx.user.employeeId, clientId, from, to);
      if (!data.rows.length) throw bad('Nothing to send: your sheet has no rows in this period');
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO sheet_publications(client_id, employee_id, from_date, to_date, data, hash, row_count, published_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(client_id, employee_id) DO UPDATE SET from_date=excluded.from_date, to_date=excluded.to_date, data=excluded.data, hash=excluded.hash, row_count=excluded.row_count, published_at=excluded.published_at`,
        clientId, ctx.user.employeeId, from, to, JSON.stringify(data), hash, data.rows.length, now);
      ctx.audit('sheet_published', 'orders', clientId, `${client.username}: ${data.rows.length} rows, ${from} to ${to}`); // never the figures
      notify.send({ clientId }, { title: 'Your sheet was updated', body: 'Open the Daily Sheet page of your portal.', link: '#/portal-sheet', kind: 'sheet' });
      return { clientId, username: client.username, publishedAt: now, rows: data.rows.length, from, to, upToDate: true };
    });

    // Stop showing the sheet to a client.
    m.del('/api/orders/publish/:clientId', { roles: self }, (ctx) => {
      const clientId = int(ctx.params.clientId, 'Client', { required: true });
      const n = db.run('DELETE FROM sheet_publications WHERE client_id=? AND employee_id=?', clientId, ctx.user.employeeId).changes;
      if (n) ctx.audit('sheet_unpublished', 'orders', clientId, null);
      return { ok: true };
    });

    m.post('/api/orders', { roles: self }, (ctx) => {
      const e = input(ctx.body, ctx, null);
      const now = new Date().toISOString();
      const r = db.insert('member_orders', { ...e, employeeId: ctx.user.employeeId, departmentId: ctx.user.departmentId, createdAt: now, updatedAt: now });
      ctx.audit('orders_reported', 'orders', r.id, auditText(e));
      return { id: r.id };
    });

    const own = (ctx) => {
      const o = db.get('SELECT * FROM member_orders WHERE id=? AND employee_id=?', int(ctx.params.id, 'Entry', { required: true }), ctx.user.employeeId);
      if (!o) throw new HttpError(404, 'Entry not found');
      if (o.date < addDays(today(), -EDIT_DAYS)) throw bad('Entries older than 7 days can no longer be changed. Please ask your team leader.');
      return o;
    };
    m.put('/api/orders/:id', { roles: self }, (ctx) => {
      const o = own(ctx);
      const e = input(ctx.body, ctx, o);
      db.update('member_orders', o.id, { ...e, updatedAt: new Date().toISOString() });
      ctx.audit('orders_edited', 'orders', o.id, auditText(e));
      return { ok: true };
    });
    m.del('/api/orders/:id', { roles: self }, (ctx) => {
      const o = own(ctx);
      db.run('DELETE FROM member_orders WHERE id=?', o.id);
      ctx.audit('orders_deleted', 'orders', o.id, `${o.date}: ${o.orders} orders`);
      return { ok: true };
    });

    // ---- the member's own columns ----
    const columnInput = (b) => ({
      label: str(b.label, 'Column name', { required: true, max: 30 }),
      kind: oneOf(b.kind || 'text', 'Type', ['text', 'number']),
      clientVisible: b.clientVisible ? 1 : 0,
    });
    const ownColumn = (ctx) => {
      const c = db.get('SELECT * FROM order_columns WHERE id=? AND employee_id=?', int(ctx.params.id, 'Column', { required: true }), ctx.user.employeeId);
      if (!c) throw new HttpError(404, 'Column not found');
      return c;
    };
    const sameLabel = (employeeId, label, exceptId) => db.get('SELECT 1 AS x FROM order_columns WHERE employee_id=? AND lower(label)=lower(?) AND id<>?', employeeId, label, exceptId ?? 0);
    const RESERVED = ['date', 'market', 'store', 'store name', 'client', 'currency', 'orders', 'orders received', 'purchasing cost', 'total sales', 'profit', 'notes', 'notes / activities'];

    m.post('/api/orders/columns', { roles: self }, (ctx) => {
      const c = columnInput(ctx.body);
      if (RESERVED.includes(c.label.toLowerCase()) || sameLabel(ctx.user.employeeId, c.label)) throw bad('You already have a column with that name');
      if (db.get('SELECT COUNT(*) AS n FROM order_columns WHERE employee_id=?', ctx.user.employeeId).n >= MAX_COLUMNS) throw bad(`You can add up to ${MAX_COLUMNS} columns of your own`);
      const pos = (db.get('SELECT COALESCE(MAX(position),0)+1 AS p FROM order_columns WHERE employee_id=?', ctx.user.employeeId).p);
      const r = db.insert('order_columns', { employeeId: ctx.user.employeeId, label: c.label, kind: c.kind, clientVisible: c.clientVisible, position: pos, createdAt: new Date().toISOString() });
      ctx.audit('orders_column_added', 'orders', r.id, c.label);
      return { id: r.id };
    });
    m.put('/api/orders/columns/:id', { roles: self }, (ctx) => {
      const col = ownColumn(ctx);
      const c = columnInput({ kind: col.kind, ...ctx.body }); // the type of a column with data cannot change
      if (RESERVED.includes(c.label.toLowerCase()) || sameLabel(ctx.user.employeeId, c.label, col.id)) throw bad('You already have a column with that name');
      db.update('order_columns', col.id, { label: c.label, clientVisible: c.clientVisible });
      return { ok: true };
    });
    m.del('/api/orders/columns/:id', { roles: self }, (ctx) => {
      const col = ownColumn(ctx);
      db.tx(() => {
        for (const r of db.all("SELECT id, extra FROM member_orders WHERE employee_id=? AND extra IS NOT NULL", ctx.user.employeeId)) {
          const x = parseJson(r.extra, {});
          if (String(col.id) in x) { delete x[col.id]; db.run('UPDATE member_orders SET extra=? WHERE id=?', Object.keys(x).length ? JSON.stringify(x) : null, r.id); }
        }
        db.run('DELETE FROM order_columns WHERE id=?', col.id);
      });
      ctx.audit('orders_column_deleted', 'orders', col.id, col.label);
      return { ok: true };
    });

    // ---- leader / head / admin ----
    m.get('/api/orders', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const { from, to } = range(q);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${SELECT} WHERE instr(?, ',' || e.role || ',') > 0 AND o.date BETWEEN ? AND ? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR o.employee_id=?)
            AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR o.store LIKE ? OR o.market LIKE ? OR cl.username LIKE ?)
          ORDER BY o.date DESC, e.name LIMIT 3000`,
        ctx.rolesCsv(), from, to, dept, dept, q.employeeId || null, q.employeeId || null, team, team, search, search, search, search, search, search).map(shape);
      if (q.format === 'csv') {
        return ctx.csv('member-orders.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' }, { label: 'Role', key: 'employeeRole' }, { label: 'Department', key: 'departmentName' },
          { label: 'Team', key: 'teamName' }, { label: 'Market', key: 'market' }, { label: 'Store name', key: 'store' }, { label: 'Client', key: 'clientUsername' }, { label: 'Currency', key: 'currency' },
          { label: 'Orders received', key: 'orders' }, { label: 'Purchasing cost', key: 'investment' },
          { label: 'Total sales', key: 'revenue' }, { label: 'Profit', value: (r) => round(r.profit) }, { label: 'Notes / activities', key: 'note' },
        ], rows);
      }
      const by = {};
      for (const r of rows) (by[r.employeeId] ||= { employeeId: r.employeeId, name: r.employeeName, empCode: r.empCode, role: r.employeeRole, departmentName: r.departmentName, rows: [] }).rows.push(r);
      const byEmployee = Object.values(by).map((g) => ({ employeeId: g.employeeId, name: g.name, empCode: g.empCode, role: g.role, departmentName: g.departmentName, ...totals(g.rows) }))
        .sort((a, b) => b.revenue - a.revenue);
      const teams = {};
      for (const r of rows) (teams[r.teamId ?? 0] ||= { teamId: r.teamId, name: r.teamName || 'No team', rows: [] }).rows.push(r);
      const byTeam = Object.values(teams).map((g) => ({ teamId: g.teamId, name: g.name, ...totals(g.rows) })).sort((a, b) => b.revenue - a.revenue);
      return { rows, totals: totals(rows), byEmployee, byTeam, fx: rates() };
    });

    // One person's whole sheet (their own columns too), for the people above them. Read only.
    m.get('/api/orders/sheet/:employeeId', { roles: lead }, (ctx) => {
      const emp = loadEmployee(int(ctx.params.employeeId, 'Person', { required: true }));
      if (!emp) throw new HttpError(404, 'Person not found');
      ctx.assertSee(emp);
      if (emp.role === 'hod') throw new HttpError(403, 'You cannot open this person');
      const { from, to } = range(ctx.query);
      const rows = sheetOf(emp.id, from, to);
      const team = emp.teamId ? db.get('SELECT name FROM teams WHERE id=?', emp.teamId)?.name : null;
      return { person: { id: emp.id, name: emp.name, empCode: emp.empCode, role: emp.role, teamName: team }, rows, totals: totals(rows), columns: myColumns(emp.id), fx: rates(), from, to, published: publicationsOf(emp.id) };
    });

    // ---- the client's view: the copies of the sheet the team sent, exactly as sent ----
    // One sheet per member who updated this client; the client never learns who ("Sheet 1", "Sheet 2" only when there are several).
    m.get('/api/portal/sheet', { roles: ['client'] }, (ctx) => {
      const pubs = db.all('SELECT id, from_date, to_date, data, published_at FROM sheet_publications WHERE client_id=? ORDER BY id', ctx.user.clientId);
      const sheets = pubs.map((p, i) => {
        const d = parseJson(p.data, { columns: [], rows: [] });
        return { title: pubs.length > 1 ? `Sheet ${i + 1}` : 'Sheet', publishedAt: p.publishedAt, from: p.fromDate, to: p.toDate, columns: d.columns, rows: d.rows, totals: totals(d.rows).byCurrency };
      });
      return { username: db.get('SELECT username FROM clients WHERE id=?', ctx.user.clientId)?.username ?? null, sheets };
    });
    // A tiny answer the page asks every few seconds: it loads the sheets only when this changes.
    m.get('/api/portal/sheet/stamp', { roles: ['client'] }, (ctx) => ({
      stamp: db.all('SELECT id, published_at FROM sheet_publications WHERE client_id=? ORDER BY id', ctx.user.clientId).map((p) => `${p.id}:${p.publishedAt}`).join('|'),
    }));
  },
};
