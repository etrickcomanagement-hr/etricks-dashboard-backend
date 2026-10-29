'use strict';
// Sample salaries: a monthly salary for every sample employee and team leader, last month fully paid
// (mostly confirmed) and this month part-paid. Safe to run twice; it skips if salaries already exist.
function addDemoSalaries() {
  const db = require('../core/db');
  const { today, addDays } = require('../core/util');
  if (db.get('SELECT 1 AS x FROM salary_rates LIMIT 1')) return console.log('Salaries already present, skipped.');
  const now = new Date().toISOString();
  const thisMonth = today().slice(0, 7);
  const prev = addDays(thisMonth + '-01', -1);
  const lastMonth = prev.slice(0, 7);
  const pay = (recordId, amount, paidDate, method, confirm) => db.insert('salary_payments', {
    recordId, amount, paidDate, method, paidBy: 'Demo data', createdAt: now, updatedAt: now,
    confirmStatus: confirm, confirmedAt: confirm === 'pending' ? null : now, confirmNote: confirm === 'disputed' ? 'Received less than the amount shown' : null,
  });
  const lastPaid = thisMonth + '-03' <= today() ? thisMonth + '-03' : lastMonth + '-28';
  let n = 0;
  db.tx(() => {
    const people = [
      ...db.all("SELECT id, department_id FROM employees WHERE status='active'").map((e) => ({ type: 'member', refId: e.id, departmentId: e.departmentId, salary: 300 + (e.id % 7) * 40 })),
      ...db.all('SELECT id FROM departments').map((d) => ({ type: 'leader', refId: d.id, departmentId: d.id, salary: 1200 })),
    ];
    for (const p of people) {
      db.run('INSERT INTO salary_rates(payee_type, ref_id, amount, payee_name, updated_at) VALUES (?,?,?,?,?)', p.type, p.refId, p.salary, p.type === 'leader' ? `Team Leader ${p.refId}` : null, now);
      const last = db.insert('salary_records', { payeeType: p.type, refId: p.refId, departmentId: p.departmentId, period: lastMonth, amountDue: p.salary, createdAt: now });
      pay(last.id, p.salary, lastPaid, 'Bank transfer', n % 11 === 0 ? 'disputed' : n % 5 === 0 ? 'pending' : 'confirmed');
      if (n % 3 !== 2) {
        const cur = db.insert('salary_records', { payeeType: p.type, refId: p.refId, departmentId: p.departmentId, period: thisMonth, amountDue: p.salary, createdAt: now });
        pay(cur.id, Math.round(p.salary / 2), addDays(today(), -1), n % 2 ? 'Cash' : 'JazzCash / Easypaisa', 'pending');
      }
      n++;
    }
  });
  console.log(`Sample salaries added for ${n} people (${lastMonth} paid, ${thisMonth} part-paid).`);
}

module.exports = addDemoSalaries;
if (require.main === module) {
  process.env.TZ = process.env.TZ || 'Asia/Karachi';
  require('../core/modules').loadAll();
  addDemoSalaries();
}
