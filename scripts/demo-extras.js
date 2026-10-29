'use strict';
// Sample orders reported by members, a few complaints and some notifications. Skips if already present.
function addDemoExtras() {
  const db = require('../core/db');
  const notify = require('../core/notify');
  const { today, addDays, eachDay, parseYmd } = require('../core/util');
  if (db.get('SELECT 1 AS x FROM member_orders LIMIT 1')) return console.log('Orders already present, skipped.');
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const now = new Date().toISOString();
  const days = eachDay(addDays(today(), -20), today()).filter((d) => parseYmd(d).getDay() !== 0);
  const emps = db.all("SELECT id, name, department_id FROM employees WHERE status='active' ORDER BY id");
  let orders = 0;
  db.tx(() => {
    for (const e of emps) {
      for (const d of days) {
        if (rnd() > 0.75) continue;
        const n = between(2, 14);
        db.insert('member_orders', {
          employeeId: e.id, departmentId: e.departmentId, date: d, store: `Store ${String.fromCharCode(65 + (e.id % 4))}`, orders: n,
          investment: n * between(8, 14), revenue: Math.round(n * between(20, 34)), createdAt: now, updatedAt: now,
        });
        orders++;
      }
    }
    const cats = ['Attendance / punctuality', 'Work quality', 'Missed deadline', 'Behaviour', 'Customer / buyer complaint'];
    [3, 9, 14, 21, 27].forEach((idx, i) => {
      const e = emps[idx % emps.length];
      const byAdmin = i % 3 === 2;
      const c = db.insert('complaints', {
        employeeId: e.id, departmentId: e.departmentId, filedByRole: byAdmin ? 'admin' : 'leader', filedBy: byAdmin ? 'Administrator' : 'Team Leader',
        category: cats[i % cats.length], severity: ['low', 'medium', 'high'][i % 3], status: i === 0 ? 'resolved' : i === 1 ? 'under_review' : 'open',
        description: ['Came late three days in a row', 'Listings had wrong prices', 'Buyer complained about a late reply', 'Task was not finished by the deadline', 'Raised voice in team chat'][i],
        incidentDate: addDays(today(), -(i * 3 + 1)), resolutionNote: i === 0 ? 'Spoke to the member, warning given' : null, createdAt: now, updatedAt: now,
      });
      notify.send({ role: 'member', employeeId: e.id }, { title: 'A complaint was filed about you', body: cats[i % cats.length], link: '#/my-complaints', kind: 'complaint' });
      void c;
    });
    for (const d of db.all('SELECT id FROM departments')) {
      notify.send({ role: 'leader', departmentId: d.id }, { title: 'Welcome to your notifications', body: 'Check-ins, leave requests and finished tasks will appear here.', link: '#/dashboard', kind: 'info' });
    }
    notify.send({ role: 'admin' }, { title: 'Welcome to your notifications', body: 'Complaints and salary confirmations will appear here.', link: '#/dashboard', kind: 'info' });
  });
  console.log(`Demo extras added: ${orders} order reports, 5 complaints, notifications.`);
}

module.exports = addDemoExtras;
if (require.main === module) {
  process.env.TZ = process.env.TZ || 'Asia/Karachi';
  require('../core/modules').loadAll();
  addDemoExtras();
}
