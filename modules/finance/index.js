'use strict';
const db = require('../../core/db');
const cf = require('../../core/customfields');
const { HttpError, int, str, num, date, range, today, bad, parseJson, round } = require('../../core/util');

const SELECT = `
  SELECT f.*, d.name AS department_name,
         (f.revenue - f.investment - f.expenses) AS profit
    FROM finance_entries f JOIN departments d ON d.id=f.department_id`;

const shape = (r) => ({ ...r, custom: parseJson(r.custom, {}) });

// Profit = sales revenue - investment (stock / ad spend) - other expenses (fees, shipping ...)
const totals = (rows) => {
  const t = { orders: 0, investment: 0, revenue: 0, expenses: 0 };
  for (const r of rows) { t.orders += r.orders; t.investment += r.investment; t.revenue += r.revenue; t.expenses += r.expenses; }
  const profit = t.revenue - t.investment - t.expenses;
  const cost = t.investment + t.expenses;
  return {
    ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v)])),
    profit: round(profit),
    roi: cost > 0 ? round((profit / cost) * 100, 1) : null,
    margin: t.revenue > 0 ? round((profit / t.revenue) * 100, 1) : null,
  };
};

module.exports = {
  id: 'finance',
  name: 'Finance (Investment & Profit)',
  description: 'Per-department orders, investment, sales and profit tracking.',
  order: 60,
  totals,

  migrations: [
    `CREATE TABLE finance_entries (
       id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id), date TEXT NOT NULL, store TEXT,
       orders INTEGER NOT NULL DEFAULT 0, investment REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0,
       expenses REAL NOT NULL DEFAULT 0, note TEXT, custom TEXT DEFAULT '{}', created_by TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_fin_dept ON finance_entries(department_id, date);`,
  ],

  routes(m) {
    const lead = ['admin', 'leader'];

    const input = (ctx, existing) => {
      const b = ctx.body;
      const departmentId = existing ? existing.departmentId : ctx.scopeDept(b.departmentId);
      if (!departmentId) throw bad('Department is required');
      ctx.assertDept(departmentId);
      const day = date(b.date, 'Date', { required: true });
      if (day > today()) throw bad('Date cannot be in the future');
      return {
        departmentId, date: day, store: str(b.store, 'Store / account', { max: 100 }),
        orders: int(b.orders ?? 0, 'Orders', { min: 0, max: 1e7 }), investment: num(b.investment ?? 0, 'Investment', { min: 0 }),
        revenue: num(b.revenue ?? 0, 'Sales', { min: 0 }), expenses: num(b.expenses ?? 0, 'Expenses', { min: 0 }),
        note: str(b.note, 'Note', { max: 300 }), custom: JSON.stringify(cf.sanitize('finance', b.custom, existing ? parseJson(existing.custom, {}) : {})),
      };
    };

    m.get('/api/finance', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const { from, to } = range(q);
      const rows = db.all(
        `${SELECT} WHERE f.date BETWEEN ? AND ? AND (? IS NULL OR f.department_id=?) AND (? IS NULL OR f.store LIKE ? OR f.note LIKE ?)
          ORDER BY f.date DESC, f.id DESC LIMIT 3000`,
        from, to, dept, dept, q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`).map(shape);
      if (q.format === 'csv') {
        return ctx.csv('finance.csv', [
          { label: 'Date', key: 'date' }, { label: 'Department', key: 'departmentName' }, { label: 'Store', key: 'store' },
          { label: 'Orders', key: 'orders' }, { label: 'Investment', key: 'investment' }, { label: 'Sales', key: 'revenue' },
          { label: 'Expenses', key: 'expenses' }, { label: 'Profit', value: (r) => round(r.profit) }, { label: 'Note', key: 'note' },
          ...cf.definitions('finance').map((d) => ({ label: d.label, value: (r) => r.custom[d.key] })),
        ], rows);
      }
      return { rows, totals: totals(rows) };
    });

    m.get('/api/finance/summary', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const { from, to } = range(q);
      const rows = db.all('SELECT * FROM finance_entries WHERE date BETWEEN ? AND ? AND (? IS NULL OR department_id=?)', from, to, dept, dept);
      const group = (keyFn) => {
        const g = {};
        for (const r of rows) (g[keyFn(r)] ||= []).push(r);
        return g;
      };
      const names = Object.fromEntries(db.all('SELECT id, name, color FROM departments').map((d) => [d.id, d]));
      return {
        from, to, totals: totals(rows),
        byDepartment: Object.entries(group((r) => r.departmentId)).map(([id, rs]) => ({ departmentId: Number(id), name: names[id]?.name, color: names[id]?.color, ...totals(rs) })),
        byMonth: Object.entries(group((r) => r.date.slice(0, 7))).sort().map(([month, rs]) => ({ month, ...totals(rs) })),
      };
    });

    m.post('/api/finance', { roles: lead }, (ctx) => {
      const e = input(ctx, null);
      const now = new Date().toISOString();
      const r = db.insert('finance_entries', { ...e, createdBy: ctx.user.label, createdAt: now, updatedAt: now });
      ctx.audit('create', 'finance', r.id, `${e.date}: ${e.orders} orders, sales ${e.revenue}, invest ${e.investment}`, e.departmentId);
      return { id: r.id };
    });

    m.put('/api/finance/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Entry', { required: true });
      const old = db.get('SELECT * FROM finance_entries WHERE id=?', id);
      if (!old) throw new HttpError(404, 'Entry not found');
      ctx.assertDept(old.departmentId);
      const e = input(ctx, old);
      db.update('finance_entries', id, { ...e, updatedAt: new Date().toISOString() });
      ctx.audit('update', 'finance', id, `${e.date}: ${e.orders} orders, sales ${e.revenue}, invest ${e.investment}`, e.departmentId);
      return { ok: true };
    });

    m.del('/api/finance/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Entry', { required: true });
      const old = db.get('SELECT * FROM finance_entries WHERE id=?', id);
      if (!old) throw new HttpError(404, 'Entry not found');
      ctx.assertDept(old.departmentId);
      db.run('DELETE FROM finance_entries WHERE id=?', id);
      ctx.audit('delete', 'finance', id, `${old.date}: sales ${old.revenue}, invest ${old.investment}`, old.departmentId);
      return { ok: true };
    });
  },
};
