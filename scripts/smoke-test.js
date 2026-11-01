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
const ADMIN_PW = 'Smoke-admin-pass-1';
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
    env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: ADMIN_PW }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('running') && resolve()));

  // Signs in and returns the client (with .status of the login attempt).
  const as = async (portal, departmentId, password, extra = {}) => {
    const c = client();
    c.login = await c('POST', '/api/auth/login', { portal, departmentId, password, ...extra });
    return c;
  };
  const names = (r) => r.data.map((x) => x.name);

  try {
    console.log('Sign-in basics');
    const anon = client();
    check('public department list', (await anon('GET', '/api/public/departments')).data.length === 6);
    check('API blocks anonymous', (await anon('GET', '/api/employees')).status === 401);
    check('wrong admin password rejected', (await anon('POST', '/api/auth/login', { portal: 'admin', password: 'wrongwrong' })).status === 401);
    check('mutations need the request header', (await fetch(BASE + '/api/auth/login', { method: 'POST', body: '{}' })).status === 403);
    const admin = client();
    check('admin login', (await admin('POST', '/api/auth/login', { portal: 'admin', password: ADMIN_PW })).status === 200);
    const depts = (await admin('GET', '/api/departments')).data;
    const ebayId = depts.find((d) => d.slug === 'ebay').id;
    const amazonId = depts.find((d) => d.slug === 'amazon').id;
    check('departments start without a head', depts.every((d) => d.headId === null));

    console.log('Head of department (set by the admin)');
    check('short head password refused', (await admin('PUT', `/api/departments/${ebayId}/head`, { name: 'Hamza Head', password: 'short' })).status === 400);
    check('head needs a password at first', (await admin('PUT', `/api/departments/${ebayId}/head`, { name: 'Hamza Head' })).status === 400);
    const head = await admin('PUT', `/api/departments/${ebayId}/head`, { name: 'Hamza Head', password: 'HodEbay-Pass1' });
    check('admin creates the eBay head', head.status === 200 && /^ETX-/.test(head.data.empCode));
    const hodAmz = await admin('PUT', `/api/departments/${amazonId}/head`, { name: 'Amna Head', password: 'HodAmz-Pass-1' });
    check('admin creates the Amazon head', hodAmz.status === 200);
    const hod = await as('hod', ebayId, 'HodEbay-Pass1');
    check('head signs in with only a password', hod.login.status === 200 && hod.login.data.user.role === 'hod' && hod.login.data.user.name === 'Hamza Head');
    check('wrong head password refused', (await as('hod', ebayId, 'nope-nope-nope')).login.status === 401);
    check('head password of another department refused', (await as('hod', amazonId, 'HodEbay-Pass1')).login.status === 401);
    const hod2 = await as('hod', amazonId, 'HodAmz-Pass-1');
    check('departments list shows the head', (await admin('GET', '/api/departments')).data.find((d) => d.id === ebayId).headName === 'Hamza Head');
    check('head cannot change the head or the department', (await hod('PUT', `/api/departments/${ebayId}/head`, { name: 'X', password: 'Whatever-Pass1' })).status === 403
      && (await hod('PUT', `/api/departments/${ebayId}`, { name: 'Renamed' })).status === 403);

    console.log('Teams and team leaders (set by the head)');
    const tA = (await hod('POST', '/api/teams', { name: 'Alpha' })).data.id;
    const tB = (await hod('POST', '/api/teams', { name: 'Beta' })).data.id;
    const tC = (await hod('POST', '/api/teams', { name: 'Gamma' })).data.id;
    const tZ = (await hod2('POST', '/api/teams', { name: 'Zeta' })).data.id;
    check('four teams created', [tA, tB, tC, tZ].every(Number.isInteger));
    check('a department cannot have more than 3 teams (3 team leaders)', (await hod('POST', '/api/teams', { name: 'Delta' })).status === 400 && (await admin('POST', '/api/teams', { departmentId: ebayId, name: 'Delta' })).status === 400 && (await hod('GET', '/api/teams')).data.length === 3);
    check('duplicate team name refused', (await hod('POST', '/api/teams', { name: 'Alpha' })).status === 400);
    check('head sees only their own department teams', (await hod('GET', '/api/teams')).data.length === 3 && (await hod2('GET', '/api/teams')).data.length === 1);
    check('leader needs a password', (await hod('POST', `/api/teams/${tA}/leader`, { name: 'No Pass' })).status === 400);
    const la = await hod('POST', `/api/teams/${tA}/leader`, { name: 'Lina Lead', password: 'LeadA-Pass-1' });
    check('head appoints team leader of Alpha', la.status === 200);
    check('two leaders cannot share a password', (await hod('POST', `/api/teams/${tB}/leader`, { name: 'Same Pass', password: 'LeadA-Pass-1' })).status === 400);
    const lb = await hod('POST', `/api/teams/${tB}/leader`, { name: 'Bilal Lead', password: 'LeadB-Pass-1' });
    const lc = await hod('POST', `/api/teams/${tC}/leader`, { name: 'Cathy Lead', password: 'LeadC-Pass-1' });
    const lz = await hod2('POST', `/api/teams/${tZ}/leader`, { name: 'Zed Lead', password: 'LeadZ-Pass-1' });
    check('leaders of Beta, Gamma and Zeta appointed', [lb, lc, lz].every((r) => r.status === 200));
    check('admin can also appoint (department of the team)', (await admin('POST', `/api/teams/${tA}/leader`, { employeeId: la.data.id })).status === 200);
    const leaderA = await as('leader', ebayId, 'LeadA-Pass-1');
    const leaderB = await as('leader', ebayId, 'LeadB-Pass-1');
    const leaderC = await as('leader', ebayId, 'LeadC-Pass-1');
    const leaderZ = await as('leader', amazonId, 'LeadZ-Pass-1');
    check('team leaders sign in with only a password', [leaderA, leaderB, leaderC, leaderZ].every((c) => c.login.status === 200 && c.login.data.user.role === 'leader'));
    check('leader portal knows name and team', leaderA.login.data.user.name === 'Lina Lead' && leaderA.login.data.user.teamName === 'Alpha');
    check('head password does not open the leader portal', (await as('leader', ebayId, 'HodEbay-Pass1')).login.status === 401);
    check('leader password does not open the head portal', (await as('hod', ebayId, 'LeadA-Pass-1')).login.status === 401);
    check('leader cannot create teams', (await leaderA('POST', '/api/teams', { name: 'Sneaky' })).status === 403);
    check('leader sees only their own team', (await leaderA('GET', '/api/teams')).data.length === 1);
    check('leader sets the member password of own team', (await leaderA('PUT', `/api/teams/${tA}/member-password`, { password: 'AlphaTeam-Pass1' })).status === 200);
    check('leader cannot touch another team', (await leaderA('PUT', `/api/teams/${tB}/member-password`, { password: 'Hijack-Pass-1' })).status === 403);
    check('two teams cannot share a member password', (await hod('PUT', `/api/teams/${tB}/member-password`, { password: 'AlphaTeam-Pass1' })).status === 400);
    check('head sets the member password of other teams', (await hod('PUT', `/api/teams/${tB}/member-password`, { password: 'BetaTeam-Pass-1' })).status === 200
      && (await hod('PUT', `/api/teams/${tC}/member-password`, { password: 'GammaTeam-Pass1' })).status === 200
      && (await hod2('PUT', `/api/teams/${tZ}/member-password`, { password: 'ZetaTeam-Pass-1' })).status === 200);

    console.log('Adding members (leader: own team, head: any team of the department)');
    const shift = (await leaderA('GET', '/api/shifts')).data[0];
    const created = await leaderA('POST', '/api/employees', { name: 'Ali Raza', designation: 'Listing Specialist', joinDate: '2026-09-01', shiftId: shift.id, phone: '0300-1234567' });
    check('leader adds a member (PIN returned once)', created.status === 200 && /^\d{6}$/.test(created.data.pin), JSON.stringify(created.data));
    const empId = created.data.id;
    const ali = (await leaderA('GET', `/api/employees/${empId}`)).data;
    check('new member lands in the leader\'s team', ali.teamId === tA && ali.departmentId === ebayId && ali.role === 'member');
    check('joining history recorded', ali.history.length === 1 && ali.history[0].eventType === 'joined');
    const extra = await leaderA('POST', '/api/employees', { name: 'Ali Two', joinDate: '2026-09-02', teamId: tB });
    check('a leader cannot place a member in another team', (await leaderA('GET', `/api/employees/${extra.data.id}`)).data.teamId === tA);
    await leaderA('PUT', `/api/employees/${extra.data.id}`, { name: 'Ali Two', joinDate: '2026-09-02', status: 'inactive' });
    const bina = await hod('POST', '/api/employees', { name: 'Bina Khan', designation: 'Support', joinDate: '2026-09-05', teamId: tB, shiftId: shift.id });
    check('head adds a member to Beta', bina.status === 200 && (await hod('GET', `/api/employees/${bina.data.id}`)).data.teamName === 'Beta');
    check('a member needs a team (head must choose one)', (await hod('POST', '/api/employees', { name: 'No Team', joinDate: '2026-09-05' })).status === 400);
    check('head cannot add to another department\'s team', (await hod('POST', '/api/employees', { name: 'Wrong', joinDate: '2026-09-05', teamId: tZ })).status === 403);
    const zita = await leaderZ('POST', '/api/employees', { name: 'Zita Noor', joinDate: '2026-09-05' });
    check('leader of Zeta adds a member', zita.status === 200);

    console.log('Who sees what');
    const actives = (c, q = '') => c('GET', `/api/employees?status=active${q}`);
    check('leader Alpha sees only the Alpha members', JSON.stringify(names(await actives(leaderA))) === '["Ali Raza"]');
    check('leader Beta sees only the Beta members', JSON.stringify(names(await actives(leaderB))) === '["Bina Khan"]');
    const hodList = await actives(hod);
    check('head sees all teams: 3 leaders + members', hodList.data.filter((e) => e.role === 'team_leader').length === 3 && hodList.data.filter((e) => e.role === 'member').length === 2 && !hodList.data.some((e) => e.role === 'hod'));
    check('head does not see the other department', !names(hodList).includes('Zita Noor'));
    const adminList = await actives(admin);
    check('admin sees everybody including heads', adminList.data.some((e) => e.role === 'hod') && names(adminList).includes('Zita Noor'));
    check('leader cannot open a member of another team', (await leaderA('GET', `/api/employees/${bina.data.id}`)).status === 403);
    check('leader cannot open a team leader', (await leaderA('GET', `/api/employees/${lb.data.id}`)).status === 403);
    check('head can open any member and leader of the department', (await hod('GET', `/api/employees/${bina.data.id}`)).status === 200 && (await hod('GET', `/api/employees/${lb.data.id}`)).status === 200);
    check('head cannot open another department', (await hod('GET', `/api/employees/${zita.data.id}`)).status === 403);
    check('a leader reads their own profile', (await leaderA('GET', '/api/employees/me')).data.leadsTeam === 'Alpha');
    check('employee search', (await leaderA('GET', '/api/employees?search=Listing')).data.length === 1);
    check('employee CSV export', (await leaderA('GET', '/api/employees?format=csv')).data.includes('Ali Raza'));
    await leaderA('PUT', `/api/employees/${empId}`, { ...ali, designation: 'Senior Listing Specialist' });
    check('designation change adds history', (await leaderA('GET', `/api/employees/${empId}`)).data.history.length === 2);
    check('a leader cannot edit another team\'s member', (await leaderA('PUT', `/api/employees/${bina.data.id}`, { name: 'Bina Khan', joinDate: '2026-09-05' })).status === 403);
    check('a leader cannot edit themselves', (await leaderA('PUT', `/api/employees/${la.data.id}`, { name: 'Lina Lead', joinDate: '2026-09-05' })).status === 403);

    console.log('Passwords: admin -> head, head/admin -> leaders, leaders -> members');
    check('head changes a leader password', (await hod('PUT', `/api/employees/${la.data.id}/password`, { password: 'LeadA-NewPass-2' })).status === 200);
    check('old leader session is signed out', (await leaderA('GET', '/api/employees/me')).status === 401);
    check('old leader password stops working', (await as('leader', ebayId, 'LeadA-Pass-1')).login.status === 401);
    const leaderA2 = await as('leader', ebayId, 'LeadA-NewPass-2');
    check('new leader password works', leaderA2.login.status === 200);
    check('a leader cannot change a leader password', (await leaderA2('PUT', `/api/employees/${lb.data.id}/password`, { password: 'Sneaky-Pass-1' })).status === 403);
    check('a leader cannot change their own password', (await leaderA2('PUT', `/api/employees/${la.data.id}/password`, { password: 'Sneaky-Pass-1' })).status === 403);
    check('head cannot change the head password', (await hod('PUT', `/api/employees/${head.data.id}/password`, { password: 'Sneaky-Pass-1' })).status === 403);
    check('head cannot change a leader of another department', (await hod('PUT', `/api/employees/${lz.data.id}/password`, { password: 'Sneaky-Pass-1' })).status === 403);
    check('admin changes a leader password too', (await admin('PUT', `/api/employees/${lc.data.id}/password`, { password: 'LeadC-Admin-Pass3' })).status === 200);
    check('a duplicate leader password is refused', (await hod('PUT', `/api/employees/${lb.data.id}/password`, { password: 'LeadA-NewPass-2' })).status === 400);
    check('admin changes the head password', (await admin('PUT', `/api/employees/${head.data.id}/password`, { password: 'HodEbay-NewPass2' })).status === 200
      && (await hod('GET', '/api/employees/me')).status === 401 && (await as('hod', ebayId, 'HodEbay-NewPass2')).login.status === 200);
    const hodNew = await as('hod', ebayId, 'HodEbay-NewPass2');
    const leaderC2 = await as('leader', ebayId, 'LeadC-Admin-Pass3');
    check('members have no password change from the employee screen', (await hodNew('PUT', `/api/employees/${empId}/password`, { password: 'Whatever-Pass1' })).status === 400);

    console.log('Member portal');
    const member = client();
    const listing = await anon('POST', '/api/auth/members', { departmentId: ebayId, password: 'AlphaTeam-Pass1' });
    check('team password lists only that team\'s names', listing.status === 200 && listing.data.team.name === 'Alpha' && listing.data.members.length === 1 && listing.data.members[0].id === empId);
    check('wrong team password refused', (await anon('POST', '/api/auth/members', { departmentId: ebayId, password: 'not-a-team-password' })).status === 401);
    check('wrong PIN rejected', (await member('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: empId, pin: '000000' })).status === 401);
    check('another team\'s password cannot be used for this person', (await member('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'BetaTeam-Pass-1', employeeId: empId, pin: created.data.pin })).status === 401);
    check('member login', (await member('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: empId, pin: created.data.pin })).status === 200);
    check('member blocked from finance, employee list and teams', (await member('GET', '/api/finance')).status === 403 && (await member('GET', '/api/employees')).status === 403 && (await member('GET', '/api/teams')).status === 403);

    console.log('Attendance (members, team leaders and the head all check in)');
    check('check in', (await member('POST', '/api/attendance/me/action', { action: 'check_in' })).data.state === 'working');
    check('double check-in refused', (await member('POST', '/api/attendance/me/action', { action: 'check_in' })).status === 400);
    check('break start', (await member('POST', '/api/attendance/me/action', { action: 'break_start' })).data.state === 'on_break');
    check('break end', (await member('POST', '/api/attendance/me/action', { action: 'break_end' })).data.state === 'working');
    check('check out', (await member('POST', '/api/attendance/me/action', { action: 'check_out' })).data.state === 'done');
    const board = (await leaderA2('GET', '/api/attendance/board')).data;
    check('leader board shows only own team', board.rows.length === 1 && board.summary.present === 1 && board.summary.pendingApproval === 1);
    const rec = board.rows.find((r) => r.id === empId).record;
    check('another team\'s leader cannot approve', (await leaderB('POST', `/api/attendance/${rec.id}/decision`, { approval: 'approved' })).status === 403);
    check('leader approves own member\'s attendance', (await leaderA2('POST', `/api/attendance/${rec.id}/decision`, { approval: 'approved' })).status === 200);
    check('manual absent for past day', (await leaderA2('POST', '/api/attendance/manual', { employeeId: empId, date: TWO_AGO, status: 'absent', note: 'No call' })).status === 200);
    check('leader cannot mark another team\'s member', (await leaderB('POST', '/api/attendance/manual', { employeeId: empId, date: TWO_AGO, status: 'absent' })).status === 403);

    check('team leader checks in', (await leaderA2('POST', '/api/attendance/me/action', { action: 'check_in' })).data.state === 'working');
    check('team leader works a break and checks out', (await leaderA2('POST', '/api/attendance/me/action', { action: 'break_start' })).status === 200
      && (await leaderA2('POST', '/api/attendance/me/action', { action: 'break_end' })).status === 200
      && (await leaderA2('POST', '/api/attendance/me/action', { action: 'check_out' })).data.state === 'done');
    check('head checks in and out', (await hodNew('POST', '/api/attendance/me/action', { action: 'check_in' })).data.state === 'working'
      && (await hodNew('POST', '/api/attendance/me/action', { action: 'check_out' })).data.state === 'done');
    const hodBoard = (await hodNew('GET', '/api/attendance/board')).data;
    const leaderRow = hodBoard.rows.find((r) => r.id === la.data.id);
    check('head sees the leaders and members of all teams', hodBoard.rows.length === 5 && leaderRow.record && leaderRow.role === 'team_leader');
    check('head cannot approve a leader\'s attendance (admin only)', leaderRow.canApprove === false && (await hodNew('POST', `/api/attendance/${leaderRow.record.id}/decision`, { approval: 'approved' })).status === 403);
    check('head cannot mark a leader manually', (await hodNew('POST', '/api/attendance/manual', { employeeId: la.data.id, date: TWO_AGO, status: 'absent' })).status === 403);
    check('head can approve a member\'s attendance', (await hodNew('POST', `/api/attendance/${rec.id}/decision`, { approval: 'approved' })).status === 200);
    const adminBoard = (await admin('GET', `/api/attendance/board?departmentId=${ebayId}`)).data;
    const headRow = adminBoard.rows.find((r) => r.role === 'hod');
    check('admin sees the head and leaders with approve buttons', adminBoard.rows.length === 6 && headRow.canApprove === true && adminBoard.rows.find((r) => r.id === la.data.id).canApprove === true);
    check('admin approves the leader\'s attendance', (await admin('POST', `/api/attendance/${leaderRow.record.id}/decision`, { approval: 'approved' })).status === 200);
    check('admin approves the head\'s attendance', (await admin('POST', `/api/attendance/${headRow.record.id}/decision`, { approval: 'approved' })).status === 200);
    check('admin filters by role', (await admin('GET', `/api/attendance?role=hod&from=${TODAY}&to=${TODAY}`)).data.every((r) => r.role === 'hod'));
    const bulk = await hodNew('POST', '/api/attendance/bulk-decision', { approval: 'approved', ids: [leaderRow.record.id, rec.id] });
    check('bulk approval skips what the head may not decide', bulk.data.skipped === 1 && bulk.data.updated === 1);
    check('leader attendance list excludes leaders', (await leaderA2('GET', `/api/attendance?from=${TODAY}&to=${TODAY}`)).data.every((r) => r.role === 'member'));
    check('own attendance history', (await leaderA2('GET', '/api/attendance/me')).data.length === 1);

    console.log('Leave');
    const lv = await member('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON), toDate: D(MON, 2), reason: 'Family event' });
    check('leave request (3 working days)', lv.status === 200 && lv.data.days === 3, JSON.stringify(lv.data));
    check('overlapping leave refused', (await member('POST', '/api/leave', { leaveType: 'Sick', fromDate: D(MON, 1), toDate: D(MON, 1), reason: 'x' })).status === 400);
    check('leave list works without date filters', (await leaderA2('GET', '/api/leave')).status === 200);
    check('another team cannot see or decide it', (await leaderB('GET', '/api/leave')).data.length === 0 && (await leaderB('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 403);
    check('leader approves member leave', (await leaderA2('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 200);
    const llv = await leaderA2('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON, 7), toDate: D(MON, 8), reason: 'Wedding' });
    check('team leader requests leave', llv.status === 200);
    check('leader cannot approve their own leave', (await leaderA2('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 403);
    check('another leader cannot approve it', (await leaderB('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 403);
    check('head approves the leader\'s leave', (await hodNew('GET', '/api/leave')).data.find((l) => l.id === llv.data.id).canDecide === true && (await hodNew('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 200);
    const hlv = await hodNew('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON, 14), toDate: D(MON, 14), reason: 'Personal' });
    check('head requests leave, only the admin decides', hlv.status === 200 && (await hodNew('POST', `/api/leave/${hlv.data.id}/decision`, { status: 'approved' })).status === 403
      && (await admin('POST', `/api/leave/${hlv.data.id}/decision`, { status: 'approved' })).status === 200);
    check('leader\'s leave history', (await leaderA2('GET', '/api/leave/me')).data.length === 1);

    console.log('Tasks & work logs');
    check('assign task to own team', (await leaderA2('POST', '/api/tasks', { title: 'List 50 products', priority: 'high', dueDate: D(MON, 7) })).data.created === 1);
    check('leader cannot assign to another team', (await leaderA2('POST', '/api/tasks', { title: 'Nope', assignedTo: bina.data.id })).status === 403);
    check('leader cannot assign to a leader', (await leaderA2('POST', '/api/tasks', { title: 'Nope', assignedTo: lb.data.id })).status === 403);
    const myTasks = (await member('GET', '/api/tasks/me')).data;
    check('member sees task', myTasks.length === 1);
    const t0 = myTasks[0].id;
    check('member starts the task', (await member('POST', `/api/tasks/${t0}/status`, { status: 'in_progress' })).data.status === 'in_progress');
    check('member submits the finished task', (await member('POST', `/api/tasks/${t0}/submit`, { note: 'All 50 listed' })).data.status === 'pending_approval');
    check('it stays "Pending approval", not completed', (await member('GET', '/api/tasks/me')).data[0].status === 'pending_approval');
    check('the member cannot complete it by themselves or edit it meanwhile', (await member('POST', `/api/tasks/${t0}/status`, { status: 'in_progress' })).status === 400 && (await member('POST', `/api/tasks/${t0}/submit`, {})).status === 400);
    check('the assigner is asked to review', (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Ali Raza submitted a task for approval/.test(n.title)));
    check('manager list shows the review button for the assigner only', (await leaderA2('GET', '/api/tasks')).data.find((t) => t.id === t0).canReview === true && (await hodNew('GET', '/api/tasks')).data.find((t) => t.id === t0).canReview === true);
    check('the dashboard counts tasks to review', (await leaderA2('GET', '/api/dashboard')).data.pending.tasks === 1);
    check('another team\'s leader cannot review', (await leaderB('POST', `/api/tasks/${t0}/review`, { decision: 'approve' })).status === 403);
    check('manager cannot mark a submitted task done by editing it', (await leaderA2('PUT', `/api/tasks/${t0}`, { title: 'List 50 products', status: 'done' })).status === 400);
    check('feedback is required to request changes or reject', (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'changes' })).status === 400 && (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'reject', note: '' })).status === 400);
    check('leader requests changes with feedback', (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'changes', note: 'Titles are missing for 5 products' })).data.status === 'changes_requested');
    const sent = (await member('GET', '/api/tasks/me')).data[0];
    check('member sees the feedback and is notified', sent.status === 'changes_requested' && sent.reviewNote.includes('Titles') && (await member('GET', '/api/notifications?limit=100')).data.items.some((n) => /Changes requested on your task/.test(n.title)));
    check('a reviewed task cannot be reviewed again until resubmitted', (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'approve' })).status === 400);
    await member('POST', `/api/tasks/${t0}/submit`, { note: 'Fixed the titles' });
    check('leader rejects the submission with a reason', (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'reject', note: 'Wrong store' })).data.status === 'rejected' && (await member('GET', '/api/notifications?limit=100')).data.items.some((n) => /submission was rejected/.test(n.title)));
    check('member can restart a rejected task and submit again', (await member('POST', `/api/tasks/${t0}/status`, { status: 'in_progress' })).status === 200 && (await member('POST', `/api/tasks/${t0}/submit`, { note: 'Redone for the right store' })).status === 200);
    check('approving completes the task', (await leaderA2('POST', `/api/tasks/${t0}/review`, { decision: 'approve', note: 'Good' })).data.status === 'done' && (await member('GET', '/api/tasks/me')).data[0].status === 'done');
    check('member is told it was approved', (await member('GET', '/api/notifications?limit=100')).data.items.some((n) => /Your task was approved/.test(n.title)));
    check('a completed task is locked', (await member('POST', `/api/tasks/${t0}/status`, { status: 'todo' })).status === 400);
    const wl = await member('POST', '/api/worklogs', { summary: 'Listed 52 products', hours: 7.5, remarks: 'The label printer was slow, lost about an hour', taskId: t0 });
    check('daily work log with remarks / issues (optional)', wl.status === 200 && (await member('POST', '/api/worklogs', { summary: 'Short day', hours: 2 })).status === 200);
    check('remarks are visible to the leader and reported to them', (await leaderA2('GET', `/api/worklogs?from=${TODAY}&to=${TODAY}`)).data.some((l) => /label printer/.test(l.remarks)) && (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /added remarks \/ issues/.test(n.title)));
    check('leader rates work log', (await leaderA2('POST', `/api/worklogs/${wl.data.id}/review`, { rating: 5, note: 'Great' })).status === 200);
    check('other team cannot read or rate it', (await leaderB('GET', `/api/worklogs?from=${TODAY}&to=${TODAY}`)).data.length === 0 && (await leaderB('POST', `/api/worklogs/${wl.data.id}/review`, { rating: 1 })).status === 403);
    check('head gives a leader a task', (await hodNew('POST', '/api/tasks', { title: 'Weekly team report', assignedTo: la.data.id, dueDate: D(MON, 3) })).data.created === 1);
    const leaderTasks = (await leaderA2('GET', '/api/tasks/me')).data;
    check('leader sees the task from the head', leaderTasks.length === 1 && leaderTasks[0].title === 'Weekly team report');
    check('leader submits it and the head (who assigned it) reviews it', (await leaderA2('POST', `/api/tasks/${leaderTasks[0].id}/submit`, {})).status === 200
      && (await hodNew('GET', '/api/dashboard')).data.pending.tasks === 1 && (await hodNew('POST', `/api/tasks/${leaderTasks[0].id}/review`, { decision: 'approve' })).data.status === 'done');
    check('head sees tasks of all teams', (await hodNew('GET', '/api/tasks')).data.length === 2 && (await leaderA2('GET', '/api/tasks')).data.length === 1);
    check('team assignment by the head', (await hodNew('POST', '/api/tasks', { title: 'Beta cleanup', teamId: tB })).data.created === 1);

    console.log('Finance (per team)');
    const f = await leaderA2('POST', '/api/finance', { date: YESTERDAY, orders: 40, investment: 1000, revenue: 2400, expenses: 300, store: 'Main store' });
    check('leader adds an entry for own team', f.status === 200);
    const fl = (await leaderA2('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('profit = sales - investment - expenses', fl.totals.profit === 1100 && fl.totals.orders === 40 && fl.rows[0].teamName === 'Alpha', JSON.stringify(fl.totals));
    check('other team sees none of it', (await leaderB('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 0);
    check('other team cannot change it', (await leaderB('PUT', `/api/finance/${f.data.id}`, { date: YESTERDAY, orders: 1 })).status === 403 && (await leaderB('DELETE', `/api/finance/${f.data.id}`)).status === 403);
    check('other department sees none of it', (await leaderZ('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 0);
    await hodNew('POST', '/api/finance', { date: YESTERDAY, orders: 10, investment: 100, revenue: 300, teamId: tB });
    check('head sees every team of the department', (await hodNew('GET', `/api/finance?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 50);
    const fsum = (await hodNew('GET', `/api/finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('finance summary per team', fsum.byTeam.length === 2);
    check('admin finance summary', (await admin('GET', `/api/finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.byDepartment.length === 1);

    console.log('Company finance & bills (admin only)');
    check('head cannot see company finance', (await hodNew('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).status === 403);
    check('leader cannot add bills', (await leaderA2('POST', '/api/company-expenses', { date: TODAY, category: 'Electricity', amount: 100 })).status === 403);
    const bill = await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Electricity', amount: 150, status: 'paid', description: 'Monthly bill', vendor: 'Power Co', reference: 'B-1' });
    check('admin adds paid electricity bill', bill.status === 200);
    const unpaid = await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Internet', amount: 50, status: 'unpaid' });
    check('admin adds unpaid internet bill', unpaid.status === 200);
    check('unknown category rejected', (await admin('POST', '/api/company-expenses', { date: TODAY, category: 'Nonsense', amount: 5 })).status === 400);
    const cf = (await admin('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.totals;
    check('net profit = revenue - dept investment - dept expenses - paid bills', cf.revenue === 2700 && cf.totalSpend === 1550 && cf.netProfit === 1150, JSON.stringify(cf));
    check('unpaid bill kept out of profit but shown', cf.billsUnpaid === 50 && cf.profitAfterUnpaid === 1100, JSON.stringify(cf));
    check('mark bill paid', (await admin('POST', `/api/company-expenses/${unpaid.data.id}/pay`, {})).status === 200);
    check('bills CSV export', (await admin('GET', `/api/company-expenses?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Power Co'));

    console.log('Salaries (leader -> members, head -> leaders, admin -> heads)');
    const PERIOD = TODAY.slice(0, 7);
    check('member cannot open salary management', (await member('GET', '/api/salaries')).status === 403);
    check('leader sets a member salary', (await leaderA2('PUT', '/api/salaries/rate', { refId: empId, amount: 1000 })).status === 200);
    check('another team\'s leader cannot', (await leaderB('PUT', '/api/salaries/rate', { refId: empId, amount: 5 })).status === 403);
    check('leader cannot set a leader or head salary', (await leaderA2('PUT', '/api/salaries/rate', { refId: lb.data.id, amount: 2000 })).status === 403
      && (await leaderA2('PUT', '/api/salaries/rate', { refId: head.data.id, amount: 2000 })).status === 403 && (await leaderA2('PUT', '/api/salaries/rate', { refId: la.data.id, amount: 2000 })).status === 403);
    const pay1 = await leaderA2('POST', '/api/salaries/payments', { refId: empId, period: PERIOD, amount: 600, paidDate: TODAY, method: 'Cash' });
    check('leader records a part payment', pay1.status === 200);
    check('overpaying is refused', (await leaderA2('POST', '/api/salaries/payments', { refId: empId, period: PERIOD, amount: 500, paidDate: TODAY })).status === 400);
    check('future date refused', (await leaderA2('POST', '/api/salaries/payments', { refId: empId, period: PERIOD, amount: 10, paidDate: ymd(offset(2)) })).status === 400);
    const sal = (await leaderA2('GET', `/api/salaries?period=${PERIOD}`)).data;
    const row = sal.rows.find((r) => r.refId === empId);
    check('leader sees due / paid / remaining / status', sal.rows.length === 1 && row.due === 1000 && row.paid === 600 && row.remaining === 400 && row.status === 'partial' && row.pending === 1, JSON.stringify(row).slice(0, 200));
    const member2 = client();
    await member2('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: empId, pin: created.data.pin });
    check('member sees own salary payments', (await member2('GET', '/api/salaries/me')).data.awaitingConfirmation === 1);
    const myPay = (await member2('GET', '/api/salaries/me')).data.months[0].payments[0];
    check('dispute needs a reason', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'disputed' })).status === 400);
    check('member says not received', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'disputed', note: 'Got only 500' })).status === 200);
    check('leader sees the dispute', (await leaderA2('GET', `/api/salaries?period=${PERIOD}`)).data.totals.disputed === 1);
    check('leader corrects the payment', (await leaderA2('PUT', `/api/salaries/payments/${myPay.id}`, { amount: 500, paidDate: TODAY, method: 'Cash' })).status === 200);
    check('member confirms received', (await member2('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'confirmed' })).status === 200);
    check('confirmed payment is locked', (await leaderA2('DELETE', `/api/salaries/payments/${myPay.id}`)).status === 400);
    check('another person cannot confirm it', (await leaderB('POST', `/api/salaries/payments/${myPay.id}/confirm`, { status: 'confirmed' })).status === 403);
    check('head sets a team leader salary and pays', (await hodNew('PUT', '/api/salaries/rate', { refId: la.data.id, amount: 2000 })).status === 200);
    const lp = await hodNew('POST', '/api/salaries/payments', { refId: la.data.id, period: PERIOD, amount: 1500, paidDate: TODAY, method: 'Bank transfer' });
    check('head pays a team leader', lp.status === 200);
    const mine = (await leaderA2('GET', '/api/salaries/me')).data;
    check('team leader sees own salary awaiting confirmation', mine.awaitingConfirmation === 1 && mine.monthlySalary === 2000, JSON.stringify(mine).slice(0, 200));
    check('team leader confirms', (await leaderA2('POST', `/api/salaries/payments/${lp.data.id}/confirm`, { status: 'confirmed' })).status === 200);
    check('head sees leaders and members in the salary list', (await hodNew('GET', `/api/salaries?period=${PERIOD}`)).data.rows.length === 5 && (await hodNew('GET', `/api/salaries?period=${PERIOD}&role=team_leader`)).data.rows.length === 3);
    check('head cannot pay the head', (await hodNew('PUT', '/api/salaries/rate', { refId: head.data.id, amount: 3000 })).status === 403);
    check('admin sets and pays the head', (await admin('PUT', '/api/salaries/rate', { refId: head.data.id, amount: 3000 })).status === 200);
    const hp = await admin('POST', '/api/salaries/payments', { refId: head.data.id, period: PERIOD, amount: 3000, paidDate: TODAY });
    check('admin pays the head', hp.status === 200);
    check('head confirms the salary', (await hodNew('POST', `/api/salaries/payments/${hp.data.id}/confirm`, { status: 'confirmed' })).status === 200);
    check('salaries CSV export', (await admin('GET', `/api/salaries?period=${PERIOD}&format=csv`)).data.includes('Hamza Head'));
    const cf2 = (await admin('GET', `/api/company-finance/summary?from=${YESTERDAY}&to=${TODAY}`)).data.totals;
    check('salaries flow into company finance', cf2.salariesPaid === 500 + 1500 + 3000, JSON.stringify(cf2));

    console.log('Choosing PINs');
    const weak = ['123456', '111111', '000000', '654321', '12345', 'abcdef', '1234567'];
    let weakRefused = true;
    for (const pw of weak) if ((await leaderA2('POST', '/api/employees', { name: 'Weak PIN', joinDate: '2026-10-01', pin: pw })).status !== 400) weakRefused = false;
    check('easy or malformed PINs are refused', weakRefused);
    const chosen = await leaderA2('POST', '/api/employees', { name: 'Chosen Pin', designation: 'Support', joinDate: '2026-10-01', pin: '482913' });
    check('leader sets a member PIN while adding them', chosen.status === 200 && chosen.data.pin === '482913');
    const pinLogin = (pin) => client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: chosen.data.id, pin });
    check('member signs in with the PIN the leader chose', (await pinLogin('482913')).status === 200);
    check('reset to another chosen PIN', (await leaderA2('POST', `/api/employees/${chosen.data.id}/reset-pin`, { pin: '739104' })).data.pin === '739104');
    check('old PIN stops working, new works', (await pinLogin('482913')).status === 401 && (await pinLogin('739104')).status === 200);
    check('empty PIN still generates one', /^\d{6}$/.test((await leaderA2('POST', `/api/employees/${chosen.data.id}/reset-pin`, {})).data.pin));
    check('weak PIN refused on reset', (await leaderA2('POST', `/api/employees/${chosen.data.id}/reset-pin`, { pin: '222222' })).status === 400);
    check('another team\'s leader cannot reset a PIN', (await leaderB('POST', `/api/employees/${chosen.data.id}/reset-pin`, { pin: '739104' })).status === 403);
    check('PINs do not exist for leaders', (await hodNew('POST', `/api/employees/${la.data.id}/reset-pin`, {})).status === 400);
    await leaderA2('PUT', `/api/employees/${chosen.data.id}`, { name: 'Chosen Pin', joinDate: '2026-10-01', status: 'inactive' });

    console.log('Notifications');
    const leaderNotes = (await leaderA2('GET', '/api/notifications?limit=100')).data;
    check('leader notified when member checks in and out', leaderNotes.items.some((n) => /Ali Raza checked in/.test(n.title)) && leaderNotes.items.some((n) => /Ali Raza checked out/.test(n.title)));
    check('leader notified of leave request and finished task', leaderNotes.items.some((n) => /requested leave/.test(n.title)) && leaderNotes.items.some((n) => /submitted a task for approval/.test(n.title)));
    const hodNotes = (await hodNew('GET', '/api/notifications?limit=100')).data;
    check('head notified when a team leader checks in', hodNotes.items.some((n) => /Lina Lead checked in/.test(n.title)));
    check('head notified of the leader\'s leave request and task', hodNotes.items.some((n) => /Lina Lead requested leave/.test(n.title)) && hodNotes.items.some((n) => /Lina Lead submitted a task for approval/.test(n.title)));
    const adminNotes = (await admin('GET', '/api/notifications?limit=100')).data;
    check('admin notified of leader and head attendance', adminNotes.items.some((n) => /Lina Lead checked in/.test(n.title)) && adminNotes.items.some((n) => /Hamza Head checked in/.test(n.title)));
    check('admin notified of the head\'s leave request', adminNotes.items.some((n) => /Hamza Head requested leave/.test(n.title)));
    const memberNotes = (await member2('GET', '/api/notifications?limit=100')).data;
    check('member notified of task, approvals and salary', memberNotes.items.some((n) => /New task assigned/.test(n.title)) && memberNotes.items.some((n) => /Attendance approved/.test(n.title))
      && memberNotes.items.some((n) => /leave was approved/.test(n.title)) && memberNotes.items.some((n) => /Salary payment recorded/.test(n.title)));
    check('team leader notified of the head\'s task and of their salary', (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /A task|New task/.test(n.title)) && (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Salary payment recorded/.test(n.title)));
    check('notifications are private', !memberNotes.items.some((n) => /checked in/.test(n.title)) && (await leaderZ('GET', '/api/notifications')).data.items.every((n) => !/Ali Raza/.test(n.title)));
    check('mark notifications read', (await leaderA2('POST', '/api/notifications/read', { all: true })).status === 200 && (await leaderA2('GET', '/api/notifications')).data.unread === 0);

    console.log('Member orders');
    check('leader cannot report orders as a member', (await leaderA2('POST', '/api/orders', { date: TODAY, orders: 5 })).status === 403);
    check('member needs something to report', (await member2('POST', '/api/orders', { date: TODAY })).status === 400);
    const ord = await member2('POST', '/api/orders', { date: TODAY, market: 'Amazon US', store: 'Main store', orders: 12, investment: 300, revenue: 900, note: 'Busy day, two buyers asked for refunds' });
    check('member sends a daily report: market, store name, orders, purchasing cost, total sales, notes', ord.status === 200);
    check('market and notes are kept', (await member2('GET', `/api/orders/me?from=${TODAY}&to=${TODAY}`)).data.rows[0].market === 'Amazon US' && (await member2('GET', `/api/orders/me?from=${TODAY}&to=${TODAY}`)).data.rows[0].note.includes('refunds'));
    await member2('POST', '/api/orders', { date: YESTERDAY, orders: 8, investment: 100, revenue: 400 });
    const bm = client();
    await bm('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'BetaTeam-Pass-1', employeeId: bina.data.id, pin: bina.data.pin });
    await bm('POST', '/api/orders', { date: TODAY, orders: 3, investment: 50, revenue: 150 });
    const mine2 = (await member2('GET', `/api/orders/me?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('member sees own totals', mine2.totals.orders === 20 && mine2.totals.revenue === 1300 && mine2.totals.profit === 900, JSON.stringify(mine2.totals));
    const lo = (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('team leader sees only own team\'s orders', lo.totals.orders === 20 && lo.byEmployee.length === 1 && lo.byEmployee[0].name === 'Ali Raza');
    const ho = (await hodNew('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data;
    check('head sees all teams with a team breakdown', ho.totals.orders === 23 && ho.byTeam.length === 2 && ho.byEmployee.length === 2);
    check('admin sees member orders', (await admin('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.revenue === 1450);
    check('other department sees none', (await leaderZ('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 0);
    check('member cannot open the orders list', (await member2('GET', '/api/orders')).status === 403);
    check('orders CSV export uses the new column names', (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Main store') && (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Purchasing cost') && (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Amazon US'));
    check('search finds a report by market', (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&search=Amazon`)).data.totals.orders === 12);
    check('member edits own entry', (await member2('PUT', `/api/orders/${ord.data.id}`, { date: TODAY, orders: 14, investment: 300, revenue: 950 })).status === 200);

    console.log('Complaints');
    check('member cannot file complaints', (await member2('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', description: 'x' })).status === 403);
    check('another team\'s leader cannot file', (await leaderB('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', description: 'x' })).status === 403);
    check('a leader cannot file about a leader', (await leaderB('POST', '/api/complaints', { employeeId: la.data.id, category: 'Behaviour', description: 'x' })).status === 403);
    const cp = await leaderA2('POST', '/api/complaints', { employeeId: empId, category: 'Missed deadline', severity: 'high', description: 'Listings were not finished on time', incidentDate: YESTERDAY });
    check('team leader files a complaint', cp.status === 200);
    check('unknown category refused', (await leaderA2('POST', '/api/complaints', { employeeId: empId, category: 'Nope', description: 'x' })).status === 400);
    const mc = (await member2('GET', '/api/complaints/me')).data;
    check('member sees the complaint about them', mc.length === 1 && mc[0].filedBy.includes('Team Leader'));
    check('member, head and admin are notified', (await member2('GET', '/api/notifications')).data.items.some((n) => /complaint was filed about you/.test(n.title))
      && (await hodNew('GET', '/api/notifications')).data.items.some((n) => /filed a complaint about Ali Raza/.test(n.title))
      && (await admin('GET', '/api/notifications')).data.items.some((n) => /filed a complaint about Ali Raza/.test(n.title)));
    const hc = await hodNew('POST', '/api/complaints', { employeeId: empId, category: 'Behaviour', severity: 'low', description: 'Rude to a colleague' });
    check('head can also file about a member (leader is told)', hc.status === 200 && (await leaderA2('GET', '/api/notifications')).data.items.some((n) => /Hamza Head.*filed a complaint/.test(n.title)));
    const hcl = await hodNew('POST', '/api/complaints', { employeeId: la.data.id, category: 'Work quality', severity: 'medium', description: 'Weekly report was late' });
    check('head files a complaint about a team leader', hcl.status === 200);
    const lc2 = (await leaderA2('GET', '/api/complaints/me')).data;
    check('leader sees the complaint about them and replies', lc2.length === 1 && (await leaderA2('POST', `/api/complaints/${hcl.data.id}/respond`, { response: 'Printer was down' })).status === 200
      && (await hodNew('GET', '/api/notifications')).data.items.some((n) => /Lina Lead replied/.test(n.title)));
    check('admin files about the head', (await admin('POST', '/api/complaints', { employeeId: head.data.id, category: 'Other', description: 'Test' })).status === 200 && (await hodNew('GET', '/api/complaints/me')).data.length === 1);
    check('a leader cannot read the complaint about themselves in the team list', (await leaderA2('GET', '/api/complaints')).data.every((c) => c.employeeId === empId));
    check('member replies to the complaint', (await member2('POST', `/api/complaints/${cp.data.id}/respond`, { response: 'There was a power cut that day' })).status === 200);
    check('leader is told about the reply', (await leaderA2('GET', '/api/notifications')).data.items.some((n) => /Ali Raza replied to a complaint/.test(n.title)));
    check('leader resolves the complaint', (await leaderA2('PUT', `/api/complaints/${cp.data.id}`, { status: 'resolved', resolutionNote: 'Warning given' })).status === 200);
    check('member told it was resolved', (await member2('GET', '/api/notifications')).data.items.some((n) => /resolved/.test(n.title)));
    check('complaints list + CSV', (await leaderA2('GET', `/api/complaints?employeeId=${empId}`)).data.length === 2 && (await leaderA2('GET', '/api/complaints?format=csv')).data.includes('Missed deadline'));
    check('only admin can delete a complaint', (await leaderA2('DELETE', `/api/complaints/${cp.data.id}`)).status === 403 && (await hodNew('DELETE', `/api/complaints/${cp.data.id}`)).status === 403);

    console.log('Complaints & issues raised by employees');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    check('a member can write to leader, head or admin', (await member2('GET', '/api/issues/recipients')).data.map((r) => r.role).join() === 'leader,hod,admin');
    check('a leader can write to head or admin, a head to the admin', (await leaderA2('GET', '/api/issues/recipients')).data.map((r) => r.role).join() === 'hod,admin' && (await hodNew('GET', '/api/issues/recipients')).data.map((r) => r.role).join() === 'admin');
    const base = { recipient: 'leader', category: 'Store/Account Related', priority: 'urgent', subject: 'Store suspended', details: 'My store got a suspension notice today.', storeName: 'Main store' };
    check('required fields are checked', (await member2('POST', '/api/issues', { ...base, subject: '' })).status === 400 && (await member2('POST', '/api/issues', { ...base, category: 'Nope' })).status === 400 && (await member2('POST', '/api/issues', { ...base, recipient: 'nobody' })).status === 400);
    check('only pictures and PDFs up to 1 MB are accepted', (await member2('POST', '/api/issues', { ...base, attachments: [{ name: 'a.png', data: Buffer.from('not a picture at all, just text').toString('base64') }] })).status === 400
      && (await member2('POST', '/api/issues', { ...base, attachments: [{ name: 'big.png', data: 'A'.repeat(1_500_000) }] })).status === 400
      && (await member2('POST', '/api/issues', { ...base, attachments: [1, 2, 3, 4].map(() => ({ name: 'x.png', data: PNG })) })).status === 400);
    const iss = await member2('POST', '/api/issues', { ...base, attachments: [{ name: 'screenshot.png', data: PNG }] });
    check('member submits an urgent complaint with an attachment to the team leader', iss.status === 200);
    const iid = iss.data.id;
    check('the leader is notified (urgent)', (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /URGENT: New complaint from Ali Raza/.test(n.title)));
    check('it is in the leader\'s inbox and in the member\'s submitted list', (await leaderA2('GET', '/api/issues')).data.some((i) => i.id === iid && i.submitterName === 'Ali Raza') && (await member2('GET', '/api/issues/me')).data[0].sentTo === 'Lina Lead');
    check('PRIVATE: another team\'s leader and the head are not shown it', (await leaderB('GET', '/api/issues')).data.length === 0 && (await hodNew('GET', '/api/issues')).data.length === 0
      && (await leaderB('GET', `/api/issues/${iid}`)).status === 404 && (await hodNew('GET', `/api/issues/${iid}`)).status === 404 && (await bm('GET', `/api/issues/${iid}`)).status === 404);
    check('PRIVATE: attachments follow the same rule', (await leaderB('GET', `/api/issues/${iid}/files/1`)).status === 404 && (await hodNew('GET', `/api/issues/${iid}/files/1`)).status === 404);
    const detail = (await leaderA2('GET', `/api/issues/${iid}`)).data;
    check('the leader can open it, with the attachment', detail.canRespond && detail.files.length === 1 && detail.files[0].mime === 'image/png' && detail.storeName === 'Main store');
    const dl = await leaderA2('GET', `/api/issues/${iid}/files/${detail.files[0].id}`);
    check('the attachment downloads as a file (not shown inline)', dl.status === 200 && dl.headers.get('content-type') === 'image/png' && /attachment/.test(dl.headers.get('content-disposition')));
    check('the admin can open every complaint', (await admin('GET', `/api/issues/${iid}`)).status === 200);
    check('the member cannot change the status', (await member2('POST', `/api/issues/${iid}/messages`, { body: 'hello', status: 'resolved' })).status === 403);
    check('the leader replies and the status moves to "In review"', (await leaderA2('POST', `/api/issues/${iid}/messages`, { body: 'Looking into it with the admin' })).data.status === 'in_review');
    check('the member is notified of the reply and sees the thread', (await member2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Your complaint is now "In review"/.test(n.title)) && (await member2('GET', `/api/issues/${iid}`)).data.messages.length === 1);
    check('the leader resolves it', (await leaderA2('POST', `/api/issues/${iid}/messages`, { body: 'Appeal sent, store restored', status: 'resolved' })).data.status === 'resolved' && (await member2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Your complaint is now "Resolved"/.test(n.title)));
    check('a follow-up from the member reopens it and tells the leader', (await member2('POST', `/api/issues/${iid}/messages`, { body: 'It is suspended again' })).data.status === 'open' && (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Ali Raza replied to their complaint/.test(n.title)));
    check('an empty reply is refused', (await member2('POST', `/api/issues/${iid}/messages`, { body: '' })).status === 400);
    const toAdmin = await member2('POST', '/api/issues', { recipient: 'admin', category: 'Team/Workplace', priority: 'normal', subject: 'About my senior', details: 'Private matter.' });
    check('a member can go straight to the admin', toAdmin.status === 200 && (await admin('GET', '/api/notifications?limit=100')).data.items.some((n) => /New complaint from Ali Raza/.test(n.title)));
    check('PRIVATE: nobody but the admin sees a complaint sent to the admin', (await leaderA2('GET', `/api/issues/${toAdmin.data.id}`)).status === 404 && (await hodNew('GET', `/api/issues/${toAdmin.data.id}`)).status === 404
      && !(await leaderA2('GET', '/api/issues')).data.some((i) => i.id === toAdmin.data.id) && (await admin('GET', '/api/issues')).data.length === 2 && (await admin('GET', '/api/dashboard')).data.pending.issues === 1);
    const lToHead = await leaderA2('POST', '/api/issues', { recipient: 'hod', category: 'General', subject: 'Need a second monitor', details: 'For the team.' });
    check('a leader writes to the head, who answers', lToHead.status === 200 && (await hodNew('GET', '/api/issues')).data.length === 1 && (await hodNew('POST', `/api/issues/${lToHead.data.id}/messages`, { body: 'Approved', status: 'resolved' })).status === 200
      && (await leaderA2('GET', '/api/issues/me')).data[0].status === 'resolved');
    check('a leader or member cannot write to someone they should not', (await leaderA2('POST', '/api/issues', { recipient: 'leader', category: 'General', subject: 's', details: 'd' })).status === 400 && (await hodNew('POST', '/api/issues', { recipient: 'hod', category: 'General', subject: 's', details: 'd' })).status === 400);
    check('the head writes to the admin', (await hodNew('POST', '/api/issues', { recipient: 'admin', category: 'Technical', subject: 'Printer', details: 'Broken' })).status === 200);
    check('inbox filters work', (await admin('GET', '/api/issues?priority=urgent')).data.length === 1 && (await admin('GET', '/api/issues?status=resolved')).data.length === 1 && (await admin('GET', '/api/issues?search=Printer')).data.length === 1);
    check('a member has no inbox', (await member2('GET', '/api/issues')).status === 403);

    console.log('Member reports');
    const rep = (await leaderA2('GET', `/api/reports/employee/${empId}?from=${TWO_AGO}&to=${TODAY}`)).data;
    check('report has attendance, orders, sales, tasks and complaints', rep.metrics && rep.orders.orders === 22 && rep.orders.sales === 1350 && rep.complaints.length === 2 && Array.isArray(rep.tasks), JSON.stringify({ o: rep.orders.orders, c: rep.complaints.length }));
    check('report shows complaint counts in the summary row', rep.metrics.complaints >= 1);
    check('other team cannot read the report', (await leaderB('GET', `/api/reports/employee/${empId}?from=${TWO_AGO}&to=${TODAY}`)).status === 403);
    check('head reads any report in the department, not another department\'s', (await hodNew('GET', `/api/reports/employee/${bina.data.id}?from=${TWO_AGO}&to=${TODAY}`)).status === 200
      && (await hodNew('GET', `/api/reports/employee/${zita.data.id}?from=${TWO_AGO}&to=${TODAY}`)).status === 403);
    check('head reads a team leader report', (await hodNew('GET', `/api/reports/employee/${la.data.id}?from=${TWO_AGO}&to=${TODAY}`)).data.employee.role === 'team_leader');
    check('member reads own report', (await member2('GET', `/api/reports/me?from=${TWO_AGO}&to=${TODAY}`)).data.employee.id === empId);
    check('leader reads own report', (await leaderA2('GET', `/api/reports/me?from=${TWO_AGO}&to=${TODAY}`)).data.employee.id === la.data.id);
    const all = (await leaderA2('GET', `/api/reports/members?from=${TWO_AGO}&to=${TODAY}`)).data.rows;
    check('all-members report is the leader\'s team only', all.length === 1 && all[0].sales === 1350);
    check('head\'s members report has leaders and all teams', (await hodNew('GET', `/api/reports/members?from=${TWO_AGO}&to=${TODAY}`)).data.rows.length === 5);
    check('all-members CSV', (await leaderA2('GET', `/api/reports/members?from=${TWO_AGO}&to=${TODAY}&format=csv`)).data.includes('Complaints'));

    console.log('Reports & dashboards');
    for (const level of ['employee', 'team', 'department']) {
      const r = await admin('GET', `/api/reports/performance?level=${level}&from=${TWO_AGO}&to=${TODAY}`);
      check(`performance (${level})`, r.status === 200 && r.data.rows.length >= 1, JSON.stringify(r.data).slice(0, 200));
    }
    check('head sees team performance for the teams that have members', (await hodNew('GET', `/api/reports/performance?level=team&from=${TWO_AGO}&to=${TODAY}`)).data.rows.length === 2);
    const dash = (await admin('GET', '/api/dashboard')).data;
    check('admin dashboard', dash.departments.length === 6 && dash.today.present >= 1 && dash.departments.find((d) => d.id === ebayId).head === 'Hamza Head');
    const hd = (await hodNew('GET', '/api/dashboard')).data;
    check('head dashboard lists every team with its leader', hd.teams.length === 3 && hd.teams.find((t) => t.name === 'Alpha').leaderName === 'Lina Lead' && hd.departments === null);
    check('head dashboard only counts own department', hd.today.employees === 5, JSON.stringify(hd.today));
    const ld = (await leaderA2('GET', '/api/dashboard')).data;
    check('leader dashboard is just the team', ld.teams === null && ld.departments === null && ld.today.employees === 1);
    check('member dashboard', (await member('GET', '/api/dashboard/me')).status === 200);
    check('leader and head have a personal dashboard', (await leaderA2('GET', '/api/dashboard/me')).status === 200 && (await hodNew('GET', '/api/dashboard/me')).status === 200);
    check('performance CSV', (await admin('GET', '/api/reports/performance?level=employee&format=csv')).data.includes('Attendance %'));

    console.log('Transfers: a member moves to another team and keeps everything');
    const before = (await leaderA2('GET', `/api/employees/${empId}`)).data;
    const rq = await leaderA2('POST', '/api/transfers', { employeeId: empId, toTeamId: tB, reason: 'Needs support skills' });
    check('leader asks for a transfer (waits for the head)', rq.status === 200 && rq.data.status === 'pending');
    check('a second pending request for the same person is refused', (await leaderA2('POST', '/api/transfers', { employeeId: empId, toTeamId: tC })).status === 400);
    check('head and destination leader are notified', (await hodNew('GET', '/api/notifications')).data.items.some((n) => /Transfer request/.test(n.title)) && (await leaderB('GET', '/api/notifications')).data.items.some((n) => /Transfer request/.test(n.title)));
    check('leader cannot approve a transfer', (await leaderA2('PUT', `/api/transfers/${rq.data.id}/approve`, {})).status === 403 && (await leaderB('PUT', `/api/transfers/${rq.data.id}/approve`, {})).status === 403);
    check('the request is visible to both leaders', (await leaderA2('GET', '/api/transfers')).data.length === 1 && (await leaderB('GET', '/api/transfers')).data.length === 1 && (await leaderC2('GET', '/api/transfers')).data.length === 0);
    const appr = await hodNew('PUT', `/api/transfers/${rq.data.id}/approve`, { note: 'OK' });
    check('head approves the transfer', appr.status === 200 && appr.data.pin === null);
    const after = (await leaderB('GET', `/api/employees/${empId}`)).data;
    check('member is now in Beta and the new leader can open the profile', after.teamId === tB && after.teamName === 'Beta');
    check('the old leader no longer sees them', (await leaderA2('GET', `/api/employees/${empId}`)).status === 403 && (await actives(leaderA2)).data.length === 0);
    check('full history moved along (joined + changes + transfer)', after.history.length === before.history.length + 1 && after.history.some((h) => h.eventType === 'joined') && after.history.some((h) => h.eventType === 'team_change'));
    check('old attendance is now in the new team', (await leaderB('GET', `/api/attendance?from=${TWO_AGO}&to=${TODAY}`)).data.some((r) => r.employeeId === empId) && (await leaderA2('GET', `/api/attendance?from=${TWO_AGO}&to=${TODAY}`)).data.every((r) => r.employeeId !== empId));
    check('orders, tasks, leave and complaints follow the person', (await leaderB('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 25
      && (await leaderB('GET', '/api/tasks')).data.some((t) => t.assigneeName === 'Ali Raza') && (await leaderB('GET', '/api/leave')).data.some((l) => l.employeeId === empId)
      && (await leaderB('GET', `/api/complaints?employeeId=${empId}`)).data.length === 2);
    check('the member\'s report moves too', (await leaderB('GET', `/api/reports/employee/${empId}?from=${TWO_AGO}&to=${TODAY}`)).data.orders.orders === 22);
    check('old session ended, old team password stops working', (await member2('GET', '/api/orders/me')).status === 401
      && (await client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: empId, pin: created.data.pin })).status === 401);
    const aliB = client();
    check('member signs in to the new team with the same PIN', (await aliB('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'BetaTeam-Pass-1', employeeId: empId, pin: created.data.pin })).status === 200);
    check('the member is told', (await aliB('GET', '/api/notifications')).data.items.some((n) => /moved to another team/.test(n.title)));
    const back = await hodNew('POST', '/api/transfers', { employeeId: empId, toTeamId: tA, reason: 'Back again' });
    check('head moves a member between teams directly', back.data.status === 'done' && (await leaderA2('GET', `/api/employees/${empId}`)).status === 200);
    const cross = await hodNew('POST', '/api/transfers', { employeeId: empId, toTeamId: tZ, reason: 'Amazon needs help' });
    check('a move to another department waits for the admin', cross.data.status === 'pending' && (await hodNew('PUT', `/api/transfers/${cross.data.id}/approve`, {})).status === 403);
    check('admin sees it and approves', (await admin('GET', '/api/transfers?status=pending')).data.some((t) => t.id === cross.data.id && t.canDecide) && (await admin('PUT', `/api/transfers/${cross.data.id}/approve`, {})).status === 200);
    const moved = (await hod2('GET', `/api/employees/${empId}`)).data;
    check('the person now belongs to Amazon with the whole history', moved.departmentId === amazonId && moved.teamName === 'Zeta' && moved.history.filter((h) => h.eventType === 'transfer').length === 1 && moved.history.some((h) => h.eventType === 'joined'));
    check('eBay\'s head no longer sees them, Amazon\'s head does', (await hodNew('GET', `/api/employees/${empId}`)).status === 403 && (await hod2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}`)).data.totals.orders === 22);
    const aliZ = client();
    check('they sign in to the Amazon team', (await aliZ('POST', '/api/auth/login', { portal: 'member', departmentId: amazonId, password: 'ZetaTeam-Pass-1', employeeId: empId, pin: created.data.pin })).status === 200);
    const selfAsk = await aliZ('POST', '/api/transfers', { toTeamId: tA, reason: 'I want to go back' });
    check('a member can ask to move themselves', selfAsk.data.status === 'pending' && (await aliZ('GET', '/api/transfers')).data.length >= 2);
    check('the leader of the current team cannot approve it', (await leaderZ('PUT', `/api/transfers/${selfAsk.data.id}/approve`, {})).status === 403);
    check('another member cannot cancel it, the requester can', (await bm('DELETE', `/api/transfers/${selfAsk.data.id}`)).status === 403 && (await aliZ('DELETE', `/api/transfers/${selfAsk.data.id}`)).status === 200);
    const rej = await aliZ('POST', '/api/transfers', { toTeamId: tA, reason: 'Again' });
    check('admin can decline a request', (await admin('PUT', `/api/transfers/${rej.data.id}/reject`, { note: 'Not now' })).status === 200 && (await aliZ('GET', '/api/transfers')).data.find((t) => t.id === rej.data.id).status === 'rejected');
    check('a team with members cannot be deleted', (await hod2('DELETE', `/api/teams/${tZ}`)).status === 400);

    console.log('Stepping down');
    check('leader steps down: becomes a member without a team', (await hodNew('DELETE', `/api/teams/${tC}/leader`)).status === 200);
    const stepped = (await hodNew('GET', '/api/employees?unassigned=1')).data;
    check('the former leader appears under "no team"', stepped.length === 1 && stepped[0].id === lc.data.id && stepped[0].role === 'member');
    check('the old leader password is dead', (await as('leader', ebayId, 'LeadC-Admin-Pass3')).login.status === 401 && (await leaderC2('GET', '/api/employees/me')).status === 401);
    const place = await hodNew('POST', '/api/transfers', { employeeId: lc.data.id, toTeamId: tC });
    check('a transfer places them in a team and gives a PIN', place.data.status === 'done' && /^\d{6}$/.test(place.data.pin));
    check('they can now sign in as a member of Gamma', (await client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'GammaTeam-Pass1', employeeId: lc.data.id, pin: place.data.pin })).status === 200);
    check('new leader for Gamma', (await hodNew('POST', `/api/teams/${tC}/leader`, { employeeId: lc.data.id, password: 'LeadC-Again-Pass4' })).status === 200 && (await as('leader', ebayId, 'LeadC-Again-Pass4')).login.status === 200);

    console.log('Admin, logs, backups');
    const logs = (await admin('GET', '/api/logs')).data;
    check('activity log captured actions', logs.length > 10 && logs.some((l) => l.action === 'login') && logs.some((l) => l.action === 'login_failed') && logs.some((l) => l.action === 'transfer') && logs.some((l) => l.action === 'password_changed'));
    check('head sees only own department log; leaders have none', (await hodNew('GET', '/api/logs')).data.every((l) => l.departmentId === ebayId) && (await leaderA2('GET', '/api/logs')).status === 403);
    check('manual backup', (await admin('POST', '/api/backups')).status === 200);
    check('backup list', (await admin('GET', '/api/backups')).data.length >= 2);
    check('backups admin only', (await hodNew('GET', '/api/backups')).status === 403);
    check('disable a module', (await admin('PUT', '/api/modules/finance', { enabled: false })).status === 200 && (await leaderA2('GET', '/api/finance')).status === 404);
    await admin('PUT', '/api/modules/finance', { enabled: true });
    check('deactivated employee loses access', (await hodNew('PUT', `/api/employees/${bina.data.id}`, { ...(await hodNew('GET', `/api/employees/${bina.data.id}`)).data, status: 'inactive' })).status === 200 && (await bm('GET', '/api/attendance/me/today')).status === 401);
    check('logout', (await leaderA2('POST', '/api/auth/logout')).status === 200 && (await leaderA2('GET', '/api/employees')).status === 401);

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
    const pushLeader = await as('leader', ebayId, 'LeadA-NewPass-2');
    check('server gives the browser its VAPID public key', (await pushLeader('GET', '/api/push/key')).data.key.length === 87);
    check('anonymous cannot get the push key', (await anon('GET', '/api/push/key')).status === 401);
    const subBody = { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint', keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } } };
    check('subscription to an unknown host is refused', (await pushLeader('POST', '/api/push/subscribe', { subscription: { ...subBody.subscription, endpoint: 'https://127.0.0.1/x' } })).status === 400);
    check('subscription with bad keys is refused', (await pushLeader('POST', '/api/push/subscribe', { subscription: { ...subBody.subscription, keys: { p256dh: 'abc', auth: 'abc' } } })).status === 400);
    check('device subscribes', (await pushLeader('POST', '/api/push/subscribe', subBody)).status === 200);
    check('device unsubscribes (sign-out)', (await pushLeader('POST', '/api/push/unsubscribe', { endpoint: subBody.subscription.endpoint })).status === 200);
    check('test notification for a leader, the head and the admin', (await pushLeader('POST', '/api/push/test')).status === 200 && (await pushLeader('GET', '/api/notifications')).data.items[0].title === 'Test notification'
      && (await hodNew('POST', '/api/push/test')).status === 200 && (await admin('POST', '/api/push/test')).status === 200);

    console.log('Brute force lock');
    const attacker = client();
    let last;
    for (let i = 0; i < 7; i++) last = await attacker('POST', '/api/auth/login', { portal: 'admin', password: 'guessguess' + i });
    check('locked after repeated failures', last.status === 429);
    const guesser = client();
    let lastLeader;
    for (let i = 0; i < 7; i++) lastLeader = await guesser('POST', '/api/auth/login', { portal: 'leader', departmentId: amazonId, password: 'guess-guess-' + i });
    check('leader portal is locked too', lastLeader.status === 429);
  } finally {
    await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows may keep the file locked briefly; temp folder is harmless */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
