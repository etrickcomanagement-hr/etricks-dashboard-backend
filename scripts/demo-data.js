'use strict';
// Fills an EMPTY system with sample employees, attendance, tasks and finance so you can try every screen.
// Sample employees all use PIN 123456. Do not run this on your real data (it refuses if employees already exist).
process.env.TZ = process.env.TZ || 'Asia/Karachi';
const auth = require('../core/auth');
const db = require('../core/db');
const modules = require('../core/modules');
const { today, addDays, eachDay, parseYmd, toIso, pad } = require('../core/util');

modules.loadAll();
if (db.get('SELECT 1 AS x FROM employees LIMIT 1') && !process.argv.includes('--force')) {
  console.log('This system already has employees. Demo data was NOT added (use --force only on a throw-away database).');
  process.exit(0);
}

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const NAMES = ['Ahmed Khan', 'Fatima Noor', 'Bilal Hussain', 'Ayesha Malik', 'Hamza Ali', 'Sana Iqbal', 'Usman Tariq', 'Hira Shah', 'Zain Abbas', 'Maryam Aslam',
  'Danish Raza', 'Iqra Farooq', 'Talha Mehmood', 'Noor Fatima', 'Saad Ahmed', 'Areeba Khan', 'Faizan Butt', 'Laiba Zahid', 'Omar Siddiqui', 'Rabia Anwar',
  'Hassan Javed', 'Mahnoor Ali', 'Shahzaib Khan', 'Kinza Rauf', 'Adeel Yousaf', 'Zoya Hameed', 'Waqas Ahmad', 'Esha Tariq', 'Rizwan Haider', 'Amna Bashir',
  'Junaid Iqbal', 'Sidra Naeem', 'Abdullah Nadeem', 'Hania Sheikh', 'Moiz Qureshi', 'Alina Rehman', 'Kamran Latif', 'Samina Gul', 'Taha Zafar', 'Bushra Imran'];
const TITLES = ['Listing Specialist', 'Customer Support', 'Product Researcher', 'Account Manager', 'Order Processor', 'Ads Specialist'];
const TASKS = ['List 30 new products', 'Update pricing for top sellers', 'Reply to pending buyer messages', 'Research 20 winning products', 'Fix suspended listings', 'Prepare weekly sales report', 'Optimise titles and keywords', 'Process returns and refunds'];

const now = new Date().toISOString();
const shifts = db.all('SELECT * FROM shifts ORDER BY id');
const depts = db.all('SELECT * FROM departments ORDER BY sort');
const days = eachDay(addDays(today(), -24), today()).filter((d) => parseYmd(d).getDay() !== 0);
let nameIdx = 0;
let empNo = 0;

db.tx(() => {
  for (const dept of depts) {
    const teamIds = ['Alpha', 'Bravo'].map((n) => db.insert('teams', { departmentId: dept.id, name: `${dept.slug} ${n}`, createdAt: now }).id);
    const emps = [];
    const count = between(5, 7);
    for (let i = 0; i < count; i++) {
      empNo++;
      const name = NAMES[nameIdx++ % NAMES.length];
      const join = addDays(today(), -between(20, 400));
      const e = db.insert('employees', {
        empCode: `ETX-${String(empNo).padStart(4, '0')}`, name, email: `${name.toLowerCase().replace(/ /g, '.')}@example.com`, phone: `03${between(0, 4)}${between(1000000, 9999999)}`,
        designation: pick(TITLES), role: i < 2 ? 'team_leader' : 'member', status: 'active', joinDate: join, departmentId: dept.id, teamId: teamIds[i % 2],
        shiftId: shifts[0].id, pinHash: auth.hashSecret('123456'), custom: '{}', createdAt: now,
      });
      db.insert('employee_history', { employeeId: e.id, eventType: 'joined', eventDate: join, details: `Joined ${dept.name}`, recordedBy: 'Demo data', createdAt: now });
      emps.push({ id: e.id, name });
    }
    teamIds.forEach((tid, i) => db.update('teams', tid, { leaderEmployeeId: emps[i].id }));

    // attendance, breaks, work logs
    for (const emp of emps) {
      const reliability = 0.78 + rnd() * 0.2;
      for (const d of days) {
        if (rnd() > reliability) continue; // absent
        const late = rnd() < 0.15;
        const inMin = late ? between(15, 50) : between(0, 9);
        const ci = `09:${pad(inMin)}`;
        const isToday = d === today();
        const a = db.insert('attendance', {
          employeeId: emp.id, date: d, checkIn: toIso(d, ci), checkOut: isToday ? null : toIso(d, `${pad(between(17, 18))}:${pad(between(0, 59))}`),
          status: late ? 'late' : 'present', approval: isToday || rnd() < 0.08 ? 'pending' : 'approved',
          decidedBy: null, createdAt: now,
        });
        if (!isToday) {
          const start = new Date(toIso(d, `${between(13, 14)}:00`));
          db.insert('attendance_breaks', { attendanceId: a.id, startAt: start.toISOString(), endAt: new Date(start.getTime() + between(25, 75) * 60000).toISOString() });
          if (rnd() < 0.8) {
            db.insert('work_logs', {
              employeeId: emp.id, date: d, summary: pick(TASKS), hours: between(6, 8) + pick([0, 0.5]), units: between(10, 60),
              rating: rnd() < 0.7 ? between(3, 5) : null, reviewedBy: 'Demo data', createdAt: now,
            });
          }
        }
      }
      // tasks
      for (let t = 0; t < between(3, 6); t++) {
        const due = addDays(today(), between(-14, 10));
        const done = rnd() < (due < today() ? 0.8 : 0.3);
        db.insert('tasks', {
          departmentId: dept.id, title: pick(TASKS), assignedTo: emp.id, assignedBy: `Team Leader - ${dept.name}`, priority: pick(['low', 'medium', 'high', 'urgent']),
          status: done ? 'done' : pick(['todo', 'in_progress', 'blocked']), dueDate: due, completedAt: done ? toIso(addDays(due, rnd() < 0.8 ? -1 : 2), '15:00') : null,
          custom: '{}', createdAt: now, updatedAt: now,
        });
      }
      // a leave request
      if (rnd() < 0.5) {
        const from = addDays(today(), between(1, 14));
        db.insert('leave_requests', { employeeId: emp.id, leaveType: pick(['Casual', 'Sick', 'Annual']), fromDate: from, toDate: from, days: 1, reason: 'Personal work', status: pick(['pending', 'pending', 'approved']), createdAt: now });
      }
    }

    // daily finance
    const base = between(15, 45);
    for (const d of days) {
      const orders = Math.max(0, base + between(-10, 15));
      const investment = orders * between(8, 14);
      db.insert('finance_entries', {
        departmentId: dept.id, date: d, store: `${dept.slug} store`, orders, investment, revenue: Math.round(orders * between(22, 34)),
        expenses: Math.round(orders * between(2, 5)), custom: '{}', createdBy: 'Demo data', createdAt: now, updatedAt: now,
      });
    }
  }
});
console.log(`Demo data added: ${depts.length} departments, ${empNo} employees (PIN for every sample employee: 123456).`);
require('./demo-salaries')();
require('./demo-extras')();
