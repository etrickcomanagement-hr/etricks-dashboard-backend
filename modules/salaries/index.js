'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const { HttpError, int, str, num, oneOf, date, today, bad, round } = require('../../core/util');

/*
 * Salary payments. Everyone who works for eTricks is paid as a person (payee_type 'member' = an employee of any role):
 *   a team leader pays and tracks the members of their team,
 *   the head of department also tracks team leaders and members of the department,
 *   the admin tracks everybody, including the heads.
 * Every payment must be confirmed by the person it was paid to ("received" / "not received").
 */
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const thisMonth = () => today().slice(0, 7);
const period = (v) => {
  const p = str(v, 'Month', { required: true, max: 7 });
  if (!PERIOD.test(p)) throw bad('Month must look like 2026-10');
  return p;
};
const TYPE = 'member';

function payeeInfo(refId) {
  const e = db.get('SELECT e.id, e.name, e.emp_code, e.role, e.department_id, e.team_id, e.designation, d.name AS department_name FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=?', refId);
  return e && { type: TYPE, refId: e.id, name: e.name, code: e.empCode, role: e.role, departmentId: e.departmentId, teamId: e.teamId, departmentName: e.departmentName, designation: e.designation };
}

// Same rule as everywhere else: you manage the people below you.
function assertCanManage(ctx, payee) {
  const person = { id: payee.refId, role: payee.role, departmentId: payee.departmentId, teamId: payee.teamId };
  if (!ctx.canManage(person)) throw new HttpError(403, 'You cannot manage this salary');
}

const rateOf = (refId) => db.get('SELECT * FROM salary_rates WHERE payee_type=? AND ref_id=?', TYPE, refId);

function paymentsFor(recordIds) {
  if (!recordIds.length) return {};
  const rows = db.all(`SELECT * FROM salary_payments WHERE record_id IN (${recordIds.map(() => '?').join(',')}) ORDER BY paid_date DESC, id DESC`, ...recordIds);
  const by = {};
  for (const p of rows) (by[p.recordId] ||= []).push(p);
  return by;
}

function summarise(record, payments, rate) {
  const due = record ? record.amountDue : rate?.amount || 0;
  const paid = round(payments.reduce((s, p) => s + p.amount, 0));
  const status = due <= 0 ? 'no_salary' : paid >= due - 0.005 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  return {
    recordId: record?.id || null, due: round(due), paid, remaining: round(Math.max(0, due - paid)), status,
    lastPaidDate: payments.length ? payments[0].paidDate : null, payments,
    pending: payments.filter((p) => p.confirmStatus === 'pending').length,
    confirmed: payments.filter((p) => p.confirmStatus === 'confirmed').length,
    disputed: payments.filter((p) => p.confirmStatus === 'disputed').length,
  };
}

// Who is told when a payee confirms: the people above them (leader / head / admin).
const tellManagers = (payee, payload) => { for (const to of notify.superiorsOf(payee.refId)) notify.send(to, payload); };

function loadPayment(id) {
  const p = db.get(
    `SELECT p.*, r.payee_type, r.ref_id, r.department_id, r.period, r.amount_due FROM salary_payments p
       JOIN salary_records r ON r.id=p.record_id WHERE p.id=?`, id);
  if (!p) throw new HttpError(404, 'Payment not found');
  return p;
}

