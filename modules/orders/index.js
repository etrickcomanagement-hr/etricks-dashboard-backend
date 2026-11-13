'use strict';
const crypto = require('node:crypto');
const db = require('../../core/db');
const notify = require('../../core/notify');
const { loadEmployee } = require('../../core/scope');
const clientAccounts = require('../../core/clientaccounts');
const { converter, rates, CURRENCIES } = require('../../core/currency');
const { HttpError, int, str, num, date, oneOf, range, today, addDays, bad, round, parseJson } = require('../../core/util');

/*
 * The daily sheet of each team member. One row per order, with these permanent columns:
 *   SR#, Date, Order Id, Customer Details, Qty, Supplier Order No, You Earned, Ali Exp Price, Net Profit, ROI %, Comments, Refunds,
 *   Note about orders   (+ Currency: AUD, USD or GBP)
 * and, for the team only, Market and Store. Net Profit and ROI % are worked out. On top of these the member can add up to
 * MAX_COLUMNS columns of their own and decide for each whether the client sees it.
 *
 *   - Qty, You Earned and Ali Exp Price are the fields the reports have always used (orders, total sales, purchasing cost), so
 *     every report and dashboard keeps working; amounts of other currencies are converted with the rates in Settings.
 *   - A member who works for clients has ONE SHEET PER CLIENT (rows and columns of one never touch another's). A member
 *     without a client has one general sheet.
 *   - The member edits freely; leaders, heads and the admin see it live. The client sees a copy only when the member presses
 *     "Update client": the whole sheet of that client, the permanent columns and the columns marked for the client. The client
 *     never learns who wrote it. The client's Sales page (today, daily, monthly, total) is worked out from these copies.
 */
const MAX_COLUMNS = 6;
const EDIT_DAYS = 7;
const MAX_SHEET_ROWS = 2000;

const SELECT = `
  SELECT o.*, (o.revenue - o.investment) AS profit, e.name AS employee_name, e.emp_code, e.team_id, e.role AS employee_role,
         d.name AS department_name, t.name AS team_name, cl.username AS client_username
    FROM member_orders o
    JOIN employees e ON e.id=o.employee_id
    JOIN departments d ON d.id=o.department_id
    LEFT JOIN teams t ON t.id=e.team_id
    LEFT JOIN clients cl ON cl.id=o.client_id`;

