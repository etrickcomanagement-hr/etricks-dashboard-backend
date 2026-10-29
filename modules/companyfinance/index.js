'use strict';
const db = require('../../core/db');
const settings = require('../../core/settings');
const { HttpError, int, str, num, oneOf, date, range, today, bad, round } = require('../../core/util');

/*
 * Company-wide money view (admin only).
 *   Revenue            = sales of every department (finance entries)
 *   Total spend (paid) = department investment + department other expenses + company bills marked paid + salaries paid
 *   Net profit         = revenue - total spend
 * Unpaid bills are shown separately as "still to pay" and are not deducted until marked paid.
 */
const margin = (profit, revenue) => (revenue > 0 ? round((profit / revenue) * 100, 1) : null);

function summary(from, to) {
  const dept = db.all(
    `SELECT d.id, d.name, d.color, COALESCE(SUM(f.orders),0) AS orders, COALESCE(SUM(f.investment),0) AS investment,
            COALESCE(SUM(f.revenue),0) AS revenue, COALESCE(SUM(f.expenses),0) AS expenses
       FROM departments d LEFT JOIN finance_entries f ON f.department_id=d.id AND f.date BETWEEN ? AND ?
      GROUP BY d.id ORDER BY d.sort, d.name`, from, to)
    .map((d) => ({ ...d, profit: round(d.revenue - d.investment - d.expenses) }));
  const bills = db.all('SELECT category, status, SUM(amount) AS amount, COUNT(*) AS n FROM company_expenses WHERE date BETWEEN ? AND ? GROUP BY category, status', from, to);

  const sum = (k) => dept.reduce((s, d) => s + d[k], 0);
  const paid = bills.filter((b) => b.status === 'paid');
  const unpaid = bills.filter((b) => b.status === 'unpaid');
  const t = {
    orders: sum('orders'), revenue: round(sum('revenue')), deptInvestment: round(sum('investment')), deptExpenses: round(sum('expenses')),
    billsPaid: round(paid.reduce((s, b) => s + b.amount, 0)), billsUnpaid: round(unpaid.reduce((s, b) => s + b.amount, 0)),
    unpaidCount: unpaid.reduce((s, b) => s + b.n, 0),
  };
  t.salariesPaid = round(db.get('SELECT COALESCE(SUM(amount),0) AS s FROM salary_payments WHERE paid_date BETWEEN ? AND ?', from, to).s);
  t.totalSpend = round(t.deptInvestment + t.deptExpenses + t.billsPaid + t.salariesPaid);
  t.netProfit = round(t.revenue - t.totalSpend);
  t.margin = margin(t.netProfit, t.revenue);
  t.roi = t.totalSpend > 0 ? round((t.netProfit / t.totalSpend) * 100, 1) : null;
  t.profitAfterUnpaid = round(t.netProfit - t.billsUnpaid);

  // "Where the money goes": every cost line, largest first, with its share of total spend.
  const lines = [
    { label: 'Department investment (stock / ads)', group: 'Departments', amount: t.deptInvestment },
    { label: 'Department other expenses (fees, shipping)', group: 'Departments', amount: t.deptExpenses },
    { label: 'Salaries paid (team members + leaders)', group: 'Salaries', amount: t.salariesPaid },
    ...Object.entries(paid.reduce((m, b) => ((m[b.category] = (m[b.category] || 0) + b.amount), m), {})).map(([label, amount]) => ({ label, group: 'Company bills', amount: round(amount) })),
  ].filter((l) => l.amount > 0).sort((a, b) => b.amount - a.amount)
    .map((l) => ({ ...l, share: t.totalSpend > 0 ? round((l.amount / t.totalSpend) * 100, 1) : 0 }));

  // Month by month
  const months = {};
  const m = (k) => (months[k] ||= { month: k, revenue: 0, deptCost: 0, bills: 0, salaries: 0 });
  for (const r of db.all("SELECT substr(date,1,7) AS month, SUM(revenue) AS revenue, SUM(investment + expenses) AS cost FROM finance_entries WHERE date BETWEEN ? AND ? GROUP BY 1", from, to)) {
    m(r.month).revenue = r.revenue; m(r.month).deptCost = r.cost;
  }
  for (const r of db.all("SELECT substr(date,1,7) AS month, SUM(amount) AS amount FROM company_expenses WHERE status='paid' AND date BETWEEN ? AND ? GROUP BY 1", from, to)) m(r.month).bills = r.amount;
  for (const r of db.all('SELECT substr(paid_date,1,7) AS month, SUM(amount) AS amount FROM salary_payments WHERE paid_date BETWEEN ? AND ? GROUP BY 1', from, to)) m(r.month).salaries = r.amount;
  const byMonth = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({
    ...x, revenue: round(x.revenue), deptCost: round(x.deptCost), bills: round(x.bills), salaries: round(x.salaries), net: round(x.revenue - x.deptCost - x.bills - x.salaries),
  }));

  return { from, to, totals: t, lines, byDepartment: dept, byMonth };
}