module.exports = {
  id: 'salaries',
  name: 'Salaries',
  description: 'Salary payments to members, team leaders and heads, confirmed by the person who was paid.',
  order: 66,

  migrations: [
    `CREATE TABLE salary_rates (
       payee_type TEXT NOT NULL, ref_id INTEGER NOT NULL, amount REAL NOT NULL DEFAULT 0, payee_name TEXT,
       updated_at TEXT NOT NULL, PRIMARY KEY (payee_type, ref_id));
     CREATE TABLE salary_records (
       id INTEGER PRIMARY KEY, payee_type TEXT NOT NULL, ref_id INTEGER NOT NULL, department_id INTEGER NOT NULL,
       period TEXT NOT NULL, amount_due REAL NOT NULL, created_at TEXT NOT NULL, UNIQUE (payee_type, ref_id, period));
     CREATE INDEX idx_salrec_period ON salary_records(period, department_id);
     CREATE TABLE salary_payments (
       id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES salary_records(id) ON DELETE CASCADE,
       amount REAL NOT NULL, paid_date TEXT NOT NULL, method TEXT, note TEXT,
       confirm_status TEXT NOT NULL DEFAULT 'pending', confirmed_at TEXT, confirm_note TEXT, paid_by TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_salpay_date ON salary_payments(paid_date);`,
    // 2: the old "department leader" salaries (they had no person behind them) are kept apart, nothing is deleted
    `UPDATE salary_rates SET payee_type='legacy_leader' WHERE payee_type='leader';
     UPDATE salary_records SET payee_type='legacy_leader' WHERE payee_type='leader';`,
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['hod', 'leader', 'member'];

    // ---- manage: the people below you ----
    m.get('/api/salaries', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const per = q.period ? period(q.period) : thisMonth();
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const search = q.search ? `%${q.search}%` : null;
      const role = oneOf(q.role, 'Role', ['member', 'team_leader', 'hod'], { def: null });

      const payees = db.all(
        `SELECT e.id, e.name, e.emp_code, e.designation, e.role, e.department_id, e.team_id, d.name AS department_name, t.name AS team_name
           FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN teams t ON t.id=e.team_id
          WHERE instr(?, ',' || e.role || ',') > 0
            AND (e.status='active' OR EXISTS (SELECT 1 FROM salary_records r WHERE r.payee_type='member' AND r.ref_id=e.id AND r.period=?))
            AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR e.role=?)
            AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ?)
          ORDER BY d.sort, CASE e.role WHEN 'hod' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END, t.name, e.name`,
        ctx.rolesCsv(), per, dept, dept, team, team, role, role, search, search, search)
        .map((e) => ({ type: TYPE, refId: e.id, name: e.name, code: e.empCode, designation: e.designation, role: e.role, departmentId: e.departmentId, departmentName: e.departmentName, teamId: e.teamId, teamName: e.teamName }));

      const records = Object.fromEntries(db.all('SELECT * FROM salary_records WHERE payee_type=? AND period=?', TYPE, per).map((r) => [r.refId, r]));
      const pays = paymentsFor(Object.values(records).map((r) => r.id));
      const rates = Object.fromEntries(db.all('SELECT * FROM salary_rates WHERE payee_type=?', TYPE).map((r) => [r.refId, r]));

      const rows = payees.map((p) => {
        const rec = records[p.refId];
        return { ...p, rate: rates[p.refId]?.amount || 0, ...summarise(rec, rec ? pays[rec.id] || [] : [], rates[p.refId]) };
      });
      if (q.format === 'csv') {
        return ctx.csv(`salaries-${per}.csv`, [
          { label: 'Month', value: () => per }, { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Role', key: 'role' },
          { label: 'Department', key: 'departmentName' }, { label: 'Team', key: 'teamName' },
          { label: 'Monthly salary', key: 'rate' }, { label: 'Due this month', key: 'due' }, { label: 'Paid', key: 'paid' }, { label: 'Remaining', key: 'remaining' },
          { label: 'Last paid on', key: 'lastPaidDate' }, { label: 'Status', key: 'status' },
          { label: 'Payments awaiting confirmation', key: 'pending' }, { label: 'Confirmed', key: 'confirmed' }, { label: 'Disputed', key: 'disputed' },
        ], rows);
      }
      const sum = (k) => round(rows.reduce((s, r) => s + r[k], 0));
      return {
        period: per, rows,
        totals: { due: sum('due'), paid: sum('paid'), remaining: sum('remaining'), awaitingConfirmation: sum('pending'), disputed: sum('disputed') },
      };
    });

    // Full payment history of one person (all months).
    m.get('/api/salaries/history', { roles: lead }, (ctx) => {
      const payee = payeeInfo(int(ctx.query.refId, 'Person', { required: true }));
      if (!payee) throw new HttpError(404, 'Person not found');
      assertCanManage(ctx, payee);
      const records = db.all('SELECT * FROM salary_records WHERE payee_type=? AND ref_id=? ORDER BY period DESC', TYPE, payee.refId);
      const pays = paymentsFor(records.map((r) => r.id));
      return { payee, rate: rateOf(payee.refId)?.amount || 0, records: records.map((r) => ({ period: r.period, ...summarise(r, pays[r.id] || [], null) })) };
    });

    m.put('/api/salaries/rate', { roles: lead }, (ctx) => {
      const payee = payeeInfo(int(ctx.body.refId, 'Person', { required: true }));
      if (!payee) throw new HttpError(404, 'Person not found');
      assertCanManage(ctx, payee);
      const amount = num(ctx.body.amount, 'Monthly salary', { required: true, min: 0, max: 1e9 });
      db.run(
        `INSERT INTO salary_rates(payee_type, ref_id, amount, payee_name, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(payee_type, ref_id) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`,
        TYPE, payee.refId, amount, null, new Date().toISOString());
      ctx.audit('salary_set', 'salary', payee.refId, `${payee.name}: monthly salary ${amount}`, payee.departmentId);
      return { ok: true };
    });

    // Records a payment (creating the month's salary record if needed).
    m.post('/api/salaries/payments', { roles: lead }, (ctx) => {
      const b = ctx.body;
      const payee = payeeInfo(int(b.refId, 'Person', { required: true }));
      if (!payee) throw new HttpError(404, 'Person not found');
      assertCanManage(ctx, payee);
      const per = period(b.period);
      if (per > thisMonth()) throw bad('You cannot pay a salary for a future month');
      const amount = num(b.amount, 'Amount paid', { required: true, min: 0.01, max: 1e9 });
      const paidDate = date(b.paidDate, 'Date paid', { required: true });
      if (paidDate > today()) throw bad('Date paid cannot be in the future');

      const id = db.tx(() => {
        let rec = db.get('SELECT * FROM salary_records WHERE payee_type=? AND ref_id=? AND period=?', TYPE, payee.refId, per);
        const wantedDue = num(b.salaryAmount, 'Salary for the month', { min: 0.01, max: 1e9 });
        const due = wantedDue ?? rec?.amountDue ?? rateOf(payee.refId)?.amount ?? 0;
        if (due <= 0) throw bad('Set a monthly salary first');
        const paidSoFar = rec ? db.get('SELECT COALESCE(SUM(amount),0) AS s FROM salary_payments WHERE record_id=?', rec.id).s : 0;
        if (paidSoFar + amount > due + 0.005) {
          throw bad(`This would make the total paid ${round(paidSoFar + amount)}, more than the salary of ${round(due)}. If it includes a bonus, raise "Salary for the month".`);
        }
        if (!rec) rec = { id: db.insert('salary_records', { payeeType: TYPE, refId: payee.refId, departmentId: payee.departmentId, period: per, amountDue: due, createdAt: new Date().toISOString() }).id };
        else if (wantedDue != null && wantedDue !== rec.amountDue) db.update('salary_records', rec.id, { amountDue: wantedDue });
        const now = new Date().toISOString();
        return db.insert('salary_payments', {
          recordId: rec.id, amount, paidDate, method: str(b.method, 'Payment method', { max: 40 }), note: str(b.note, 'Note', { max: 300 }),
          paidBy: ctx.user.label, createdAt: now, updatedAt: now,
        }).id;
      });
      ctx.audit('salary_paid', 'salary', id, `${payee.name}: ${amount} for ${per} on ${paidDate}`, payee.departmentId);
      notify.send({ employeeId: payee.refId }, { title: 'Salary payment recorded', body: `${amount} paid on ${paidDate} for ${per}. Please confirm that you received it.`, link: '#/my-salary', kind: 'salary' });
      return { id };
    });

    m.put('/api/salaries/payments/:id', { roles: lead }, (ctx) => {
      const p = loadPayment(int(ctx.params.id, 'Payment', { required: true }));
      const payee = payeeInfo(p.refId);
      assertCanManage(ctx, payee);
      if (p.confirmStatus === 'confirmed') throw bad('This payment is already confirmed by the person who received it, so it cannot be changed');
      const amount = num(ctx.body.amount, 'Amount paid', { required: true, min: 0.01, max: 1e9 });
      const paidDate = date(ctx.body.paidDate, 'Date paid', { required: true });
      if (paidDate > today()) throw bad('Date paid cannot be in the future');
      const others = db.get('SELECT COALESCE(SUM(amount),0) AS s FROM salary_payments WHERE record_id=? AND id<>?', p.recordId, p.id).s;
      if (others + amount > p.amountDue + 0.005) throw bad(`Total paid would exceed the month's salary of ${round(p.amountDue)}`);
      db.update('salary_payments', p.id, {
        amount, paidDate, method: str(ctx.body.method, 'Payment method', { max: 40 }), note: str(ctx.body.note, 'Note', { max: 300 }),
        confirmStatus: 'pending', confirmedAt: null, confirmNote: null, updatedAt: new Date().toISOString(),
      });
      ctx.audit('salary_payment_edited', 'salary', p.id, `${payee.name}: ${amount} for ${p.period}`, payee.departmentId);
      notify.send({ employeeId: payee.refId }, { title: 'A salary payment was corrected', body: `Now ${amount} paid on ${paidDate} for ${p.period}. Please confirm again.`, link: '#/my-salary', kind: 'salary' });
      return { ok: true };
    });

    m.del('/api/salaries/payments/:id', { roles: lead }, (ctx) => {
      const p = loadPayment(int(ctx.params.id, 'Payment', { required: true }));
      const payee = payeeInfo(p.refId);
      assertCanManage(ctx, payee);
      if (p.confirmStatus === 'confirmed') throw bad('Confirmed payments cannot be deleted');
      db.run('DELETE FROM salary_payments WHERE id=?', p.id);
      ctx.audit('salary_payment_deleted', 'salary', p.id, `${payee.name}: ${p.amount} for ${p.period}`, payee.departmentId);
      return { ok: true };
    });

    // ---- the person being paid: member, team leader or head sees and confirms their own salary ----
    m.get('/api/salaries/me', { roles: self }, (ctx) => {
      const payee = payeeInfo(ctx.user.employeeId);
      const records = db.all('SELECT * FROM salary_records WHERE payee_type=? AND ref_id=? ORDER BY period DESC LIMIT 24', TYPE, payee.refId);
      const pays = paymentsFor(records.map((r) => r.id));
      const months = records.map((r) => ({ period: r.period, ...summarise(r, pays[r.id] || [], null) }));
      return {
        payee: { name: payee.name, departmentName: payee.departmentName }, monthlySalary: rateOf(payee.refId)?.amount || 0, months,
        awaitingConfirmation: months.reduce((s, x) => s + x.pending, 0),
      };
    });

    m.post('/api/salaries/payments/:id/confirm', { roles: self }, (ctx) => {
      const p = loadPayment(int(ctx.params.id, 'Payment', { required: true }));
      const payee = payeeInfo(ctx.user.employeeId);
      if (p.payeeType !== TYPE || p.refId !== payee.refId) throw new HttpError(403, 'This payment was not made to you');
      if (p.confirmStatus === 'confirmed') throw bad('You already confirmed this payment');
      const status = oneOf(ctx.body.status, 'Answer', ['confirmed', 'disputed'], { required: true });
      const note = str(ctx.body.note, 'Note', { max: 300 });
      if (status === 'disputed' && !note) throw bad('Please tell us what is wrong (for example the amount you actually received)');
      db.update('salary_payments', p.id, { confirmStatus: status, confirmedAt: new Date().toISOString(), confirmNote: note, updatedAt: new Date().toISOString() });
      ctx.audit(status === 'confirmed' ? 'salary_confirmed' : 'salary_disputed', 'salary', p.id, `${payee.name}: ${p.amount} for ${p.period}${note ? ` - ${note}` : ''}`, payee.departmentId);
      tellManagers(payee, { title: status === 'confirmed' ? `${payee.name} confirmed their salary` : `${payee.name} says the salary was NOT received`, body: `${p.amount} for ${p.period}${note ? ` · ${note}` : ''}`, link: '#/salaries', kind: 'salary' });
      return { ok: true };
    });
  },
};