const roiOf = (investment, profit) => (investment > 0 ? round((profit / investment) * 100) : null);
const shape = (r) => ({ ...r, extra: parseJson(r.extra, {}), roi: roiOf(r.investment, r.revenue - r.investment) });

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
    // 5: the permanent columns of the sheet, and the sheet of one client (client_id of a column = the sheet it belongs to; empty = the general sheet)
    `ALTER TABLE member_orders ADD COLUMN order_id TEXT;
     ALTER TABLE member_orders ADD COLUMN customer TEXT;
     ALTER TABLE member_orders ADD COLUMN supplier_order_no TEXT;
     ALTER TABLE member_orders ADD COLUMN comments TEXT;
     ALTER TABLE member_orders ADD COLUMN refunds TEXT;
     ALTER TABLE order_columns ADD COLUMN client_id INTEGER;`,
    // 6: what a client was sent stays with the client when the person who wrote it leaves (employee_id becomes empty)
    `CREATE TABLE sheet_publications_new (
       id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
       from_date TEXT NOT NULL, to_date TEXT NOT NULL, data TEXT NOT NULL, hash TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0,
       published_at TEXT NOT NULL, UNIQUE (client_id, employee_id));
     INSERT INTO sheet_publications_new SELECT id, client_id, employee_id, from_date, to_date, data, hash, row_count, published_at FROM sheet_publications;
     DROP TABLE sheet_publications;
     ALTER TABLE sheet_publications_new RENAME TO sheet_publications;
     CREATE INDEX idx_pub_client ON sheet_publications(client_id);`,
    // 7: which section ("Account 1", "Account 2" ...) of the client's portal a copy belongs to; the clients module fills it in
    'ALTER TABLE sheet_publications ADD COLUMN account_no INTEGER;',
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['leader', 'member'];

    // The columns of one sheet (a client's sheet, or the general sheet when clientId is null).
    const sheetColumns = (employeeId, clientId) => db.all(
      'SELECT id, label, kind, client_visible, position FROM order_columns WHERE employee_id=? AND client_id IS ? ORDER BY position, id', employeeId, clientId ?? null)
      .map((c) => ({ id: c.id, label: c.label, kind: c.kind, clientVisible: !!c.clientVisible }));
    // The clients a person works for (the admin chose them): each is a sheet of its own.
    // (from any department: the admin may choose a person of another department for a client)
    const clientsOf = (employeeId) => db.all(
      `SELECT c.id, c.username FROM client_staff s JOIN clients c ON c.id=s.client_id
        WHERE s.employee_id=? AND c.status='active' ORDER BY c.username`, employeeId);
    const myClients = (ctx) => clientsOf(ctx.user.employeeId);

    // Which sheet something belongs to. With exactly one client that is simply the sheet; with several the screen says which.
    const sheetClient = (ctx, requested) => {
      const mine = myClients(ctx);
      const cid = int(requested ?? null, 'Client');
      if (cid == null) {
        if (mine.length > 1) throw bad("Choose which client's sheet this is for");
        return mine[0]?.id ?? null;
      }
      if (!mine.some((c) => c.id === cid)) throw bad('You can only use the sheet of a client you work for');
      return cid;
    };

    // Validates a row. `old` is the stored row when editing: fields that are not sent keep their value, and the row stays on its sheet.
    const input = (b, ctx, old) => {
      const pick = (k, keep) => (b[k] === undefined ? keep : b[k]);
      const day = date(pick('date', old?.date), 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      if (day < addDays(today(), -31)) throw bad('You can only report orders from the last 31 days');
      const e = {
        date: day, market: str(pick('market', old?.market), 'Market', { max: 100 }), store: str(pick('store', old?.store), 'Store name', { max: 100 }),
        orderId: str(pick('orderId', old?.orderId), 'Order Id', { max: 60 }), customer: str(pick('customer', old?.customer), 'Customer details', { max: 300 }),
        supplierOrderNo: str(pick('supplierOrderNo', old?.supplierOrderNo), 'Supplier order no', { max: 60 }),
        orders: int(pick('orders', old?.orders) ?? 0, 'Qty', { min: 0, max: 1e6 }),
        investment: num(pick('investment', old?.investment) ?? 0, 'Ali Exp price', { min: 0, max: 1e9 }), revenue: num(pick('revenue', old?.revenue) ?? 0, 'You earned', { min: 0, max: 1e9 }),
        comments: str(pick('comments', old?.comments), 'Comments', { max: 500 }), refunds: str(pick('refunds', old?.refunds), 'Refunds', { max: 100 }),
        note: str(pick('note', old?.note), 'Note about orders', { max: 1000 }),
        currency: oneOf(pick('currency', old?.currency) || 'USD', 'Currency', CURRENCIES),
      };
      e.clientId = old ? old.clientId ?? null : sheetClient(ctx, b.clientId);
      // the member's own columns of that sheet
      const cols = new Map(sheetColumns(ctx.user.employeeId, e.clientId).map((c) => [String(c.id), c]));
      const raw = b.extra === undefined ? parseJson(old?.extra, {}) : b.extra;
      if (raw && (typeof raw !== 'object' || Array.isArray(raw))) throw bad('Extra columns are invalid');
      const extra = {};
      for (const [k, v] of Object.entries(raw || {})) {
        const col = cols.get(k);
        if (!col || v === '' || v === null || v === undefined) continue; // a deleted column or an empty cell
        extra[k] = col.kind === 'number' ? num(v, col.label, { min: -1e9, max: 1e9 }) : str(v, col.label, { max: 200 });
      }
      e.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
      if (!e.orders && !e.investment && !e.revenue && !e.note && !e.market && !e.store && !e.orderId && !e.customer && !e.supplierOrderNo && !e.comments && !e.refunds && !e.extra) {
        throw bad('Fill in at least one cell of the row');
      }
      return e;
    };
    const auditText = (e) => `${e.date}: ${e.orders} qty, earned ${e.revenue} ${e.currency}, price ${e.investment}`;

    // ---- the sheet of one person ----
    const sheetOf = (employeeId, clientId, from, to) => db.all(
      `${SELECT} WHERE o.employee_id=? AND o.client_id IS ? AND o.date BETWEEN ? AND ? ORDER BY o.date DESC, o.id DESC LIMIT ${MAX_SHEET_ROWS}`, employeeId, clientId ?? null, from, to).map(shape);

    // What a client would see right now: the whole sheet of that client (newest MAX_SHEET_ROWS rows), the permanent columns and
    // the columns of the sheet marked for the client.
    const snapshotFor = (employeeId, clientId) => {
      const rows = db.all(`${SELECT} WHERE o.employee_id=? AND o.client_id=? ORDER BY o.date DESC, o.id DESC LIMIT ${MAX_SHEET_ROWS}`, employeeId, clientId).map(shape).reverse();
      const visible = sheetColumns(employeeId, clientId).filter((c) => c.clientVisible);
      const ids = new Set(visible.map((c) => String(c.id)));
      const data = {
        columns: visible.map((c) => ({ id: c.id, label: c.label, kind: c.kind })),
        rows: rows.map((r) => ({
          date: r.date, orderId: r.orderId, customer: r.customer, orders: r.orders, supplierOrderNo: r.supplierOrderNo, currency: r.currency, revenue: r.revenue, investment: r.investment,
          profit: round(r.revenue - r.investment), roi: r.roi, comments: r.comments, refunds: r.refunds, note: r.note,
          extra: Object.fromEntries(Object.entries(r.extra).filter(([k]) => ids.has(k))),
        })),
      };
      return { data, hash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 24) };
    };
    // The copies this person has sent, and whether each is still the same as the sheet now.
    const publicationsOf = (employeeId) => db.all(
      `SELECT p.client_id, p.hash, p.row_count, p.published_at, p.account_no, c.username FROM sheet_publications p JOIN clients c ON c.id=p.client_id WHERE p.employee_id=? ORDER BY p.id`, employeeId)
      .map((p) => ({ clientId: p.clientId, username: p.username, account: p.accountNo, publishedAt: p.publishedAt, rows: p.rowCount, upToDate: snapshotFor(employeeId, p.clientId).hash === p.hash }));

    const csvColumns = [
      { label: 'SR#', key: 'sr' }, { label: 'Date', key: 'date' }, { label: 'Order Id', key: 'orderId' }, { label: 'Customer Details', key: 'customer' }, { label: 'Qty', key: 'orders' },
      { label: 'Supplier Order No', key: 'supplierOrderNo' }, { label: 'Currency', key: 'currency' }, { label: 'You Earned', key: 'revenue' }, { label: 'Ali Exp Price', key: 'investment' },
      { label: 'Net Profit', value: (r) => round(r.profit) }, { label: 'ROI %', key: 'roi' }, { label: 'Comments', key: 'comments' }, { label: 'Refunds', key: 'refunds' },
      { label: 'Note about orders', key: 'note' }, { label: 'Market', key: 'market' }, { label: 'Store', key: 'store' },
    ];

    // Which sheets a person has: one per client they work for, and the general sheet when they have no client or rows without one.
    const sheetTabs = (employeeId, departmentId) => {
      const clients = clientsOf(employeeId);
      const general = clients.length === 0 || db.get('SELECT 1 AS x FROM member_orders WHERE employee_id=? AND client_id IS NULL LIMIT 1', employeeId)
        || db.get('SELECT 1 AS x FROM order_columns WHERE employee_id=? AND client_id IS NULL LIMIT 1', employeeId);
      return { clients, hasGeneral: !!general };
    };
    // The sheet asked for: "general", a client's id, or (nothing asked) the first one.
    const pickSheet = (tabs, asked) => {
      if (asked === 'general') return null;
      if (asked === undefined || asked === '') return tabs.clients[0]?.id ?? null;
      const id = int(asked, 'Sheet');
      if (!tabs.clients.some((c) => c.id === id)) throw bad('That is not one of your clients');
      return id;
    };

    m.get('/api/orders/me', { roles: self }, (ctx) => {
      const { from, to } = range(ctx.query);
      const tabs = sheetTabs(ctx.user.employeeId, ctx.user.departmentId);
      const clientId = pickSheet(tabs, ctx.query.client);
      const rows = sheetOf(ctx.user.employeeId, clientId, from, to);
      if (ctx.query.format === 'csv') return ctx.csv('my-daily-sheet.csv', csvColumns, [...rows].reverse().map((r, i) => ({ ...r, sr: i + 1 })));
      return {
        rows, totals: totals(rows), clientId, columns: sheetColumns(ctx.user.employeeId, clientId), clients: tabs.clients, hasGeneral: tabs.hasGeneral,
        totalRows: db.get('SELECT COUNT(*) AS n FROM member_orders WHERE employee_id=? AND client_id IS ?', ctx.user.employeeId, clientId).n, // the whole sheet, whatever dates are on screen
        fx: rates(), currencies: CURRENCIES, editDays: EDIT_DAYS, published: publicationsOf(ctx.user.employeeId),
      };
    });

    // "Update client": send the client a copy of this sheet as it is now.
    m.post('/api/orders/publish', { roles: self }, (ctx) => {
      const clientId = int(ctx.body.clientId, 'Client', { required: true });
      const client = myClients(ctx).find((c) => c.id === clientId);
      if (!client) throw bad('You can only update a client you work for');
      const { data, hash } = snapshotFor(ctx.user.employeeId, clientId);
      if (!data.rows.length) throw bad('Nothing to send: this sheet has no rows yet');
      const now = new Date().toISOString();
      const dates = data.rows.map((r) => r.date);
      const account = clientAccounts.ensure(clientId, ctx.user.employeeId); // "Account N" of this client's portal: the same one every time
      db.run(
        `INSERT INTO sheet_publications(client_id, employee_id, from_date, to_date, data, hash, row_count, published_at, account_no) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(client_id, employee_id) DO UPDATE SET from_date=excluded.from_date, to_date=excluded.to_date, data=excluded.data, hash=excluded.hash, row_count=excluded.row_count, published_at=excluded.published_at, account_no=COALESCE(sheet_publications.account_no, excluded.account_no)`,
        clientId, ctx.user.employeeId, dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b)), JSON.stringify(data), hash, data.rows.length, now, account);
      ctx.audit('sheet_published', 'orders', clientId, `${client.username}: ${data.rows.length} rows`); // never the figures
      notify.send({ clientId }, { title: 'Your sheet was updated', body: 'Open the Daily Sheet page of your portal.', link: '#/portal-sheet', kind: 'sheet' });
      return { clientId, username: client.username, account, publishedAt: now, rows: data.rows.length, upToDate: true };
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
      ctx.audit('orders_deleted', 'orders', o.id, `${o.date}: ${o.orders} qty`);
      return { ok: true };
    });

    // ---- the member's own columns (of one client's sheet) ----
    const columnInput = (b) => ({
      label: str(b.label, 'Column name', { required: true, max: 30 }),
      kind: oneOf(b.kind || 'text', 'Type', ['text', 'number']),
      clientVisible: b.clientVisible ? 1 : 0, // does the client see this column? (the permanent columns are always shown to the client)
    });
    const ownColumn = (ctx) => {
      const c = db.get('SELECT * FROM order_columns WHERE id=? AND employee_id=?', int(ctx.params.id, 'Column', { required: true }), ctx.user.employeeId);
      if (!c) throw new HttpError(404, 'Column not found');
      return c;
    };
    const sameLabel = (employeeId, clientId, label, exceptId) => db.get('SELECT 1 AS x FROM order_columns WHERE employee_id=? AND client_id IS ? AND lower(label)=lower(?) AND id<>?', employeeId, clientId ?? null, label, exceptId ?? 0);
    const RESERVED = ['sr#', 'sr', 'date', 'order id', 'customer details', 'qty', 'supplier order no', 'currency', 'you earned', 'ali exp price', 'net profit', 'roi %', 'roi', 'comments', 'refunds', 'note about orders',
      'market', 'store', 'store name', 'client', 'orders', 'orders received', 'purchasing cost', 'total sales', 'profit', 'notes', 'notes / activities'];

    m.post('/api/orders/columns', { roles: self }, (ctx) => {
      const c = columnInput(ctx.body);
      const clientId = sheetClient(ctx, ctx.body.clientId);
      if (RESERVED.includes(c.label.toLowerCase()) || sameLabel(ctx.user.employeeId, clientId, c.label)) throw bad('This sheet already has a column with that name');
      if (db.get('SELECT COUNT(*) AS n FROM order_columns WHERE employee_id=? AND client_id IS ?', ctx.user.employeeId, clientId).n >= MAX_COLUMNS) throw bad(`A sheet can have up to ${MAX_COLUMNS} columns of your own`);
      const pos = db.get('SELECT COALESCE(MAX(position),0)+1 AS p FROM order_columns WHERE employee_id=? AND client_id IS ?', ctx.user.employeeId, clientId).p;
      const r = db.insert('order_columns', { employeeId: ctx.user.employeeId, clientId, label: c.label, kind: c.kind, clientVisible: c.clientVisible, position: pos, createdAt: new Date().toISOString() });
      ctx.audit('orders_column_added', 'orders', r.id, `${c.label}${c.clientVisible ? ' (shown to the client)' : ''}`);
      return { id: r.id };
    });
    m.put('/api/orders/columns/:id', { roles: self }, (ctx) => {
      const col = ownColumn(ctx);
      const c = columnInput({ kind: col.kind, ...ctx.body }); // the type of a column with data cannot change
      if (RESERVED.includes(c.label.toLowerCase()) || sameLabel(ctx.user.employeeId, col.clientId, c.label, col.id)) throw bad('This sheet already has a column with that name');
      db.update('order_columns', col.id, { label: c.label, clientVisible: c.clientVisible });
      ctx.audit('orders_column_edited', 'orders', col.id, `${c.label}${c.clientVisible ? ' (shown to the client)' : ' (hidden from the client)'}`);
      return { ok: true };
    });
    m.del('/api/orders/columns/:id', { roles: self }, (ctx) => {
      const col = ownColumn(ctx);
      db.tx(() => {
        for (const r of db.all('SELECT id, extra FROM member_orders WHERE employee_id=? AND client_id IS ? AND extra IS NOT NULL', ctx.user.employeeId, col.clientId ?? null)) {
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
            AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR o.store LIKE ? OR o.market LIKE ? OR cl.username LIKE ? OR o.order_id LIKE ? OR o.customer LIKE ?)
          ORDER BY o.date DESC, e.name LIMIT 3000`,
        ctx.rolesCsv(), from, to, dept, dept, q.employeeId || null, q.employeeId || null, team, team, search, search, search, search, search, search, search, search).map(shape);
      if (q.format === 'csv') {
        return ctx.csv('member-orders.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' }, { label: 'Role', key: 'employeeRole' }, { label: 'Department', key: 'departmentName' },
          { label: 'Team', key: 'teamName' }, { label: 'Client', key: 'clientUsername' }, { label: 'Order Id', key: 'orderId' }, { label: 'Customer Details', key: 'customer' }, { label: 'Qty', key: 'orders' },
          { label: 'Supplier Order No', key: 'supplierOrderNo' }, { label: 'Currency', key: 'currency' }, { label: 'You Earned', key: 'revenue' }, { label: 'Ali Exp Price', key: 'investment' },
          { label: 'Net Profit', value: (r) => round(r.profit) }, { label: 'ROI %', key: 'roi' }, { label: 'Comments', key: 'comments' }, { label: 'Refunds', key: 'refunds' },
          { label: 'Note about orders', key: 'note' }, { label: 'Market', key: 'market' }, { label: 'Store', key: 'store' },
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

    // One person's sheets (their own columns too), for the people above them. Read only. ?client= picks a client's sheet or "general".
    m.get('/api/orders/sheet/:employeeId', { roles: lead }, (ctx) => {
      const emp = loadEmployee(int(ctx.params.employeeId, 'Person', { required: true }));
      if (!emp) throw new HttpError(404, 'Person not found');
      ctx.assertSee(emp);
      if (emp.role === 'hod') throw new HttpError(403, 'You cannot open this person');
      const { from, to } = range(ctx.query);
      const tabs = sheetTabs(emp.id, emp.departmentId);
      const counts = Object.fromEntries(db.all('SELECT client_id, COUNT(*) AS n FROM member_orders WHERE employee_id=? AND date BETWEEN ? AND ? GROUP BY client_id', emp.id, from, to).map((r) => [r.clientId ?? 'general', r.n]));
      // the sheet to open: the one asked for, else the first that has rows
      let clientId;
      if (ctx.query.client === undefined || ctx.query.client === '') clientId = tabs.clients.find((c) => counts[c.id])?.id ?? (counts.general ? null : tabs.clients[0]?.id ?? null);
      else clientId = pickSheet(tabs, ctx.query.client);
      const rows = sheetOf(emp.id, clientId, from, to);
      const team = emp.teamId ? db.get('SELECT name FROM teams WHERE id=?', emp.teamId)?.name : null;
      return {
        person: { id: emp.id, name: emp.name, empCode: emp.empCode, role: emp.role, teamName: team }, rows, totals: totals(rows), clientId, columns: sheetColumns(emp.id, clientId),
        sheets: [...tabs.clients.map((c) => ({ clientId: c.id, username: c.username, rows: counts[c.id] || 0 })), ...(tabs.hasGeneral ? [{ clientId: null, username: null, rows: counts.general || 0 }] : [])],
        fx: rates(), from, to, published: publicationsOf(emp.id),
      };
    });

    // ---- the client's view: the copies of the sheet the team sent, exactly as sent ----
    // One section per person who updated this client: "Account 1", "Account 2" ... The same number every time, never a name.
    m.get('/api/portal/sheet', { roles: ['client'] }, (ctx) => {
      const pubs = db.all('SELECT id, from_date, to_date, data, published_at, account_no FROM sheet_publications WHERE client_id=? ORDER BY COALESCE(account_no, 1e9), id', ctx.user.clientId);
      const sheets = pubs.map((p, i) => {
        const d = parseJson(p.data, { columns: [], rows: [] });
        const account = p.accountNo ?? i + 1;
        return { account, title: `Account ${account}`, publishedAt: p.publishedAt, from: p.fromDate, to: p.toDate, columns: d.columns, rows: d.rows, totals: totals(d.rows).byCurrency };
      });
      return { username: db.get('SELECT username FROM clients WHERE id=?', ctx.user.clientId)?.username ?? null, sheets };
    });
    // A tiny answer the page asks every few seconds: it loads the sheets only when this changes.
    m.get('/api/portal/sheet/stamp', { roles: ['client'] }, (ctx) => ({
      stamp: db.all('SELECT id, published_at FROM sheet_publications WHERE client_id=? ORDER BY id', ctx.user.clientId).map((p) => `${p.id}:${p.publishedAt}`).join('|'),
    }));
  },
};