const SELECT = 'SELECT * FROM company_expenses';

module.exports = {
  id: 'companyfinance',
  name: 'Company Finance & Bills',
  description: 'Utility bills and company expenses combined with all department finance into overall profit.',
  order: 65,

  migrations: [
    `CREATE TABLE company_expenses (
       id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, description TEXT, vendor TEXT,
       amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'paid', paid_date TEXT, reference TEXT,
       created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_cexp_date ON company_expenses(date);`,
  ],

  routes(m) {
    const admin = ['admin'];

    m.get('/api/company-finance/summary', { roles: admin }, (ctx) => {
      const { from, to } = range(ctx.query);
      return summary(from, to);
    });

    m.get('/api/company-expenses', { roles: admin }, (ctx) => {
      const q = ctx.query;
      const { from, to } = range(q);
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${SELECT} WHERE date BETWEEN ? AND ? AND (? IS NULL OR category=?) AND (? IS NULL OR status=?)
            AND (? IS NULL OR description LIKE ? OR vendor LIKE ? OR reference LIKE ?)
          ORDER BY date DESC, id DESC LIMIT 3000`,
        from, to, q.category || null, q.category || null, q.status || null, q.status || null, search, search, search, search);
      if (q.format === 'csv') {
        return ctx.csv('company-bills.csv', [
          { label: 'Bill date', key: 'date' }, { label: 'Category', key: 'category' }, { label: 'Description', key: 'description' },
          { label: 'Vendor', key: 'vendor' }, { label: 'Reference', key: 'reference' }, { label: 'Amount', key: 'amount' },
          { label: 'Status', key: 'status' }, { label: 'Paid on', key: 'paidDate' },
        ], rows);
      }
      const sum = (st) => round(rows.filter((r) => r.status === st).reduce((s, r) => s + r.amount, 0));
      return { rows, totals: { paid: sum('paid'), unpaid: sum('unpaid'), count: rows.length } };
    });

    const input = (b, existing) => {
      const status = oneOf(b.status, 'Status', ['paid', 'unpaid'], { def: 'paid' });
      const day = date(b.date, 'Bill date', { required: true });
      return {
        date: day, category: oneOf(b.category, 'Category', settings.get('expenseCategories'), { required: true }),
        description: str(b.description, 'Description', { max: 200 }), vendor: str(b.vendor, 'Vendor', { max: 100 }),
        reference: str(b.reference, 'Bill / reference number', { max: 60 }),
        amount: num(b.amount, 'Amount', { required: true, min: 0.01, max: 1e10 }),
        status, paidDate: status === 'paid' ? date(b.paidDate, 'Paid date') || day : null,
      };
    };

    m.post('/api/company-expenses', { roles: admin }, (ctx) => {
      const e = input(ctx.body);
      const now = new Date().toISOString();
      const r = db.insert('company_expenses', { ...e, createdBy: ctx.user.label, createdAt: now, updatedAt: now });
      ctx.audit('create', 'company_bill', r.id, `${e.category} ${e.amount} (${e.status})`, null);
      return { id: r.id };
    });

    m.put('/api/company-expenses/:id', { roles: admin }, (ctx) => {
      const id = int(ctx.params.id, 'Bill', { required: true });
      if (!db.get('SELECT 1 AS x FROM company_expenses WHERE id=?', id)) throw new HttpError(404, 'Bill not found');
      const e = input(ctx.body);
      db.update('company_expenses', id, { ...e, updatedAt: new Date().toISOString() });
      ctx.audit('update', 'company_bill', id, `${e.category} ${e.amount} (${e.status})`, null);
      return { ok: true };
    });

    m.post('/api/company-expenses/:id/pay', { roles: admin }, (ctx) => {
      const id = int(ctx.params.id, 'Bill', { required: true });
      const bill = db.get('SELECT * FROM company_expenses WHERE id=?', id);
      if (!bill) throw new HttpError(404, 'Bill not found');
      if (bill.status === 'paid') throw bad('This bill is already marked paid');
      db.update('company_expenses', id, { status: 'paid', paidDate: date(ctx.body.paidDate, 'Paid date') || today(), updatedAt: new Date().toISOString() });
      ctx.audit('bill_paid', 'company_bill', id, `${bill.category} ${bill.amount}`, null);
      return { ok: true };
    });

    m.del('/api/company-expenses/:id', { roles: admin }, (ctx) => {
      const id = int(ctx.params.id, 'Bill', { required: true });
      const bill = db.get('SELECT * FROM company_expenses WHERE id=?', id);
      if (!bill) throw new HttpError(404, 'Bill not found');
      db.run('DELETE FROM company_expenses WHERE id=?', id);
      ctx.audit('delete', 'company_bill', id, `${bill.category} ${bill.amount}`, null);
      return { ok: true };
    });
  },
};
