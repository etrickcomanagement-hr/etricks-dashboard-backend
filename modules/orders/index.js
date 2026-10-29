'use strict';
const db = require('../../core/db');
const { HttpError, int, str, num, date, range, today, addDays, bad, round } = require('../../core/util');

/*
 * Orders reported by each team member (orders received, money invested, sales made).
 * Team leaders see their department, the admin sees everyone. These figures are the members' own
 * daily reports; they are NOT added to the department Finance page automatically (avoids double counting).
 */
const SELECT = `
  SELECT o.*, (o.revenue - o.investment) AS profit, e.name AS employee_name, e.emp_code, e.team_id,
         d.name AS department_name, t.name AS team_name
    FROM member_orders o
    JOIN employees e ON e.id=o.employee_id
    JOIN departments d ON d.id=o.department_id
    LEFT JOIN teams t ON t.id=e.team_id`;

const totals = (rows) => {
  const t = { orders: 0, investment: 0, revenue: 0 };
  for (const r of rows) { t.orders += r.orders; t.investment += r.investment; t.revenue += r.revenue; }
  return { orders: t.orders, investment: round(t.investment), revenue: round(t.revenue), profit: round(t.revenue - t.investment), entries: rows.length };
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
  ],

  routes(m) {
    const lead = ['admin', 'leader'];

    const input = (b) => {
      const day = date(b.date, 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      if (day < addDays(today(), -31)) throw bad('You can only report orders from the last 31 days');
      const e = {
        date: day, store: str(b.store, 'Store / account', { max: 100 }), orders: int(b.orders ?? 0, 'Orders', { min: 0, max: 1e6 }),
        investment: num(b.investment ?? 0, 'Investment', { min: 0, max: 1e9 }), revenue: num(b.revenue ?? 0, 'Sales', { min: 0, max: 1e9 }),
        note: str(b.note, 'Note', { max: 300 }),
      };
      if (!e.orders && !e.investment && !e.revenue) throw bad('Enter at least orders, investment or sales');
      return e;
    };

    // ---- member ----
    m.get('/api/orders/me', { roles: ['member'] }, (ctx) => {
      const { from, to } = range(ctx.query);
      const rows = db.all(`${SELECT} WHERE o.employee_id=? AND o.date BETWEEN ? AND ? ORDER BY o.date DESC, o.id DESC`, ctx.user.employeeId, from, to);
      return { rows, totals: totals(rows) };
    });

    m.post('/api/orders', { roles: ['member'] }, (ctx) => {
      const e = input(ctx.body);
      const now = new Date().toISOString();
      const r = db.insert('member_orders', { ...e, employeeId: ctx.user.employeeId, departmentId: ctx.user.departmentId, createdAt: now, updatedAt: now });
      ctx.audit('orders_reported', 'orders', r.id, `${e.date}: ${e.orders} orders, sales ${e.revenue}, investment ${e.investment}`);
      return { id: r.id };
    });

    const own = (ctx) => {
      const o = db.get('SELECT * FROM member_orders WHERE id=? AND employee_id=?', int(ctx.params.id, 'Entry', { required: true }), ctx.user.employeeId);
      if (!o) throw new HttpError(404, 'Entry not found');
      if (o.date < addDays(today(), -7)) throw bad('Entries older than 7 days can no longer be changed. Please ask your team leader.');
      return o;
    };
    m.put('/api/orders/:id', { roles: ['member'] }, (ctx) => {
      const o = own(ctx);
      const e = input(ctx.body);
      db.update('member_orders', o.id, { ...e, updatedAt: new Date().toISOString() });
      ctx.audit('orders_edited', 'orders', o.id, `${e.date}: ${e.orders} orders, sales ${e.revenue}, investment ${e.investment}`);
      return { ok: true };
    });
    m.del('/api/orders/:id', { roles: ['member'] }, (ctx) => {
      const o = own(ctx);
      db.run('DELETE FROM member_orders WHERE id=?', o.id);
      ctx.audit('orders_deleted', 'orders', o.id, `${o.date}: ${o.orders} orders`);
      return { ok: true };
    });

    // ---- leader / admin ----
    m.get('/api/orders', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const { from, to } = range(q);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${SELECT} WHERE o.date BETWEEN ? AND ? AND (? IS NULL OR o.department_id=?) AND (? IS NULL OR o.employee_id=?)
            AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR o.store LIKE ?)
          ORDER BY o.date DESC, e.name LIMIT 3000`,
        from, to, dept, dept, q.employeeId || null, q.employeeId || null, q.teamId || null, q.teamId || null, search, search, search, search);
      if (q.format === 'csv') {
        return ctx.csv('member-orders.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' }, { label: 'Department', key: 'departmentName' },
          { label: 'Team', key: 'teamName' }, { label: 'Store', key: 'store' }, { label: 'Orders', key: 'orders' }, { label: 'Investment', key: 'investment' },
          { label: 'Sales', key: 'revenue' }, { label: 'Profit', value: (r) => round(r.profit) }, { label: 'Note', key: 'note' },
        ], rows);
      }
      const by = {};
      for (const r of rows) (by[r.employeeId] ||= { employeeId: r.employeeId, name: r.employeeName, empCode: r.empCode, departmentName: r.departmentName, rows: [] }).rows.push(r);
      const byEmployee = Object.values(by).map((g) => ({ employeeId: g.employeeId, name: g.name, empCode: g.empCode, departmentName: g.departmentName, ...totals(g.rows) }))
        .sort((a, b) => b.revenue - a.revenue);
      return { rows, totals: totals(rows), byEmployee };
    });
  },
};
