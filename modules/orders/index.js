'use strict';
const db = require('../../core/db');
const { loadEmployee } = require('../../core/scope');
const { converter, rates, CURRENCIES } = require('../../core/currency');
const { HttpError, int, str, num, date, oneOf, range, today, addDays, bad, round, parseJson } = require('../../core/util');

/*
 * Daily reports from each team member, kept as a sheet: one row per report with the market, store, client, currency, orders
 * received, purchasing cost, total sales and notes, plus up to MAX_COLUMNS columns of the member's own.
 *
 *   - A team leader sees their team, the head of department all teams of the department, the admin everyone. The same rows
 *     are the figures behind the reports and dashboards (converted to the company currency with the rates in Settings).
 *   - A row can be tagged with one of the client IDs the member works for. That client sees the row (never the notes, never
 *     who wrote it) on the "Daily Sheet" page of the portal, live.
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
    const csvColumns = [
      { label: 'Date', key: 'date' }, { label: 'Market', key: 'market' }, { label: 'Store name', key: 'store' }, { label: 'Client', key: 'clientUsername' }, { label: 'Currency', key: 'currency' },
      { label: 'Orders received', key: 'orders' }, { label: 'Purchasing cost', key: 'investment' }, { label: 'Total sales', key: 'revenue' }, { label: 'Profit', value: (r) => round(r.profit) },
      { label: 'Notes / activities', key: 'note' },
    ];

    m.get('/api/orders/me', { roles: self }, (ctx) => {
      const { from, to } = range(ctx.query);
      const rows = sheetOf(ctx.user.employeeId, from, to);
      if (ctx.query.format === 'csv') return ctx.csv('my-daily-reports.csv', csvColumns, rows);
      return { rows, totals: totals(rows), columns: myColumns(ctx.user.employeeId), clients: myClients(ctx), fx: rates(), currencies: CURRENCIES, editDays: EDIT_DAYS };
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
      return { person: { id: emp.id, name: emp.name, empCode: emp.empCode, role: emp.role, teamName: team }, rows, totals: totals(rows), columns: myColumns(emp.id), fx: rates(), from, to };
    });

    // ---- the client's view: the rows shared with it, never the notes and never who wrote them ----
    m.get('/api/portal/sheet', { roles: ['client'] }, (ctx) => {
      const day = today();
      const from = ctx.query.from ? date(ctx.query.from, 'From') : addDays(day, -60);
      const to = ctx.query.to ? date(ctx.query.to, 'To') : day;
      if (from > to) throw bad('"To" cannot be before "From"');
      const raw = db.all(
        `SELECT employee_id, date, market, store, currency, orders, investment, revenue, extra FROM member_orders
          WHERE client_id=? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 1000`, ctx.user.clientId, from, to);
      const visible = {};
      for (const c of db.all('SELECT id, label, employee_id FROM order_columns WHERE client_visible=1')) (visible[c.employeeId] ||= []).push(c);
      const rows = raw.map((r) => {
        const x = parseJson(r.extra, {});
        return {
          date: r.date, market: r.market, store: r.store, currency: r.currency, orders: r.orders, investment: r.investment, revenue: r.revenue, profit: round(r.revenue - r.investment),
          custom: (visible[r.employeeId] || []).filter((c) => x[c.id] !== undefined && x[c.id] !== null).map((c) => ({ label: c.label, value: x[c.id] })),
        };
      });
      return { username: db.get('SELECT username FROM clients WHERE id=?', ctx.user.clientId)?.username ?? null, rows, totals: totals(raw.map((r) => ({ ...r }))).byCurrency, from, to };
    });
  },
};
