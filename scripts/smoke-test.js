'use strict';
// End-to-end API check against a throw-away database. Run: npm test
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');
const PORT = 3999;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const offset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; };
const D = (d, n = 0) => { const x = new Date(d); x.setDate(x.getDate() + n); return ymd(x); };
const MON = nextMonday(), YESTERDAY = ymd(offset(-1)), TODAY = ymd(new Date()), TWO_AGO = ymd(offset(-2));
// these date helpers keep the test valid on any day (weekly off = Sunday)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'etx-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Etricks': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

async function main() {
  const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('running') && resolve()));

  try {
    const creds = fs.readFileSync(path.join(DATA, 'initial-credentials.txt'), 'utf8');
    const adminPw = creds.match(/ADMIN PORTAL password : (\S+)/)[1];
    const ebay = creds.match(/eBay Department\s+leader password: (\S+)\s+member password: (\S+)/);
    const amazon = creds.match(/Amazon Department\s+leader password: (\S+)/);

    console.log('Sign-in');
    const anon = client();
    check('public department list', (await anon('GET', '/api/public/departments')).data.length === 6);
    check('API blocks anonymous', (await anon('GET', '/api/employees')).status === 401);
    check('wrong admin password rejected', (await anon('POST', '/api/auth/login', { portal: 'admin', password: 'wrongwrong' })).status === 401);
    check('mutations need the request header', (await fetch(BASE + '/api/auth/login', { method: 'POST', body: '{}' })).status === 403);

    const admin = client();
    check('admin login', (await admin('POST', '/api/auth/login', { portal: 'admin', password: adminPw })).status === 200);
    const depts = (await admin('GET', '/api/departments')).data;
    const ebayId = depts.find((d) => d.slug === 'ebay').id;
    const amazonId = depts.find((d) => d.slug === 'amazon').id;

    const leader = client();
    check('leader login', (await leader('POST', '/api/auth/login', { portal: 'leader', departmentId: ebayId, password: ebay[1] })).status === 200);
    check('leader cannot use member password', (await client()('POST', '/api/auth/login', { portal: 'leader', departmentId: ebayId, password: ebay[2] })).status === 401);
    const leaderAmazon = client();
    await leaderAmazon('POST', '/api/auth/login', { portal: 'leader', departmentId: amazonId, password: amazon[1] });

    console.log('Employees');
    const shift = (await leader('GET', '/api/shifts')).data[0];
    const created = await leader('POST', '/api/employees', { name: 'Ali Raza', designation: 'Listing Specialist', joinDate: '2026-09-01', shiftId: shift.id, departmentId: amazonId, phone: '0300-1234567' });
    check('leader creates employee (PIN returned once)', created.status === 200 && /^\d{6}$/.test(created.data.pin), JSON.stringify(created.data));
    const empId = created.data.id;
    const prof = (await leader('GET', `/api/employees/${empId}`)).data;
    check('leader cannot place employee in another department', prof.departmentId === ebayId);
    check('joining history recorded', prof.history.length === 1 && prof.history[0].eventType === 'joined');
    check('leader of another department blocked', (await leaderAmazon('GET', `/api/employees/${empId}`)).status === 403);
    await leader('PUT', `/api/employees/${empId}`, { ...prof, designation: 'Senior Listing Specialist' });
    check('designation change adds history', (await leader('GET', `/api/employees/${empId}`)).data.history.length === 2);
    const csv = await leader('GET', '/api/employees?format=csv');
    check('employee CSV export', typeof csv.data === 'string' && csv.data.includes('Ali Raza'));
    check('employee search', (await leader('GET', '/api/employees?search=Listing')).data.length === 1);

    console.log('Team & custom field');
    const team = await leader('POST', '/api/teams', { name: 'Listing Team', leaderEmployeeId: empId });
    check('team with leader', team.status === 200);
    check('custom fields admin only', (await leader('POST', '/api/custom-fields', { entity: 'employee', label: 'X', type: 'text' })).status === 403);
    await admin('POST', '/api/custom-fields', { entity: 'employee', label: 'Blood Group', type: 'select', options: 'A+,B+,O+' });
    check('custom field saved on employee', (await leader('PUT', `/api/employees/${empId}`, { ...prof, teamId: team.data.id, custom: { blood_group: 'O+' } })).status === 200
      && (await leader('GET', `/api/employees/${empId}`)).data.custom.blood_group === 'O+');
    check('invalid custom choice rejected', (await leader('PUT', `/api/employees/${empId}`, { ...prof, custom: { blood_group: 'ZZ' } })).status === 400);

    console.log('Member portal');
    const member = client();
    const names = await anon('POST', '/api/auth/members', { departmentId: ebayId, password: ebay[2] });
    check('member password lists names', names.status === 200 && names.data.some((n) => n.id === empId));
    check('wrong PIN rejected', (await member('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: ebay[2], employeeId: empId, pin: '000000' })).status === 401);
    check('member login', (await member('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: ebay[2], employeeId: empId, pin: created.data.pin })).status === 200);
    check('member blocked from finance', (await member('GET', '/api/finance')).status === 403);
    check('member blocked from employee list', (await member('GET', '/api/employees')).status === 403);

    console.log('Attendance');
    check('check in', (await member('POST', '/api/attendance/me/action', { action: 'check_in' })).data.state === 'working');
    check('double check-in refused', (await member('POST', '/api/attendance/me/action', { action: 'check_in' })).status === 400);
    check('break start', (await member('POST', '/api/attendance/me/action', { action: 'break_start' })).data.state === 'on_break');
    check('break end', (await member('POST', '/api/attendance/me/action', { action: 'break_end' })).data.state === 'working');
    check('check out', (await member('POST', '/api/attendance/me/action', { action: 'check_out' })).data.state === 'done');
    const board = (await leader('GET', '/api/attendance/board')).data;
    check('leader board shows present member', board.summary.present === 1 && board.summary.pendingApproval === 1);
    const rec = board.rows.find((r) => r.id === empId).record;
    check('leader approves attendance', (await leader('POST', `/api/attendance/${rec.id}/decision`, { approval: 'approved' })).status === 200);
    check('other department cannot approve', (await leaderAmazon('POST', `/api/attendance/${rec.id}/decision`, { approval: 'rejected' })).status === 403);
    check('manual absent for past day', (await leader('POST', '/api/attendance/manual', { employeeId: empId, date: TWO_AGO, status: 'absent', note: 'No call' })).status === 200);

    console.log('Leave');
    const lv = await member('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON), toDate: D(MON, 2), reason: 'Family event' });
    check('leave request (3 working days)', lv.status === 200 && lv.data.days === 3, JSON.stringify(lv.data));
    check('overlapping leave refused', (await member('POST', '/api/leave', { leaveType: 'Sick', fromDate: D(MON, 1), toDate: D(MON, 1), reason: 'x' })).status === 400);
    check('leave list works without date filters', (await leader('GET', '/api/leave')).status === 200);
    check('leader approves leave', (await leader('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 200);

    console.log('Tasks & work logs');
    check('assign task to team', (await leader('POST', '/api/tasks', { title: 'List 50 products', teamId: team.data.id, priority: 'high', dueDate: D(MON, 7) })).data.created === 1);
    const myTasks = (await member('GET', '/api/tasks/me')).data;
    check('member sees task', myTasks.length === 1);
    check('member completes task', (await member('POST', `/api/tasks/${myTasks[0].id}/status`, { status: 'done' })).status === 200);
    const wl = await member('POST', '/api/worklogs', { summary: 'Listed 52 products', hours: 7.5, units: 52, taskId: myTasks[0].id });
    check('daily work log', wl.status === 200);
    check('leader rates work log', (await leader('POST', `/api/worklogs/${wl.data.id}/review`, { rating: 5, note: 'Great' })).status === 200);

    console.log('Finance');
    const f = await leader('POST', '/api/finance', { date: YESTERDAY, orders: 40, investment: 1000, revenue: 2400, expenses: 300, store: 'Main store' });
    check('finance entry', f.status === 200);
    const fl = (await leader('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('profit = sales - investment - expenses', fl.totals.profit === 1100 && fl.totals.orders === 40, JSON.stringify(fl.totals));
    check('other department sees none of it', (await leaderAmazon('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 0);
    check('admin finance summary', (await admin('GET', `/api/finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.byDepartment.length === 1);

    console.log('Company finance & bills');
    check('leader cannot see company finance', (await leader('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).status === 403);
    check('leader cannot add bills', (await leader('POST', '/api/company-expenses', { date: TODAY, category: 'Electricity', amount: 100 })).status === 403);
    const bill = await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Electricity', amount: 150, status: 'paid', description: 'Monthly bill', vendor: 'Power Co', reference: 'B-1' });
    check('admin adds paid electricity bill', bill.status === 200);
    const unpaid = await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Internet', amount: 50, status: 'unpaid' });
    check('admin adds unpaid internet bill', unpaid.status === 200);
    check('unknown category rejected', (await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Nonsense', amount: 5 })).status === 400);
    const cf = (await admin('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.totals;
    check('net profit = revenue - dept investment - dept expenses - paid bills', cf.revenue === 2400 && cf.totalSpend === 1450 && cf.netProfit === 950, JSON.stringify(cf));
    check('unpaid bill kept out of profit but shown', cf.billsUnpaid === 50 && cf.profitAfterUnpaid === 900, JSON.stringify(cf));
    check('mark bill paid', (await admin('POST', `/api/company-expenses/${unpaid.data.id}/pay`, {})).status === 200
      && (await admin('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.totals.netProfit === 900);
    check('bills CSV export', (await admin('GET', `/api/company-expenses?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Power Co'));

    console.log('Salaries');
    const PERIOD = TODAY.slice(0, 7);
    check('member cannot open salary management', (await member('GET', '/api/salaries')).status === 403);
    check('leader sets a member salary', (await leader('PUT', '/api/salaries/rate', { type: 'member', refId: empId, amount: 1000 })).status === 200);
    check('leader cannot set a leader salary', (await leader('PUT', '/api/salaries/rate', { type: 'leader', refId: ebayId, amount: 2000 })).status === 403);
    check('other department cannot pay this member', (await leaderAmazon('POST', '/api/salaries/payments', { type: 'member', refId: empId, period: PERIOD, amount: 100, paidDate: TODAY })).status === 403);
    const pay1 = await leader('POST', '/api/salaries/payments', { type: 'member', refId: empId, period: PERIOD, amount: 600, paidDate: TODAY, method: 'Cash' });
    check('leader records a part payment', pay1.status === 200);
    check('overpaying is refused', (await leader('POST', '/api/salaries/payments', { type: 'member', refId: empId, period: PERIOD, amount: 500, paidDate: TODAY })).status === 400);
    check('future date refused', (await leader('POST', '/api/salaries/payments', { type: 'member', refId: empId, period: PERIOD, amount: 10, paidDate: ymd(offset(2)) })).status === 400);
    const sal = (await leader('GET', `/api/salaries?period=${PERIOD}`)).data;
    const row = sal.rows.find((r) => r.refId === empId);
    check('leader sees due / paid / remaining / status', row.due === 1000 && row.paid === 600 && row.remaining === 400 && row.status === 'partial' && row.pending === 1, JSON.stringify(row).slice(0, 200));
    check('leader sees members of own department only', sal.rows.every((r) => r.departmentId === ebayId));
    const member2 = client();
    await member2('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: ebay[2], employeeId: empId, pin: created.data.pin });
    check('member sees own salary payments', (await member2('GET', '/api/salaries/me')).data.awaitingConfirmation === 1);
    const myPay = (await member2('GET', '/api/salaries/me')).data.months[0].payments[0];
    check('dispute needs a reason', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'disputed' })).status === 400);
    check('member says not received', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'disputed', note: 'Got only 500' })).status === 200);
    check('leader sees the dispute', (await leader('GET', `/api/salaries?period=${PERIOD}`)).data.totals.disputed === 1);
    check('leader corrects the payment', (await leader('PUT', `/api/salaries/payments/${myPay.id}`, { amount: 500, paidDate: TODAY, method: 'Cash' })).status === 200);
    check('correction asks the member again', (await member2('GET', '/api/salaries/me')).data.awaitingConfirmation === 1);
    check('member confirms received', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'confirmed' })).status === 200);
    check('confirmed payment is locked', (await leader('DELETE', `/api/salaries/payments/${myPay.id}`)).status === 400);
    check('another member cannot confirm it', (await leaderAmazon('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'confirmed' })).status === 403);
    check('admin sets leader salary and name', (await admin('PUT', '/api/salaries/rate', { type: 'leader', refId: ebayId, amount: 2000, payeeName: 'Bilal Sheikh' })).status === 200);
    const lp = await admin('POST', '/api/salaries/payments', { type: 'leader', refId: ebayId, period: PERIOD, amount: 2000, paidDate: TODAY, method: 'Bank transfer' });
    check('admin pays the team leader', lp.status === 200);
    const mine = (await leader('GET', '/api/salaries/me')).data;
    check('team leader sees own salary awaiting confirmation', mine.payee.name === 'Bilal Sheikh' && mine.awaitingConfirmation === 1, JSON.stringify(mine).slice(0, 200));
    check('team leader confirms', (await leader('POST', `/api/salaries/payments/${lp.data.id}/confirm`, { status: 'confirmed' })).status === 200);
    check('leader cannot see leader salary list', (await leader('GET', `/api/salaries?type=leader&period=${PERIOD}`)).data.type === 'member');
    check('salaries CSV export', (await admin('GET', `/api/salaries?type=leader&period=${PERIOD}&format=csv`)).data.includes('Bilal Sheikh'));
    const cf2 = (await admin('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.totals;
    check('salaries flow into company finance', cf2.salariesPaid === 2500 && cf2.netProfit === 900 - 2500, JSON.stringify(cf2));

    console.log('Notifications');
    const leaderNotes = (await leader('GET', '/api/notifications?limit=100')).data;
    check('leader notified when member checks in', leaderNotes.items.some((n) => /checked in/.test(n.title)));
    check('leader notified when member checks out', leaderNotes.items.some((n) => /checked out/.test(n.title)));
    check('leader notified of leave request', leaderNotes.items.some((n) => /requested leave/.test(n.title)));
    check('leader notified when member completes a task', leaderNotes.items.some((n) => /marked a task done/.test(n.title)));
    const memberNotes = (await member2('GET', '/api/notifications?limit=100')).data;
    check('member notified of new task', memberNotes.items.some((n) => /New task assigned/.test(n.title)));
    check('member notified of approved attendance and leave', memberNotes.items.some((n) => /Attendance approved/.test(n.title)) && memberNotes.items.some((n) => /leave was approved/.test(n.title)));
    check('member notified of salary payment', memberNotes.items.some((n) => /Salary payment recorded/.test(n.title)));
    check('notifications are private to each portal', !memberNotes.items.some((n) => /checked in/.test(n.title)) && (await leaderAmazon('GET', '/api/notifications')).data.items.every((n) => !/Ali Raza/.test(n.title)));
    check('mark notifications read', (await leader('POST', '/api/notifications/read', { all: true })).status === 200 && (await leader('GET', '/api/notifications')).data.unread === 0);

    console.log('Member orders');
    check('leader cannot report orders as a member', (await leader('POST', '/api/orders', { date: TODAY, orders: 5 })).status === 403);
    check('member needs something to report', (await member2('POST', '/api/orders', { date: TODAY })).status === 400);
    const ord = await member2('POST', '/api/orders', { date: TODAY, store: 'Main store', orders: 12, investment: 300, revenue: 900, note: 'Busy day' });
    check('member reports orders, investment and sales', ord.status === 200);
    await member2('POST', '/api/orders', { date: YESTERDAY, orders: 8, investment: 100, revenue: 400 });
    const mine2 = (await member2('GET', `/api/orders/me?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('member sees own totals', mine2.totals.orders === 20 && mine2.totals.revenue === 1300 && mine2.totals.profit === 900, JSON.stringify(mine2.totals));
    const lo = (await leader('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('team leader sees member orders', lo.totals.orders === 20 && lo.byEmployee[0].name === 'Ali Raza');
    check('admin sees member orders', (await admin('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.revenue === 1300);
    check('other department sees none', (await leaderAmazon('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 0);
    check('member cannot open the orders list', (await member2('GET', '/api/orders')).status === 403);
    check('orders CSV export', (await leader('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Main store'));
    check('member edits own entry', (await member2('PUT', `/api/orders/${ord.data.id}`, { date: TODAY, orders: 14, investment: 300, revenue: 950 })).status === 200);

    console.log('Complaints');
    check('member cannot file complaints', (await member2('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', description: 'x' })).status === 403);
    check('other department cannot file', (await leaderAmazon('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', description: 'x' })).status === 403);
    const cp = await leader('POST', '/api/complaints', { employeeId: empId, category: 'Missed deadline', severity: 'high', description: 'Listings were not finished on time', incidentDate: YESTERDAY });
    check('team leader files a complaint', cp.status === 200);
    check('unknown category refused', (await leader('POST', '/api/complaints', { employeeId: empId, category: 'Nope', description: 'x' })).status === 400);
    const mc = (await member2('GET', '/api/complaints/me')).data;
    check('member sees the complaint about them', mc.length === 1 && mc[0].filedBy.includes('Team Leader'));
    check('member is notified', (await member2('GET', '/api/notifications')).data.items.some((n) => /complaint was filed about you/.test(n.title)));
    check('admin is notified', (await admin('GET', '/api/notifications')).data.items.some((n) => /filed a complaint/.test(n.title)));
    check('admin can also file (leader is told)', (await admin('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', severity: 'low', description: 'Rude to a colleague' })).status === 200
      && (await leader('GET', '/api/notifications')).data.items.some((n) => /Admin filed a complaint/.test(n.title)));
    check('member replies to the complaint', (await member2('POST', `/api/complaints/${cp.data.id}/respond`, { response: 'There was a power cut that day' })).status === 200);
    check('leader is told about the reply', (await leader('GET', '/api/notifications')).data.items.some((n) => /replied to a complaint/.test(n.title)));
    check('leader resolves the complaint', (await leader('PUT', `/api/complaints/${cp.data.id}`, { status: 'resolved', resolutionNote: 'Warning given' })).status === 200);
    check('member told it was resolved', (await member2('GET', '/api/notifications')).data.items.some((n) => /resolved/.test(n.title)));
    check('leader sees complaints list + CSV', (await leader('GET', `/api/complaints?employeeId=${empId}`)).data.length === 2 && (await leader('GET', '/api/complaints?format=csv')).data.includes('Missed deadline'));
    check('only admin can delete a complaint', (await leader('DELETE', `/api/complaints/${cp.data.id}`)).status === 403);

    console.log('Member reports');
    const rep = (await leader('GET', `/api/reports/employee/${empId}?from=${TWO_AGO}&to=${TODAY}`)).data;
    check('report has attendance, orders, sales, tasks and complaints', rep.metrics && rep.orders.orders === 22 && rep.orders.sales === 1350 && rep.complaints.length === 2 && Array.isArray(rep.tasks), JSON.stringify({ o: rep.orders.orders, c: rep.complaints.length }));
    check('report shows complaint counts in the summary row', rep.metrics.complaints === 2 || rep.metrics.complaints === 1);
    check('other department cannot read the report', (await leaderAmazon('GET', `/api/reports/employee/${empId}?from=${TWO_AGO}&to=${TODAY}`)).status === 403);
    check('member reads own report', (await member2('GET', `/api/reports/me?from=${TWO_AGO}&to=${TODAY}`)).data.employee.id === empId);
    const all = (await leader('GET', `/api/reports/members?from=${TWO_AGO}&to=${TODAY}`)).data.rows;
    check('all-members report row', all.find((r) => r.employeeId === empId).sales === 1350);
    check('all-members CSV', (await leader('GET', `/api/reports/members?from=${TWO_AGO}&to=${TODAY}&format=csv`)).data.includes('Complaints'));

    console.log('Reports & dashboard');
    for (const level of ['employee', 'team', 'department']) {
      const r = await admin('GET', `/api/reports/performance?level=${level}&from=${TWO_AGO}&to=${TODAY}`);
      check(`performance (${level})`, r.status === 200 && r.data.rows.length >= 1, JSON.stringify(r.data).slice(0, 200));
    }
    const dash = (await admin('GET', '/api/dashboard')).data;
    check('admin dashboard', dash.departments.length === 6 && dash.today.present === 1);
    check('leader dashboard scoped', (await leader('GET', '/api/dashboard')).data.departments === null);
    check('member dashboard', (await member('GET', '/api/dashboard/me')).status === 200);
    check('performance CSV', (await admin('GET', '/api/reports/performance?level=employee&format=csv')).data.includes('Attendance %'));

    console.log('Admin, logs, backups');
    const logs = (await admin('GET', '/api/logs')).data;
    check('activity log captured actions', logs.length > 10 && logs.some((l) => l.action === 'login') && logs.some((l) => l.action === 'login_failed'));
    check('leader sees only own department log', (await leader('GET', '/api/logs')).data.every((l) => l.departmentId === ebayId));
    check('manual backup', (await admin('POST', '/api/backups')).status === 200);
    check('backup list', (await admin('GET', '/api/backups')).data.length >= 2);
    check('backups admin only', (await leader('GET', '/api/backups')).status === 403);
    check('disable a module', (await admin('PUT', '/api/modules/finance', { enabled: false })).status === 200 && (await leader('GET', '/api/finance')).status === 404);
    await admin('PUT', '/api/modules/finance', { enabled: true });
    check('leader changes member password', (await leader('PUT', `/api/departments/${ebayId}/passwords`, { memberPassword: 'NewMemberPass1' })).status === 200);
    check('leader cannot change leader password', (await leader('PUT', `/api/departments/${ebayId}/passwords`, { leaderPassword: 'NewLeaderPass1' })).status === 403);
    check('deactivated employee loses access', (await leader('PUT', `/api/employees/${empId}`, { ...prof, status: 'inactive' })).status === 200 && (await member('GET', '/api/attendance/me/today')).status === 401);
    check('logout', (await leader('POST', '/api/auth/logout')).status === 200 && (await leader('GET', '/api/employees')).status === 401);

    console.log('Push notifications');
    const { encrypt, validEndpoint, b64u, fromB64u } = require('../core/pushcrypto');
    // 1. The encryption reproduces the worked example published in RFC 8291.
    const rfcKey = crypto.createECDH('prime256v1');
    rfcKey.setPrivateKey(fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const rfcBody = b64u(encrypt({ p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'), { ecdh: rfcKey, salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw') }));
    check('encryption matches the RFC 8291 example', rfcBody === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    // 2. A browser (played here by node) can decrypt what the server encrypts.
    const ua = crypto.createECDH('prime256v1');
    const uaPub = ua.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const sealed = encrypt({ p256dh: b64u(uaPub), auth: b64u(authSecret) }, Buffer.from(JSON.stringify({ title: 'New task assigned to you', body: 'List 30 products' })));
    const salt = sealed.subarray(0, 16);
    const asPub = sealed.subarray(21, 21 + sealed[20]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
    const dec = crypto.createDecipheriv('aes-128-gcm', Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
    const ct = sealed.subarray(21 + sealed[20]);
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    check('a browser can decrypt the push message', JSON.parse(plain.subarray(0, plain.length - 1).toString()).title === 'New task assigned to you');
    // 3. Only real push services are ever contacted.
    check('push endpoint allow-list', validEndpoint('https://fcm.googleapis.com/fcm/send/abc') && validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')
      && validEndpoint('https://web.push.apple.com/x') && !validEndpoint('http://fcm.googleapis.com/x') && !validEndpoint('https://127.0.0.1/x')
      && !validEndpoint('https://evil.example.com/x') && !validEndpoint('https://fcm.googleapis.com.evil.com/x'));
    // 4. API
    const pushLeader = client();
    await pushLeader('POST', '/api/auth/login', { portal: 'leader', departmentId: ebayId, password: ebay[1] });
    check('server gives the browser its VAPID public key', (await pushLeader('GET', '/api/push/key')).data.key.length === 87);
    check('anonymous cannot get the push key', (await anon('GET', '/api/push/key')).status === 401);
    const subBody = { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint', keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } } };
    check('subscription to an unknown host is refused', (await pushLeader('POST', '/api/push/subscribe', { subscription: { ...subBody.subscription, endpoint: 'https://127.0.0.1/x' } })).status === 400);
    check('subscription with bad keys is refused', (await pushLeader('POST', '/api/push/subscribe', { subscription: { ...subBody.subscription, keys: { p256dh: 'abc', auth: 'abc' } } })).status === 400);
    check('device subscribes', (await pushLeader('POST', '/api/push/subscribe', subBody)).status === 200);
    check('device unsubscribes (sign-out)', (await pushLeader('POST', '/api/push/unsubscribe', { endpoint: subBody.subscription.endpoint })).status === 200);
    check('test notification', (await pushLeader('POST', '/api/push/test')).status === 200 && (await pushLeader('GET', '/api/notifications')).data.items[0].title === 'Test notification');

    console.log('Brute force lock');
    const attacker = client();
    let last;
    for (let i = 0; i < 7; i++) last = await attacker('POST', '/api/auth/login', { portal: 'admin', password: 'guessguess' + i });
    check('locked after repeated failures', last.status === 429);
  } finally {
    await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows may keep the file locked briefly; temp folder is harmless */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
