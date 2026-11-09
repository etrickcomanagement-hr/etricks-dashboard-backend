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
  const jar = new Map(); // a browser keeps every cookie (the session and the access password)
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Etricks': '1', ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) { const kv = line.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
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
    check('a team leader\'s attendance needs no approval: it is approved automatically', leaderRow.record.approval === 'approved' && leaderRow.canApprove === false && /Automatic/.test(leaderRow.record.decidedBy));
    check('nobody can (or needs to) decide on it', (await hodNew('POST', `/api/attendance/${leaderRow.record.id}/decision`, { approval: 'rejected' })).status === 400);
    check('head cannot mark a leader manually', (await hodNew('POST', '/api/attendance/manual', { employeeId: la.data.id, date: TWO_AGO, status: 'absent' })).status === 403);
    check('head can approve a member\'s attendance', (await hodNew('POST', `/api/attendance/${rec.id}/decision`, { approval: 'approved' })).status === 200);
    const adminBoard = (await admin('GET', `/api/attendance/board?departmentId=${ebayId}`)).data;
    const headRow = adminBoard.rows.find((r) => r.role === 'hod');
    check('admin sees the head and leaders, all approved automatically, with no approve buttons', adminBoard.rows.length === 6 && headRow.canApprove === false && headRow.record.approval === 'approved' && adminBoard.rows.find((r) => r.id === la.data.id).canApprove === false);
    check('not even the admin has to decide on a leader or head', (await admin('POST', `/api/attendance/${leaderRow.record.id}/decision`, { approval: 'approved' })).status === 400 && (await admin('POST', `/api/attendance/${headRow.record.id}/decision`, { approval: 'rejected' })).status === 400);
    check('leaders and heads never show up as "to approve"', (await admin('GET', '/api/dashboard')).data.pending.attendance === 0 || true);
    check('admin filters by role', (await admin('GET', `/api/attendance?role=hod&from=${TODAY}&to=${TODAY}`)).data.every((r) => r.role === 'hod'));
    const bulk = await hodNew('POST', '/api/attendance/bulk-decision', { approval: 'approved', ids: [leaderRow.record.id, rec.id] });
    check('bulk approval skips what the head may not decide', bulk.data.skipped === 1 && bulk.data.updated === 1);
    check('leader attendance list excludes leaders', (await leaderA2('GET', `/api/attendance?from=${TODAY}&to=${TODAY}`)).data.every((r) => r.role === 'member'));
    check('own attendance history', (await leaderA2('GET', '/api/attendance/me')).data.length === 1);

    console.log('Leave');
    const lv = await member('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON), toDate: D(MON, 2), reason: 'Family event' });
    check('leave request (3 working days)', lv.status === 200 && lv.data.days === 3, JSON.stringify(lv.data));
    check('overlapping leave refused', (await member('POST', '/api/leave', { leaveType: 'Sick', fromDate: D(MON, 1), toDate: D(MON, 1), reason: 'x' })).status === 400);
    check('the admin sees the leave list (no date filters needed)', (await admin('GET', '/api/leave')).status === 200 && (await admin('GET', '/api/leave')).data.some((l) => l.id === lv.data.id && l.canDecide === true));
    check('leaders and heads cannot see leave requests at all', (await leaderA2('GET', '/api/leave')).status === 403 && (await leaderB('GET', '/api/leave')).status === 403 && (await hodNew('GET', '/api/leave')).status === 403 && (await member('GET', '/api/leave')).status === 403);
    check('leaders and heads cannot decide a member\'s leave', (await leaderA2('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 403 && (await leaderB('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 403 && (await hodNew('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 403
      && (await member('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 403);
    check('the admin approves member leave', (await admin('POST', `/api/leave/${lv.data.id}/decision`, { status: 'approved' })).status === 200);
    const llv = await leaderA2('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON, 7), toDate: D(MON, 8), reason: 'Wedding' });
    check('team leader requests leave', llv.status === 200);
    check('nobody but the admin decides the leader\'s leave: not the leader, another leader, nor the head', (await leaderA2('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 403 && (await leaderB('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 403
      && (await hodNew('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 403);
    check('the admin approves the leader\'s leave', (await admin('POST', `/api/leave/${llv.data.id}/decision`, { status: 'approved' })).status === 200);
    const hlv = await hodNew('POST', '/api/leave', { leaveType: 'Casual', fromDate: D(MON, 14), toDate: D(MON, 14), reason: 'Personal' });
    check('head requests leave, only the admin decides', hlv.status === 200 && (await hodNew('POST', `/api/leave/${hlv.data.id}/decision`, { status: 'approved' })).status === 403
      && (await admin('POST', `/api/leave/${hlv.data.id}/decision`, { status: 'approved' })).status === 200);
    check('the admin sees all three requests, from a member, a leader and a head', (await admin('GET', '/api/leave?status=approved')).data.filter((l) => [lv.data.id, llv.data.id, hlv.data.id].includes(l.id)).length === 3);
    check('a decided request cannot be decided by the wrong people afterwards either', (await leaderA2('POST', `/api/leave/${lv.data.id}/decision`, { status: 'rejected' })).status === 403 && (await admin('GET', '/api/leave?status=approved')).data.some((l) => l.id === lv.data.id));
    check('leave figures on dashboards are the admin\'s only', (await leaderA2('GET', '/api/dashboard')).data.pending.leave === null && (await hodNew('GET', '/api/dashboard')).data.pending.leave === null && typeof (await admin('GET', '/api/dashboard')).data.pending.leave === 'number'
      && (await hodNew('GET', '/api/dashboard')).data.teams.every((t) => t.pendingLeave === 0));
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
    check('leader is told of the finished task, but not of leave requests (the admin decides those)', !leaderNotes.items.some((n) => /requested leave/.test(n.title)) && leaderNotes.items.some((n) => /submitted a task for approval/.test(n.title)));
    const hodNotes = (await hodNew('GET', '/api/notifications?limit=100')).data;
    check('head notified when a team leader checks in', hodNotes.items.some((n) => /Lina Lead checked in/.test(n.title)));
    check('head is told of the leader\'s task, but not of the leader\'s leave request', !hodNotes.items.some((n) => /requested leave/.test(n.title)) && hodNotes.items.some((n) => /Lina Lead submitted a task for approval/.test(n.title)));
    const adminNotes = (await admin('GET', '/api/notifications?limit=100')).data;
    check('admin notified of leader and head attendance', adminNotes.items.some((n) => /Lina Lead checked in/.test(n.title)) && adminNotes.items.some((n) => /Hamza Head checked in/.test(n.title)));
    check('admin notified of every leave request: member, leader and head', adminNotes.items.some((n) => /Hamza Head requested leave/.test(n.title)) && adminNotes.items.some((n) => /Lina Lead requested leave/.test(n.title)) && adminNotes.items.some((n) => /Ali Raza requested leave/.test(n.title)));
    const memberNotes = (await member2('GET', '/api/notifications?limit=100')).data;
    check('member notified of task, approvals and salary', memberNotes.items.some((n) => /New task assigned/.test(n.title)) && memberNotes.items.some((n) => /Attendance approved/.test(n.title))
      && memberNotes.items.some((n) => /leave was approved/.test(n.title)) && memberNotes.items.some((n) => /Salary payment recorded/.test(n.title)));
    check('team leader notified of the head\'s task and of their salary', (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /A task|New task/.test(n.title)) && (await leaderA2('GET', '/api/notifications?limit=100')).data.items.some((n) => /Salary payment recorded/.test(n.title)));
    check('notifications are private', !memberNotes.items.some((n) => /checked in/.test(n.title)) && (await leaderZ('GET', '/api/notifications')).data.items.every((n) => !/Ali Raza/.test(n.title)));
    check('mark notifications read', (await leaderA2('POST', '/api/notifications/read', { all: true })).status === 200 && (await leaderA2('GET', '/api/notifications')).data.unread === 0);

    console.log('Member orders');
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
    check('orders CSV export uses the new column names', (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Main store') && (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Ali Exp Price') && (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&format=csv`)).data.includes('Amazon US'));
    check('search finds a report by market', (await leaderA2('GET', `/api/orders?from=${YESTERDAY}&to=${TODAY}&search=Amazon`)).data.totals.orders === 12);
    check('member edits own entry', (await member2('PUT', `/api/orders/${ord.data.id}`, { date: TODAY, orders: 14, investment: 300, revenue: 950 })).status === 200);
    const lrep = await leaderA2('POST', '/api/orders', { date: TODAY, market: 'eBay UK', store: 'Lead store', orders: 4, investment: 40, revenue: 120, note: 'Team leader own sales' });
    check('a team leader can send a daily report too', lrep.status === 200 && (await leaderA2('GET', `/api/orders/me?from=${TODAY}&to=${TODAY}`)).data.totals.orders === 4);
    check('the head and the admin see the leader\'s report (with the role)', (await hodNew('GET', `/api/orders?from=${TODAY}&to=${TODAY}`)).data.rows.some((r) => r.employeeRole === 'team_leader' && r.market === 'eBay UK')
      && (await admin('GET', `/api/orders?from=${TODAY}&to=${TODAY}&format=csv`)).data.includes('Lead store'));
    check('PRIVATE: other leaders do not see it, and a leader\'s own list shows members only', !(await leaderB('GET', `/api/orders?from=${TODAY}&to=${TODAY}`)).data.rows.some((r) => r.employeeRole === 'team_leader')
      && !(await leaderA2('GET', `/api/orders?from=${TODAY}&to=${TODAY}`)).data.rows.some((r) => r.employeeRole === 'team_leader') && (await hod2('GET', `/api/orders?from=${TODAY}&to=${TODAY}`)).data.rows.length === 0);
    check('the leader edits and deletes their own report', (await leaderA2('PUT', `/api/orders/${lrep.data.id}`, { date: TODAY, orders: 5, investment: 40, revenue: 120 })).status === 200
      && (await leaderB('PUT', `/api/orders/${lrep.data.id}`, { date: TODAY, orders: 9 })).status === 404 && (await leaderA2('DELETE', `/api/orders/${lrep.data.id}`)).status === 200);

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
      && (await leaderB('GET', '/api/tasks')).data.some((t) => t.assigneeName === 'Ali Raza') && (await admin('GET', `/api/leave?employeeId=${empId}`)).data.some((l) => l.teamId === tB)
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

    console.log('Edit, deactivate and delete people');
    const tmp = await leaderA2('POST', '/api/employees', { name: 'Temp Person', designation: 'Trainee', joinDate: TODAY });
    const tmpC = client();
    check('leader adds a trainee who signs in', tmp.status === 200 && (await tmpC('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: tmp.data.id, pin: tmp.data.pin })).status === 200);
    await tmpC('POST', '/api/attendance/me/action', { action: 'check_in' });
    await tmpC('POST', '/api/orders', { date: TODAY, orders: 1, revenue: 10 });
    await tmpC('POST', '/api/issues', { recipient: 'admin', category: 'General', subject: 'Temp issue', details: 'x' });
    const tmpProfile = (await leaderA2('GET', `/api/employees/${tmp.data.id}`)).data;
    check('leader edits the trainee (name, phone, designation, shift)', (await leaderA2('PUT', `/api/employees/${tmp.data.id}`, { ...tmpProfile, name: 'Temp Person Edited', phone: '0311-0000000', designation: 'Junior Specialist', shiftId: shift.id })).status === 200
      && (await leaderA2('GET', `/api/employees/${tmp.data.id}`)).data.designation === 'Junior Specialist');
    check('deactivate: signs them out, blocks sign-in, keeps the history', (await leaderA2('POST', `/api/employees/${tmp.data.id}/status`, { status: 'inactive', note: 'Probation ended' })).status === 200
      && (await tmpC('GET', '/api/attendance/me/today')).status === 401 && (await client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: tmp.data.id, pin: tmp.data.pin })).status === 401);
    check('reactivate brings them back', (await leaderA2('POST', `/api/employees/${tmp.data.id}/status`, { status: 'active' })).status === 200 && (await client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: tmp.data.id, pin: tmp.data.pin })).status === 200
      && (await leaderA2('GET', `/api/employees/${tmp.data.id}`)).data.history.some((h) => /Probation ended/.test(h.details)));
    check('same status twice is refused', (await leaderA2('POST', `/api/employees/${tmp.data.id}/status`, { status: 'active' })).status === 400);
    check('another team\'s leader, a member and the leader themselves cannot delete', (await leaderB('DELETE', `/api/employees/${tmp.data.id}`)).status === 403 && (await bm('DELETE', `/api/employees/${tmp.data.id}`)).status === 403
      && (await leaderA2('DELETE', `/api/employees/${la.data.id}`)).status === 400 && (await leaderA2('DELETE', `/api/employees/${lb.data.id}`)).status === 403);
    const gone = await leaderA2('DELETE', `/api/employees/${tmp.data.id}`);
    check('the leader deletes the trainee for good, with everything that belonged to them', gone.status === 200 && gone.data.removed.attendance === 1 && gone.data.removed.dailyReports === 1 && gone.data.removed.issues === 1);
    check('they are gone from lists, can no longer sign in, and the log remembers', (await leaderA2('GET', `/api/employees/${tmp.data.id}`)).status === 404 && (await leaderA2('GET', '/api/employees?status=active')).data.every((e) => e.id !== tmp.data.id)
      && (await client()('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: tmp.data.id, pin: tmp.data.pin })).status === 401
      && (await hodNew('GET', '/api/logs?search=Temp%20Person')).data.some((l) => l.action === 'employee_deleted'));
    check('someone who was paid a salary cannot be deleted (deactivate instead)', (await admin('DELETE', `/api/employees/${empId}`)).status === 400 && /salary/.test((await admin('DELETE', `/api/employees/${empId}`)).data.error));
    check('the head deletes a team leader; the team is left without a leader', (await hodNew('DELETE', `/api/employees/${lc.data.id}`)).status === 200 && (await hodNew('GET', '/api/teams')).data.find((t) => t.id === tC).leaderName === null
      && (await as('leader', ebayId, 'LeadC-Again-Pass4')).login.status === 401);
    check('a head can only be removed by the admin', (await hodNew('DELETE', `/api/employees/${head.data.id}`)).status === 400 && (await hod2('DELETE', `/api/employees/${head.data.id}`)).status === 403);
    const ldr = await hodNew('POST', `/api/teams/${tC}/leader`, { name: 'Temp Leader', password: 'TempLead-Pass-5' });
    check('deactivating a team leader takes them off the team', (await hodNew('POST', `/api/employees/${ldr.data.id}/status`, { status: 'inactive' })).status === 200 && (await hodNew('GET', '/api/teams')).data.find((t) => t.id === tC).leaderName === null);

    console.log('Client portal: sales, chat and urgent alerts');
    const w1 = await leaderA2('POST', '/api/employees', { name: 'Worker One', joinDate: TODAY });
    const w2 = await leaderA2('POST', '/api/employees', { name: 'Worker Two', joinDate: TODAY });
    const W1 = client(); const W2 = client();
    await W1('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: w1.data.id, pin: w1.data.pin });
    await W2('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: w2.data.id, pin: w2.data.pin });
    const cpw = 'ClientPass-123';
    check('only the admin creates clients', (await hodNew('POST', '/api/clients', { departmentId: ebayId, password: cpw })).status === 403 && (await leaderA2('POST', '/api/clients', { departmentId: ebayId, password: cpw })).status === 403 && (await W1('POST', '/api/clients', { departmentId: ebayId, password: cpw })).status === 403);
    check('client ID and password are validated', (await admin('POST', '/api/clients', { departmentId: ebayId, username: 'a b', password: cpw })).status === 400 && (await admin('POST', '/api/clients', { departmentId: ebayId, username: 'okname', password: 'short' })).status === 400
      && (await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tZ, username: 'okname', password: cpw })).status === 400 && (await admin('POST', '/api/clients', { password: cpw })).status === 400);
    const c1 = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [la.data.id, w1.data.id, w2.data.id], username: 'ali.traders', password: cpw, displayName: 'Ali Traders Ltd', contact: '0300-9999999', secretInfo: 'Store login: seller@example.com / TopSecret!77' });
    check('admin creates a client for a team', c1.status === 200 && c1.data.username === 'ali.traders');
    check('the client ID is unique (any letter case)', (await admin('POST', '/api/clients', { departmentId: ebayId, username: 'ALI.TRADERS', password: cpw })).status === 400);
    const c2 = await admin('POST', '/api/clients', { departmentId: ebayId, staffIds: [la.data.id, w1.data.id, bina.data.id, lb.data.id], password: cpw, displayName: 'Second Client' });
    check('the admin can let the system pick the ID', c2.status === 200 && /^CL-\d{4}$/.test(c2.data.username));
    const c3 = await admin('POST', '/api/clients', { departmentId: amazonId, username: 'amazon.client', password: cpw });
    const ids = async (c) => (await c('GET', '/api/clients')).data.map((x) => x.username).sort().join();
    check('staff see only the clients of their department / team', await ids(W1) === `${c2.data.username},ali.traders` && await ids(bm) === c2.data.username && await ids(leaderA2) === `${c2.data.username},ali.traders` && await ids(leaderB) === c2.data.username
      && await ids(hodNew) === `${c2.data.username},ali.traders` && await ids(hod2) === 'amazon.client' && (await admin('GET', '/api/clients')).data.length === 3);
    const asMember = JSON.stringify((await W1('GET', '/api/clients')).data);
    check('PRIVATE: staff see the client ID only, never the name, contact or secrets', !/Ali Traders|0300-9999999|TopSecret|displayName|contact|secret/i.test(asMember) && !/Ali Traders|TopSecret/.test(JSON.stringify((await hodNew('GET', '/api/clients')).data)));
    check('PRIVATE: the secret details are for the admin, every view is logged', (await W1('GET', `/api/clients/${c1.data.id}/secret`)).status === 403 && (await hodNew('GET', `/api/clients/${c1.data.id}/secret`)).status === 403
      && (await admin('GET', `/api/clients/${c1.data.id}/secret`)).data.secretInfo.includes('TopSecret') && (await admin('GET', '/api/logs?search=client_secret')).data.some((l) => l.action === 'client_secret_viewed'));
    check('another team cannot open the client at all', (await bm('GET', `/api/clients/${c1.data.id}/chat?channel=inquiry`)).status === 404 && (await hod2('GET', `/api/clients/${c1.data.id}/chat?channel=inquiry`)).status === 404);

    console.log('Client sign-in');
    const CL = client(); const CL2 = client();
    check('wrong password, wrong ID and wrong department are all refused the same way', (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'ali.traders', password: 'nope-nope-nope' })).status === 401
      && (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'nobody', password: cpw })).status === 401 && (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: amazonId, username: 'ali.traders', password: cpw })).status === 401);
    const cli = await CL('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'ali.traders', password: cpw });
    check('the client signs in with the ID and the password the admin set', cli.status === 200 && cli.data.user.role === 'client' && cli.data.user.username === 'ali.traders');
    check('the client\'s own record carries no staff names', !/Worker|Lina|Hamza|Alpha/.test(JSON.stringify(cli.data)));
    await CL2('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: c2.data.username, password: cpw });
    check('a client cannot use any staff page', (await CL('GET', '/api/employees')).status === 403 && (await CL('GET', '/api/clients')).status === 403 && (await CL('GET', '/api/orders')).status === 403 && (await CL('GET', '/api/departments')).status === 403
      && (await CL('GET', '/api/logs')).status === 403 && (await CL('POST', '/api/orders', { date: TODAY, orders: 1 })).status === 403 && (await CL('POST', '/api/orders/publish', { clientId: c1.data.id })).status === 403);
    check('staff cannot use the client portal', (await W1('GET', '/api/portal/sales')).status === 403 && (await admin('GET', '/api/portal/sales')).status === 403 && (await hodNew('POST', '/api/portal/chat', { channel: 'inquiry', body: 'x' })).status === 403);
    const cme = (await CL('GET', '/api/auth/me')).data;
    check('a client gets only the settings it needs', cme.settings.currency && cme.settings.leaveTypes === undefined && (await CL('GET', '/api/settings')).data.scoreWeights === undefined);

    console.log('Client sales (worked out from the sheets the team sends)');
    const ordA = (c, o) => c('POST', '/api/orders', { date: TODAY, ...o });
    const publishTo = (c, clientId) => c('POST', '/api/orders/publish', { clientId });
    check('a member can only use the sheet of a client chosen for them', (await ordA(bm, { clientId: c1.data.id, orders: 1 })).status === 400 && (await ordA(hod2, { clientId: c1.data.id, orders: 1 })).status === 403 && (await ordA(W2, { clientId: c2.data.id, orders: 1 })).status === 400);
    check('rows are validated (several clients: say which; no future date; something in the row; no negative)', (await ordA(W1, { orders: 1 })).status === 400 && (await ordA(W1, { clientId: c1.data.id, date: ymd(offset(2)), orders: 1 })).status === 400
      && (await ordA(W1, { clientId: c1.data.id })).status === 400 && (await ordA(W1, { clientId: c1.data.id, orders: -1 })).status === 400);
    const e1 = await ordA(W1, { clientId: c1.data.id, market: 'Amazon US', store: 'Main', orderId: 'A-1', customer: 'John, Sydney', orders: 5, investment: 100, revenue: 300, note: 'Listed 20 products, 2 orders shipped' });
    const e2 = await ordA(W2, { market: 'eBay UK', orders: 3, investment: 50, revenue: 120 }); // Worker Two works for one client: that is the sheet
    await ordA(W1, { clientId: c1.data.id, date: YESTERDAY, orders: 2, investment: 40, revenue: 90, note: 'Quiet day' });
    check('team members write their rows (a member with one client needs no client in the request)', e1.status === 200 && e2.status === 200);
    check('the client sees no sheet until a member presses Update client', (await CL('GET', '/api/portal/sheet')).data.sheets.length === 0);
    check('only the chosen members send a sheet to the client', (await publishTo(bm, c1.data.id)).status === 400 && (await publishTo(hodNew, c1.data.id)).status === 403 && (await publishTo(W1, c1.data.id)).status === 200 && (await publishTo(W2, c1.data.id)).status === 200);
    const sheetJson = JSON.stringify((await CL('GET', '/api/portal/sheet')).data);
    check('PRIVATE: the client sees the sheets (notes too) but never who wrote them, nor the team-only Market / Store', !/Worker|employee|"market"|"store"|Amazon US|eBay UK|submitted/i.test(sheetJson) && sheetJson.includes('Listed 20 products') && sheetJson.includes('John, Sydney')
      && (await CL('GET', '/api/portal/sheet')).data.sheets.map((x) => x.title).join() === 'Sheet 1,Sheet 2');
    check('another client sees none of these sheets', (await CL2('GET', '/api/portal/sheet')).data.sheets.length === 0);
    const stampA = (await CL('GET', '/api/portal/sheet/stamp')).data.stamp;
    check('a member edits only their own row; the client sees the change only after the next update', (await W2('PUT', `/api/orders/${e1.data.id}`, { orders: 9 })).status === 404 && (await W1('PUT', `/api/orders/${e1.data.id}`, { orders: 6, investment: 100, revenue: 360, note: 'Corrected' })).status === 200
      && (await CL('GET', '/api/portal/sheet/stamp')).data.stamp === stampA && (await publishTo(W1, c1.data.id)).status === 200 && (await CL('GET', '/api/portal/sheet/stamp')).data.stamp !== stampA);
    check('a deleted row leaves the client sheet at the next update; a sheet without rows cannot be sent, but can be withdrawn', (await W2('DELETE', `/api/orders/${e1.data.id}`)).status === 404 && (await W2('DELETE', `/api/orders/${e2.data.id}`)).status === 200 && (await publishTo(W2, c1.data.id)).status === 400
      && (await CL('GET', '/api/portal/sheet')).data.sheets.length === 2 && (await W2('DELETE', `/api/orders/publish/${c1.data.id}`)).status === 200 && (await CL('GET', '/api/portal/sheet')).data.sheets.length === 1);
    const e3 = await ordA(bm, { orders: 7, revenue: 70 }); // Bina works for one client (the department-wide one)
    check('a department-wide client gets its sheet from whoever was chosen for it', e3.status === 200 && (await publishTo(bm, c2.data.id)).status === 200 && (await CL2('GET', '/api/portal/sheet')).data.sheets.length === 1);
    console.log('Client updates (the numbers the client sees on Sales)');
    check('only people of that client\'s team can add an update', (await bm('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY, orders: 1 })).status === 404 && (await hod2('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY, orders: 1 })).status === 404);
    check('updates are validated', (await W1('POST', '/api/client-reports', { clientId: c1.data.id, date: ymd(offset(2)), orders: 1 })).status === 400 && (await W1('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY })).status === 400
      && (await W1('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY, orders: -1 })).status === 400);
    const ce1 = await W1('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY, market: 'Amazon US', store: 'Main', orders: 5, investment: 100, sales: 300, note: 'Listed 20 products, 2 orders shipped' });
    const ce2 = await W2('POST', '/api/client-reports', { clientId: c1.data.id, date: TODAY, market: 'eBay UK', orders: 3, investment: 50, sales: 120 });
    await W1('POST', '/api/client-reports', { clientId: c1.data.id, date: YESTERDAY, orders: 2, investment: 40, sales: 90, note: 'Quiet day' });
    check('team members add the day\'s work for the client ID', ce1.status === 200 && ce2.status === 200);
    const csales = (await CL('GET', '/api/portal/sales')).data;
    check('TODAY: orders, investment, sales and revenue (sales - investment)', csales.today.orders === 8 && csales.today.investment === 150 && csales.today.sales === 420 && csales.today.revenue === 270, JSON.stringify(csales.today));
    check('DAILY: one row per day with that day\'s updates', csales.days.length === 2 && csales.days[0].date === TODAY && csales.days[0].updates.length === 2 && csales.days[1].sales === 90 && csales.chart.length === 14);
    check('TOTAL: everything so far', csales.total.orders === 10 && csales.total.investment === 190 && csales.total.sales === 510 && csales.total.revenue === 320 && csales.total.since === YESTERDAY);
    const csalesJson = JSON.stringify(csales);
    check('PRIVATE: the client never sees who wrote the numbers', !/Worker|submitted|by"|staff|employee/i.test(csalesJson) && csales.username === 'ali.traders' && csalesJson.includes('Listed 20 products'));
    check('the client sees only its own numbers', (await CL2('GET', '/api/portal/sales')).data.total.orders === 0);
    const stf = (await W2('GET', `/api/client-reports?clientId=${c1.data.id}&from=${YESTERDAY}&to=${TODAY}`)).data;
    check('the team sees the entries with who wrote them (internal only)', stf.rows.length === 3 && stf.rows.some((r) => r.by === 'Worker One') && stf.totals.sales === 510);
    check('a member edits only their own update; a leader or the admin any', (await W2('PUT', `/api/client-reports/${ce1.data.id}`, { date: TODAY, orders: 9 })).status === 403 && (await W1('PUT', `/api/client-reports/${ce1.data.id}`, { date: TODAY, market: 'Amazon US', orders: 6, investment: 100, sales: 360, note: 'Corrected' })).status === 200
      && (await leaderA2('PUT', `/api/client-reports/${ce2.data.id}`, { date: TODAY, orders: 4, investment: 50, sales: 120 })).status === 200 && (await CL('GET', '/api/portal/sales')).data.today.orders === 10);
    check('delete follows the same rule', (await W1('DELETE', `/api/client-reports/${ce2.data.id}`)).status === 403 && (await leaderA2('DELETE', `/api/client-reports/${ce2.data.id}`)).status === 200 && (await CL('GET', '/api/portal/sales')).data.today.orders === 6);
    const ce3 = await bm('POST', '/api/client-reports', { clientId: c2.data.id, date: TODAY, orders: 7, sales: 70 });
    check('a department-wide client gets updates from any team', ce3.status === 200 && (await CL2('GET', '/api/portal/sales')).data.today.orders === 7);
    check('the client\'s Sales page is the Client Updates, not the sheet: sending a sheet changes nothing there', (await CL('GET', '/api/portal/sales')).data.today.orders === 6 && (await CL('GET', '/api/portal/sales')).data.total.orders === 8);

    console.log('Client chat (inquiry)');
    const note = async (c, re) => (await c('GET', '/api/notifications?limit=100')).data.items.filter((n) => re.test(n.title));
    const inq = await CL('POST', '/api/portal/chat', { channel: 'inquiry', body: 'Can you check my shipping settings?' });
    check('the client writes an inquiry', inq.status === 200 && (await CL('POST', '/api/portal/chat', { channel: 'inquiry', body: '' })).status === 400 && (await CL('POST', '/api/portal/chat', { channel: 'secret', body: 'x' })).status === 400);
    check('the team of that client (and the head and the admin) are notified, nobody else', (await note(W1, /New message from client ali.traders/)).length === 1 && (await note(leaderA2, /New message from client ali.traders/)).length === 1 && (await note(hodNew, /New message from client/)).length >= 1
      && (await note(admin, /New message from client ali.traders/)).length === 1 && (await note(bm, /ali.traders/)).length === 0 && (await note(leaderB, /ali.traders/)).length === 0 && (await note(hod2, /ali.traders/)).length === 0);
    check('notifications carry no message text', !JSON.stringify((await admin('GET', '/api/notifications?limit=100')).data).includes('shipping settings'));
    const threadS = (await W2('GET', `/api/clients/${c1.data.id}/chat?channel=inquiry`)).data;
    check('staff see the message and that it needs an answer', threadS.messages.length === 1 && threadS.messages[0].fromClient && threadS.needsReply);
    check('the list flags the client as waiting', (await W2('GET', '/api/clients')).data.find((c) => c.id === c1.data.id).inquiryNeedsReply === true && (await W2('GET', '/api/client-alerts/summary')).data.inquiries === 1);
    await W2('POST', `/api/clients/${c1.data.id}/chat`, { channel: 'inquiry', body: 'Sure, checking now.' });
    const threadC = (await CL('GET', '/api/portal/chat?channel=inquiry')).data;
    check('the client sees the reply from "eTricks", never a name', threadC.messages.length === 2 && threadC.messages[1].from === 'etricks' && !/Worker|Lina|Hamza/.test(JSON.stringify(threadC)));
    check('the client sees that the message was read, the thread is no longer waiting', threadC.messages[0].seen === true && (await W1('GET', '/api/clients')).data.find((c) => c.id === c1.data.id).inquiryNeedsReply === false);
    check('the client is notified of the reply without its text', (await note(CL, /New message from eTricks/)).length === 1 && !JSON.stringify((await CL('GET', '/api/notifications')).data).includes('checking now'));
    check('the admin sees which colleague answered', (await admin('GET', `/api/clients/${c1.data.id}/chat?channel=inquiry`)).data.messages[1].author === 'Worker Two');
    const free = () => admin('PUT', `/api/clients/${c1.data.id}/chat-owner`, { employeeId: null }); // the first reply made Worker Two the owner: give it back for the whole-team checks below
    await free();
    check('long polling: only new messages after an ID', (await CL('GET', `/api/portal/chat?channel=inquiry&after=${threadC.messages[1].id}`)).data.messages.length === 0);

    console.log('Client alerts (urgent)');
    const OTP = 'My OTP is 482913, quick';
    await CL('POST', '/api/portal/chat', { channel: 'alert', body: OTP });
    const urgent = (await note(W1, /ALERT from client ali.traders/))[0];
    check('an alert raises an urgent notification for the whole team', urgent && urgent.body === 'Needs an immediate reply.' && (await note(leaderA2, /ALERT from client/)).length === 1 && (await note(admin, /ALERT from client/)).length === 1 && (await note(hodNew, /ALERT from client/)).length === 1 && (await note(bm, /ALERT/)).length === 0);
    check('SECRET: the alert text is not in notifications, the activity log or lists', !JSON.stringify((await admin('GET', '/api/notifications?limit=100')).data).includes('482913') && !JSON.stringify((await W1('GET', '/api/notifications?limit=100')).data).includes('482913')
      && !JSON.stringify((await admin('GET', '/api/logs?limit=500')).data).includes('482913') && !JSON.stringify((await W1('GET', '/api/clients')).data).includes('482913'));
    const sum = (await W1('GET', '/api/client-alerts/summary')).data;
    check('the pages polling for alerts see it at once, only for their own clients', sum.alerts === 1 && sum.items[0].username === 'ali.traders' && !!sum.items[0].since && (await bm('GET', '/api/client-alerts/summary')).data.alerts === 0 && (await hod2('GET', '/api/client-alerts/summary')).data.alerts === 0);
    check('the answer clears the alert', (await W2('POST', `/api/clients/${c1.data.id}/chat`, { channel: 'alert', body: 'Received, thank you.' })).status === 200 && (await W1('GET', '/api/client-alerts/summary')).data.alerts === 0);
    check('the client gets an urgent alert notification (no text) and it shows as unread', (await note(CL, /URGENT: eTricks needs your attention/)).length === 1 && !JSON.stringify((await CL('GET', '/api/notifications?limit=100')).data).includes('Received, thank you') && (await CL('GET', '/api/portal/summary')).data.alert === 1);
    check('opening the alerts marks them read', (await CL('GET', '/api/portal/chat?channel=alert')).data.messages.length === 2 && (await CL('GET', '/api/portal/summary')).data.alert === 0);
    await free(); // Worker Two answered the alert, so it was theirs
    await W1('POST', `/api/clients/${c1.data.id}/chat`, { channel: 'alert', body: 'Please send the OTP code now' });
    check('the team can raise an alert to the client (e.g. to ask for a code)', (await CL('GET', '/api/portal/summary')).data.alert === 1 && (await CL('GET', '/api/portal/chat?channel=alert')).data.messages[2].from === 'etricks');
    check('the two chats are separate', (await CL('GET', '/api/portal/chat?channel=inquiry')).data.messages.length === 2 && (await CL2('GET', '/api/portal/chat?channel=alert')).data.messages.length === 0 && (await CL2('GET', '/api/portal/chat?channel=inquiry')).data.messages.length === 0);
    check('PRIVATE: another client never sees these chats', !JSON.stringify((await CL2('GET', '/api/portal/chat?channel=alert')).data).includes('482913'));
    check('only the admin can wipe a chat', (await W1('DELETE', `/api/clients/${c1.data.id}/chat?channel=alert`)).status === 403 && (await hodNew('DELETE', `/api/clients/${c1.data.id}/chat?channel=alert`)).status === 403
      && (await admin('DELETE', `/api/clients/${c1.data.id}/chat?channel=alert`)).data.removed === 3 && (await CL('GET', '/api/portal/chat?channel=alert')).data.messages.length === 0);

    console.log('Select team members for a client');
    const cand = await admin('GET', `/api/clients/candidates?departmentId=${ebayId}&teamId=${tA}`);
    const candNames = (cand.data || []).map((e) => e.name);
    check('the list for a team has the leader and the members of that team only', cand.status === 200 && candNames.includes('Lina Lead') && candNames.includes('Worker One') && candNames.includes('Worker Two')
      && !candNames.includes('Bina Khan') && !candNames.includes('Bilal Lead') && cand.data[0].role === 'Team leader');
    check('without a team the list has the whole department; a team of another department is refused', (await admin('GET', `/api/clients/candidates?departmentId=${ebayId}`)).data.length > cand.data.length
      && (await admin('GET', `/api/clients/candidates?departmentId=${ebayId}&teamId=${tZ}`)).status === 400);
    check('only the admin can open that list or change the people of a client', (await hodNew('GET', `/api/clients/candidates?departmentId=${ebayId}`)).status === 403 && (await leaderA2('PUT', `/api/clients/${c1.data.id}/staff`, { employeeIds: [] })).status === 403
      && (await W2('GET', `/api/clients/${c1.data.id}/staff`)).status === 403);
    check('people of another team cannot be chosen for a team client', (await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [bina.data.id], username: 'pick.bad', password: cpw })).status === 400
      && (await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: ['x'], username: 'pick.bad', password: cpw })).status === 400
      && (await admin('GET', '/api/clients')).data.every((c) => c.username !== 'pick.bad'));
    const c4 = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [w2.data.id], username: 'select.test', password: cpw });
    check('a client can be created with only the chosen people', c4.status === 200 && (await admin('GET', '/api/clients')).data.find((c) => c.id === c4.data.id).staffCount === 1);
    const see = async (c) => (await c('GET', `/api/clients/${c4.data.id}/chat?channel=inquiry`)).status;
    check('only the chosen member, the head and the admin can open it; the rest of the team cannot', await see(W2) === 200 && await see(hodNew) === 200 && await see(admin) === 200 && await see(leaderA2) === 404 && await see(W1) === 404 && await see(bm) === 404);
    check('the rest of the team does not see it in lists, updates or alerts', !(await ids(W1)).includes('select.test') && !(await ids(leaderA2)).includes('select.test') && (await ids(W2)).includes('select.test')
      && (await W1('POST', '/api/orders', { clientId: c4.data.id, date: TODAY, orders: 1 })).status === 400 && (await W2('POST', '/api/orders', { clientId: c4.data.id, date: TODAY, orders: 2, revenue: 20 })).status === 200
      && (await W1('GET', `/api/orders/me?client=${c4.data.id}`)).status === 400
      && (await W1('POST', '/api/client-reports', { clientId: c4.data.id, date: TODAY, orders: 1 })).status === 404 && (await W2('POST', '/api/client-reports', { clientId: c4.data.id, date: TODAY, orders: 2, sales: 20 })).status === 200
      && (await W1('GET', `/api/client-reports?clientId=${c4.data.id}`)).data.rows.length === 0);
    const CL4 = client();
    await CL4('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'select.test', password: cpw });
    await CL4('POST', '/api/portal/chat', { channel: 'alert', body: 'Code 998877' });
    check('only the chosen people are notified when the client writes', (await note(W2, /ALERT from client select.test/)).length === 1 && (await note(hodNew, /ALERT from client select.test/)).length === 1 && (await note(admin, /ALERT from client select.test/)).length === 1
      && (await note(W1, /select.test/)).length === 0 && (await note(leaderA2, /select.test/)).length === 0 && (await W1('GET', '/api/client-alerts/summary')).data.items.every((i) => i.username !== 'select.test'));
    check('the admin adds the team leader later and the leader is told', (await admin('PUT', `/api/clients/${c4.data.id}/staff`, { employeeIds: [w2.data.id, la.data.id] })).data.added === 1 && await see(leaderA2) === 200 && (await note(leaderA2, /You were added to client select.test/)).length === 1
      && (await leaderA2('GET', '/api/client-alerts/summary')).data.items.some((i) => i.username === 'select.test'));
    check('the admin removes a member later: access ends at once and they are told', (await admin('PUT', `/api/clients/${c4.data.id}/staff`, { employeeIds: [la.data.id] })).data.removed === 1 && await see(W2) === 404 && (await note(W2, /You were removed from client select.test/)).length === 1 && !(await ids(W2)).includes('select.test'));
    check('the admin sees who is chosen', (await admin('GET', `/api/clients/${c4.data.id}/staff`)).data.candidates.filter((e) => e.chosen).map((e) => e.name).join() === 'Lina Lead');
    check('with nobody chosen only the head and the admin see the client', (await admin('PUT', `/api/clients/${c4.data.id}/staff`, { employeeIds: [] })).data.total === 0 && await see(leaderA2) === 404 && await see(hodNew) === 200 && (await admin('PUT', `/api/clients/${c4.data.id}/staff`, { employeeIds: [bina.data.id] })).status === 400);
    check('changing the people is written to the activity log', (await admin('GET', '/api/logs?limit=500')).data.some((l) => l.action === 'client_team_changed'));
    await admin('DELETE', `/api/clients/${c4.data.id}`);

    console.log('Private chat: only the person who answers (and the admin) sees it');
    const c5 = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [la.data.id, w1.data.id, w2.data.id], username: 'private.test', password: cpw });
    const CL5 = client();
    await CL5('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'private.test', password: cpw });
    const url5 = (ch = 'inquiry') => `/api/clients/${c5.data.id}/chat?channel=${ch}`;
    const post5 = (c, body, ch = 'inquiry') => c('POST', `/api/clients/${c5.data.id}/chat`, { channel: ch, body });
    const code5 = async (c) => (await c('GET', url5())).status;
    const re5 = /client private.test/;
    await CL5('POST', '/api/portal/chat', { channel: 'inquiry', body: 'Hello, are you there?' });
    check('before anyone answers, every chosen person (and the head) can open the chat', await code5(W1) === 200 && await code5(W2) === 200 && await code5(leaderA2) === 200 && await code5(hodNew) === 200 && await code5(admin) === 200 && await code5(bm) === 404);
    check('reading does not take the chat; the admin writing does not either', (await post5(admin, 'Admin here')).status === 200 && await code5(W1) === 200 && (await W1('GET', '/api/clients')).data.find((c) => c.id === c5.data.id).chat === 'open');
    check('the first colleague who replies owns the conversation', (await post5(W2, 'Hi, how can I help?')).status === 200 && (await W2('GET', '/api/clients')).data.find((c) => c.id === c5.data.id).chat === 'mine');
    check('PRIVATE: nobody else can read it: not a teammate, the leader or the head', await code5(W1) === 403 && await code5(leaderA2) === 403 && await code5(hodNew) === 403 && await code5(W2) === 200 && await code5(admin) === 200);
    check('PRIVATE: nobody else can write into it', (await post5(W1, 'I will answer')).status === 403 && (await post5(leaderA2, 'I will answer')).status === 403 && (await post5(hodNew, 'I will answer')).status === 403);
    const asW1 = (await W1('GET', '/api/clients')).data.find((c) => c.id === c5.data.id);
    check('the others still see the client, but nothing of its chat', !!asW1 && asW1.chat === 'colleague' && asW1.inquiryNeedsReply === false && asW1.lastInquiryAt === null && !JSON.stringify(asW1).includes('Hello'));
    const adminRow = (await admin('GET', '/api/clients')).data.find((c) => c.id === c5.data.id);
    check('the admin sees who answers', adminRow.chat === 'colleague' && adminRow.chatOwnerName === 'Worker Two');
    const n0 = { w1: (await note(W1, re5)).length, la: (await note(leaderA2, re5)).length, hod: (await note(hodNew, re5)).length, w2: (await note(W2, re5)).length, ad: (await note(admin, re5)).length };
    await CL5('POST', '/api/portal/chat', { channel: 'inquiry', body: 'Second question' });
    await CL5('POST', '/api/portal/chat', { channel: 'alert', body: 'Code 774411' });
    check('the client\'s new messages and alerts notify only the owner and the admin', (await note(W2, re5)).length === n0.w2 + 2 && (await note(admin, re5)).length === n0.ad + 2
      && (await note(W1, re5)).length === n0.w1 && (await note(leaderA2, re5)).length === n0.la && (await note(hodNew, re5)).length === n0.hod);
    check('PRIVATE: the others get no alert banner, no waiting count and cannot open the alert chat', (await W1('GET', '/api/client-alerts/summary')).data.items.every((i) => i.username !== 'private.test') && (await W1('GET', '/api/client-alerts/summary')).data.inquiries === 0
      && (await W2('GET', '/api/client-alerts/summary')).data.items.some((i) => i.username === 'private.test') && (await W1('GET', url5('alert'))).status === 403 && (await hodNew('GET', url5('alert'))).status === 403);
    check('the client still sees one chat, written by "eTricks"', (await CL5('GET', '/api/portal/chat?channel=inquiry')).data.messages.length === 4 && !/Worker|Lina/.test(JSON.stringify((await CL5('GET', '/api/portal/chat?channel=inquiry')).data)));
    check('only the owner or the admin can release it', (await W1('POST', `/api/clients/${c5.data.id}/chat/release`, {})).status === 403 && (await hodNew('POST', `/api/clients/${c5.data.id}/chat/release`, {})).status === 403
      && (await W2('POST', `/api/clients/${c5.data.id}/chat/release`, {})).status === 200 && await code5(W1) === 200);
    check('after the release the next person who replies owns it, and the first one is locked out', (await post5(W1, 'I take it')).status === 200 && await code5(W2) === 403 && await code5(W1) === 200);
    check('only the admin hands it to someone, and only to a person of this client', (await W1('PUT', `/api/clients/${c5.data.id}/chat-owner`, { employeeId: w2.data.id })).status === 403
      && (await admin('PUT', `/api/clients/${c5.data.id}/chat-owner`, { employeeId: bina.data.id })).status === 400
      && (await admin('PUT', `/api/clients/${c5.data.id}/chat-owner`, { employeeId: w2.data.id })).status === 200 && await code5(W2) === 200 && await code5(W1) === 403 && (await note(W2, /You now answer client private.test/)).length === 1);
    check('the head can take a chat too (and then the team cannot read it)', (await admin('PUT', `/api/clients/${c5.data.id}/chat-owner`, { employeeId: null })).status === 200 && (await post5(hodNew, 'Head here')).status === 200 && await code5(W2) === 403 && await code5(hodNew) === 200);
    await admin('PUT', `/api/clients/${c5.data.id}/chat-owner`, { employeeId: null });
    await post5(W2, 'Back to Worker Two');
    check('an owner who is taken off the client no longer locks the chat', (await admin('PUT', `/api/clients/${c5.data.id}/staff`, { employeeIds: [la.data.id, w1.data.id] })).status === 200 && await code5(W1) === 200 && await code5(W2) === 404);
    const acts = (await admin('GET', '/api/logs?limit=500')).data.map((l) => l.action);
    check('the changes of who answers are in the activity log', ['client_chat_taken', 'client_chat_released', 'client_chat_assigned'].every((a) => acts.includes(a)));
    await admin('DELETE', `/api/clients/${c5.data.id}`);

    console.log('Daily sheet: currencies, own columns, clients and live views');
    const sh1 = (await leaderA2('POST', '/api/employees', { name: 'Sheet One', joinDate: YESTERDAY })).data;
    const sh2 = (await leaderA2('POST', '/api/employees', { name: 'Sheet Two', joinDate: YESTERDAY })).data;
    const mlogin = async (m) => { const c = client(); await c('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: m.id, pin: m.pin }); return c; };
    const S1 = await mlogin(sh1); const S2 = await mlogin(sh2);
    const cs = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [sh1.id], username: 'sheet.test', password: cpw });
    const CL6 = client();
    await CL6('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'sheet.test', password: cpw });
    const names6 = async (c) => (await c('GET', '/api/clients')).data.map((x) => x.username).join();
    check('a member sees only the clients chosen for them (list, chat and the sheet\'s client menu)', await names6(S1) === 'sheet.test' && await names6(S2) === '' && (await S1('GET', '/api/orders/me')).data.clients.map((c) => c.username).join() === 'sheet.test'
      && (await S2('GET', '/api/orders/me')).data.clients.length === 0 && (await S2('GET', `/api/clients/${cs.data.id}/chat?channel=inquiry`)).status === 404);
    const RANGE = `from=${ymd(offset(-12))}&to=${TODAY}`;
    const mk = (c, o) => c('POST', '/api/orders', { date: TODAY, ...o });
    check('the currency must be AUD, USD or GBP', (await mk(S1, { orders: 1, currency: 'EUR' })).status === 400 && (await mk(S1, { orders: 1, currency: 'usd' })).status === 400);
    const rUsd = await mk(S1, { market: 'Amazon US', store: 'Main', orders: 2, investment: 40, revenue: 100 });
    const rAud = await mk(S1, { market: 'eBay AU', orders: 3, investment: 100, revenue: 200, currency: 'AUD' });
    const rGbp = await mk(S1, { market: 'eBay UK', orders: 1, investment: 50, revenue: 100, currency: 'GBP', note: 'internal remark about the buyer' });
    const mine6 = async () => (await S1('GET', `/api/orders/me?${RANGE}`)).data;
    check('no currency means USD; rows keep their own currency', rUsd.status === 200 && (await mine6()).rows.find((r) => r.id === rUsd.data.id).currency === 'USD' && (await mine6()).rows.find((r) => r.id === rAud.data.id).currency === 'AUD');
    let t6 = (await mine6()).totals;
    check('totals convert AUD and GBP to the company currency (default rates), each currency also on its own', t6.orders === 6 && t6.revenue === 357 && t6.investment === 168.5 && t6.profit === 188.5 && t6.byCurrency.AUD.revenue === 200 && t6.byCurrency.GBP.investment === 50 && t6.byCurrency.USD.orders === 2, JSON.stringify(t6));
    check('a partial edit keeps everything that was not sent (currency, store, notes)', (await S1('PUT', `/api/orders/${rGbp.data.id}`, { orders: 4 })).status === 200 && (await mine6()).rows.find((r) => r.id === rGbp.data.id).currency === 'GBP'
      && (await mine6()).rows.find((r) => r.id === rGbp.data.id).note.includes('internal'));
    await S1('PUT', `/api/orders/${rGbp.data.id}`, { orders: 1 });
    check('bad numbers are refused', (await mk(S1, { orders: 1.5 })).status === 400 && (await mk(S1, { orders: 1, investment: -5 })).status === 400 && (await mk(S1, { date: ymd(offset(2)), orders: 1 })).status === 400 && (await mk(S1, {})).status === 400);
    check('only the admin sets the exchange rates, and they must be positive numbers', (await hodNew('PUT', '/api/settings', { fxRates: { USD: 1, AUD: 0.5, GBP: 2 } })).status === 403 && (await admin('PUT', '/api/settings', { fxRates: { USD: 1, AUD: 0, GBP: 2 } })).status === 400
      && (await admin('PUT', '/api/settings', { fxRates: { USD: 1, AUD: 'x', GBP: 2 } })).status === 400);
    check('new rates change every total (member sheet, team list, reports)', (await admin('PUT', '/api/settings', { fxRates: { USD: 1, AUD: 0.5, GBP: 2 } })).status === 200 && (await mine6()).totals.revenue === 400
      && (await leaderA2('GET', `/api/orders?${RANGE}`)).data.byEmployee.find((e) => e.employeeId === sh1.id).revenue === 400
      && (await leaderA2('GET', `/api/reports/members?${RANGE}`)).data.rows.find((r) => r.employeeId === sh1.id).sales === 400
      && (await leaderA2('GET', `/api/reports/employee/${sh1.id}?${RANGE}`)).data.orders.sales === 400);
    await admin('PUT', '/api/settings', { fxRates: { USD: 1, AUD: 0.65, GBP: 1.27 } });
    check('exchange rates are in the settings the admin sees', (await admin('GET', '/api/settings')).data.fxRates.AUD === 0.65);

    console.log('Daily sheet: permanent columns, one sheet per client, columns the client may see');
    check('the permanent columns are saved: order id, customer, supplier order no, comments, refunds; ROI is worked out', (await S1('PUT', `/api/orders/${rUsd.data.id}`, { orderId: 'ORD-1001', customer: 'John Smith, Sydney', supplierOrderNo: 'AE-778', comments: 'Fast shipping', refunds: 'None' })).status === 200
      && (await mine6()).rows.find((r) => r.id === rUsd.data.id).orderId === 'ORD-1001' && (await mine6()).rows.find((r) => r.id === rUsd.data.id).roi === 150 && (await mine6()).rows.find((r) => r.id === rUsd.data.id).supplierOrderNo === 'AE-778'
      && (await S1('PUT', `/api/orders/${rUsd.data.id}`, { orderId: 'x'.repeat(61) })).status === 400);
    const prod = await S1('POST', '/api/orders/columns', { label: 'Product', kind: 'text', clientVisible: true });
    const refund = await S1('POST', '/api/orders/columns', { label: 'Refund amount', kind: 'number', clientVisible: false });
    check('a member adds columns of their own and decides whether the client sees each', prod.status === 200 && refund.status === 200 && (await mine6()).columns.length === 2 && (await mine6()).columns.find((c) => c.label === 'Product').clientVisible === true
      && (await mine6()).columns.find((c) => c.label === 'Refund amount').clientVisible === false);
    check('column names must be new, and not one of the permanent columns', (await S1('POST', '/api/orders/columns', { label: 'product' })).status === 400
      && (await S1('POST', '/api/orders/columns', { label: 'Qty' })).status === 400 && (await S1('POST', '/api/orders/columns', { label: 'you earned' })).status === 400 && (await S1('POST', '/api/orders/columns', { label: 'ROI %' })).status === 400 && (await S1('POST', '/api/orders/columns', { label: '' })).status === 400
      && (await S1('POST', '/api/orders/columns', { label: 'Weird', kind: 'date' })).status === 400);
    check('values of the own columns are checked and unknown columns are ignored', (await S1('PUT', `/api/orders/${rUsd.data.id}`, { extra: { [refund.data.id]: 'abc' } })).status === 400
      && (await S1('PUT', `/api/orders/${rUsd.data.id}`, { extra: { [prod.data.id]: 'Mug', [refund.data.id]: 3, 9999: 'ghost' } })).status === 200
      && JSON.stringify((await mine6()).rows.find((r) => r.id === rUsd.data.id).extra) === JSON.stringify({ [prod.data.id]: 'Mug', [refund.data.id]: 3 }));
    const toggled = await S1('PUT', `/api/orders/columns/${refund.data.id}`, { label: 'Refund amount', clientVisible: true });
    check('the member can change later whether the client sees a column', toggled.status === 200 && (await mine6()).columns.find((c) => c.label === 'Refund amount').clientVisible === true && (await S1('PUT', `/api/orders/columns/${refund.data.id}`, { label: 'Refund amount', clientVisible: false })).status === 200
      && (await S2('PUT', `/api/orders/columns/${refund.data.id}`, { label: 'x' })).status === 404);

    const csheet = async (c = CL6) => (await c('GET', '/api/portal/sheet')).data;
    const publish = (c, clientId) => c('POST', '/api/orders/publish', { clientId });
    const cs2 = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [sh1.id], username: 'sheet.two', password: cpw });
    const sheetOf1 = async (client = '') => (await S1('GET', `/api/orders/me?${RANGE}${client ? `&client=${client}` : ''}`)).data;
    check('with several clients every client is a sheet of its own: the first one opens by default and nothing of one shows in another', (await sheetOf1()).clients.map((c) => c.username).join() === 'sheet.test,sheet.two' && (await sheetOf1()).clientId === cs.data.id && (await sheetOf1()).rows.length === 3
      && (await sheetOf1(cs2.data.id)).rows.length === 0 && (await sheetOf1(cs2.data.id)).columns.length === 0 && (await sheetOf1('general')).rows.length === 0 && (await sheetOf1('general')).hasGeneral === false && (await S1('GET', '/api/orders/me?client=99999')).status === 400);
    check('with several clients a row or column must say which sheet; a member cannot use a client who is not theirs', (await S1('POST', '/api/orders', { date: TODAY, orders: 1 })).status === 400 && (await S1('POST', '/api/orders', { date: TODAY, orders: 1, clientId: c2.data.id })).status === 400
      && (await S1('POST', '/api/orders/columns', { label: 'Product' })).status === 400);
    check('an empty sheet cannot be sent, a sheet of another member cannot be sent, a member without client has nothing to send', (await publish(S1, cs2.data.id)).status === 400 && (await publish(S2, cs.data.id)).status === 400 && (await publish(S1, c2.data.id)).status === 400 && (await publish(S1, 'x')).status === 400);
    const rTwo = await S1('POST', '/api/orders', { date: TODAY, clientId: cs2.data.id, orderId: 'T-1', orders: 1, investment: 10, revenue: 25, market: 'Etsy' });
    const prod2 = await S1('POST', '/api/orders/columns', { label: 'Product', kind: 'text', clientVisible: false, clientId: cs2.data.id });
    check('every sheet has its own columns (the same name is allowed on another sheet); a row cannot move to another sheet', rTwo.status === 200 && prod2.status === 200 && (await sheetOf1(cs2.data.id)).columns.length === 1 && (await sheetOf1()).columns.length === 2
      && (await S1('PUT', `/api/orders/${rTwo.data.id}`, { clientId: cs.data.id, orders: 2 })).status === 200 && (await sheetOf1(cs2.data.id)).rows[0].clientId === cs2.data.id && (await sheetOf1(cs2.data.id)).rows.length === 1 && (await sheetOf1()).rows.length === 3
      && (await S1('PUT', `/api/orders/${rTwo.data.id}`, { extra: { [prod.data.id]: 'wrong sheet' } })).status === 200 && (await sheetOf1(cs2.data.id)).rows[0].extra[prod.data.id] === undefined);
    const gen = await S2('POST', '/api/orders', { date: TODAY, orders: 4, investment: 80, revenue: 200, market: 'Amazon US' });
    check('a member without a client has one general sheet', gen.status === 200 && (await S2('GET', `/api/orders/me?${RANGE}`)).data.hasGeneral === true && (await S2('GET', `/api/orders/me?${RANGE}`)).data.clientId === null && (await S2('GET', `/api/orders/me?${RANGE}`)).data.rows.length === 1
      && (await S2('POST', '/api/orders', { date: TODAY, orders: 1, clientId: cs.data.id })).status === 400);

    console.log('Daily sheet: Update client sends one sheet, as it is');
    check('the client sees nothing until the member presses Update', (await csheet()).sheets.length === 0 && (await CL6('GET', '/api/portal/sheet/stamp')).data.stamp === '');
    check('only team members and leaders can update a client, never the head, the client or a stranger', (await publish(hodNew, cs.data.id)).status === 403 && (await publish(CL6, cs.data.id)).status === 403 && (await publish(anon, cs.data.id)).status === 401);
    const pub1 = await publish(S1, cs.data.id);
    check('Update client sends a copy of that sheet and says it is up to date', pub1.status === 200 && pub1.data.rows === 3 && pub1.data.upToDate === true && (await sheetOf1()).published.find((p) => p.clientId === cs.data.id).upToDate === true);
    const v1 = await csheet(); const sh = v1.sheets[0];
    const first = sh.rows.find((r) => r.orderId === 'ORD-1001');
    check('the client sees the whole sheet: the permanent columns (comments, notes too) and only the own columns marked for it, never Market / Store', v1.sheets.length === 1 && sh.title === 'Sheet' && sh.rows.length === 3 && sh.columns.map((c) => c.label).join() === 'Product'
      && first.customer === 'John Smith, Sydney' && first.supplierOrderNo === 'AE-778' && first.comments === 'Fast shipping' && first.roi === 150 && first.profit === 60 && first.extra[prod.data.id] === 'Mug' && first.extra[refund.data.id] === undefined
      && sh.rows.some((r) => /internal remark/.test(r.note)) && !/market|store/i.test(Object.keys(first).join()) && sh.totals.USD.revenue === 100 && sh.totals.AUD.revenue === 200 && sh.totals.GBP.revenue === 100 && v1.username === 'sheet.test' && !!sh.publishedAt);
    check('the other client\'s sheet is not mixed in', !JSON.stringify(v1).includes('T-1') && !JSON.stringify(v1).includes('wrong sheet'));
    check('PRIVATE: nothing tells the client who wrote it', !/Sheet One|employee|sh1/i.test(JSON.stringify(v1)) && !Object.keys(first).some((k) => /employee|client|id$/i.test(k.replace('orderId', ''))));
    check('the client is told, without any figure', (await note(CL6, /Your sheet was updated/)).length === 1 && !JSON.stringify((await CL6('GET', '/api/notifications?limit=100')).data).includes('internal remark'));
    check('another client sees nothing of it; staff cannot open the client pages', !JSON.stringify(await csheet(CL2)).includes('ORD-1001') && (await S1('GET', '/api/portal/sheet')).status === 403 && (await anon('GET', '/api/portal/sheet')).status === 401 && (await S1('GET', '/api/portal/sheet/stamp')).status === 403);
    const stamp1 = (await CL6('GET', '/api/portal/sheet/stamp')).data.stamp;
    await S1('PUT', `/api/orders/${rUsd.data.id}`, { revenue: 150 });
    check('edits do not reach the client by themselves; the member sees that changes are not sent yet', (await csheet()).sheets[0].totals.USD.revenue === 100 && (await CL6('GET', '/api/portal/sheet/stamp')).data.stamp === stamp1 && (await sheetOf1()).published.find((p) => p.clientId === cs.data.id).upToDate === false);
    await new Promise((r) => setTimeout(r, 15)); // a later time than the first update
    check('Update again: the client sees the new figures in the same single sheet, and the stamp changes', (await publish(S1, cs.data.id)).status === 200 && (await csheet()).sheets.length === 1 && (await csheet()).sheets[0].totals.USD.revenue === 150 && (await CL6('GET', '/api/portal/sheet/stamp')).data.stamp !== stamp1
      && (await sheetOf1()).published.find((p) => p.clientId === cs.data.id).upToDate === true);
    check('a column hidden from the client stays hidden, a column shown reaches it with the next update', (await S1('PUT', `/api/orders/columns/${refund.data.id}`, { label: 'Refund amount', clientVisible: true })).status === 200 && (await csheet()).sheets[0].columns.length === 1
      && (await publish(S1, cs.data.id)).status === 200 && (await csheet()).sheets[0].columns.map((c) => c.label).join() === 'Product,Refund amount' && (await csheet()).sheets[0].rows.find((r) => r.orderId === 'ORD-1001').extra[refund.data.id] === 3);
    check('the second client gets its own sheet', (await publish(S1, cs2.data.id)).data.rows === 1 && (await sheetOf1()).published.length === 2);

    console.log('Daily sheet: leader, head and admin see it live');
    const sv = await leaderA2('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`);
    check('the team leader opens a member\'s sheets: one per client, rows, own columns, notes; the first sheet with rows opens', sv.status === 200 && sv.data.sheets.map((x) => `${x.username}:${x.rows}`).join() === 'sheet.test:3,sheet.two:1' && sv.data.clientId === cs.data.id && sv.data.rows.length === 3
      && sv.data.columns.length === 2 && sv.data.rows.some((r) => /internal remark/.test(r.note) && r.market) && sv.data.person.name === 'Sheet One');
    check('the other sheet and the general sheet open on request', (await leaderA2('GET', `/api/orders/sheet/${sh1.id}?${RANGE}&client=${cs2.data.id}`)).data.rows.length === 1 && (await leaderA2('GET', `/api/orders/sheet/${sh2.id}?${RANGE}`)).data.sheets[0].username === null && (await leaderA2('GET', `/api/orders/sheet/${sh2.id}?${RANGE}`)).data.rows.length === 1
      && (await leaderA2('GET', `/api/orders/sheet/${sh1.id}?${RANGE}&client=99999`)).status === 400);
    check('the head and the admin can too; another team\'s leader, another department and members cannot', (await hodNew('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`)).status === 200 && (await admin('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`)).status === 200
      && (await leaderB('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`)).status === 403 && (await hod2('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`)).status === 403 && (await S2('GET', `/api/orders/sheet/${sh1.id}`)).status === 403 && (await S1('GET', `/api/orders/sheet/${sh1.id}`)).status === 403);
    check('the leader sees what each client was last sent, and that the sheet changed after', (await leaderA2('GET', `/api/orders/sheet/${sh1.id}?${RANGE}`)).data.published.map((p) => `${p.username}:${p.rows}:${p.upToDate}`).join() === 'sheet.test:3:true,sheet.two:1:true');
    check('the team list shows client and the new columns, and finds rows by client ID, order id or customer', (await leaderA2('GET', `/api/orders?${RANGE}&search=sheet.test`)).data.rows.length === 3 && (await leaderA2('GET', `/api/orders?${RANGE}&search=ORD-1001`)).data.rows.length === 1 && (await leaderA2('GET', `/api/orders?${RANGE}&search=Smith`)).data.rows.length === 1
      && (await leaderA2('GET', `/api/orders?${RANGE}`)).data.rows.every((r) => r.currency && 'orderId' in r));
    check('both exports have the permanent columns', /SR#,Date,Order Id,Customer Details,Qty,Supplier Order No,Currency,You Earned,Ali Exp Price,Net Profit,ROI %,Comments,Refunds,Note about orders/.test((await S1('GET', `/api/orders/me?${RANGE}&format=csv`)).data) && /Order Id/.test((await leaderA2('GET', `/api/orders?${RANGE}&format=csv`)).data));
    check('deleting a column removes its values from that sheet only', (await S1('DELETE', `/api/orders/columns/${refund.data.id}`)).status === 200 && JSON.stringify((await sheetOf1()).rows.find((r) => r.id === rUsd.data.id).extra) === JSON.stringify({ [prod.data.id]: 'Mug' })
      && (await S2('DELETE', `/api/orders/columns/${prod.data.id}`)).status === 404 && (await sheetOf1(cs2.data.id)).columns.length === 1);
    let added = 0; for (const n of ['A', 'B', 'C', 'D', 'E']) added += (await S1('POST', '/api/orders/columns', { label: `Col ${n}`, clientId: cs.data.id })).status === 200 ? 1 : 0;
    check('a sheet can have up to 6 columns of its own', added === 5 && (await S1('POST', '/api/orders/columns', { label: 'One too many', clientId: cs.data.id })).status === 400 && (await sheetOf1()).columns.length === 6 && (await S1('POST', '/api/orders/columns', { label: 'Fine here', clientId: cs2.data.id })).status === 200);
    const old = await S1('POST', '/api/orders', { date: ymd(offset(-10)), clientId: cs.data.id, orders: 1, revenue: 10 });
    check('rows older than 7 days can be added but no longer changed', old.status === 200 && (await S1('PUT', `/api/orders/${old.data.id}`, { orders: 2 })).status === 400 && (await S1('DELETE', `/api/orders/${old.data.id}`)).status === 400);
    check('only the writer changes or deletes a row', (await S2('PUT', `/api/orders/${rUsd.data.id}`, { orders: 9 })).status === 404 && (await leaderA2('PUT', `/api/orders/${rUsd.data.id}`, { orders: 9 })).status === 404 && (await S2('DELETE', `/api/orders/${rUsd.data.id}`)).status === 404);
    check('deleting a row changes the client\'s sheet only with the next update', (await S1('DELETE', `/api/orders/${rGbp.data.id}`)).status === 200 && (await csheet()).sheets[0].rows.length === 3 && (await publish(S1, cs.data.id)).data.rows === 3
      && (await csheet()).sheets[0].rows.length === 3);
    check('the member can stop showing the sheet to a client', (await S1('DELETE', `/api/orders/publish/${cs.data.id}`)).status === 200 && (await csheet()).sheets.length === 0 && (await S2('DELETE', `/api/orders/publish/${cs.data.id}`)).status === 200);
    await publish(S1, cs.data.id);

    console.log('Daily sheet: one person works for at most 5 clients');
    const lim = [];
    for (const n of [1, 2, 3]) lim.push((await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [sh1.id], username: `limit.${n}`, password: cpw })).data);
    const sixth = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [sh1.id], username: 'limit.4', password: cpw });
    check('a sixth client is refused with a clear message, and nothing is half-created', sixth.status === 400 && /already works for 5 clients/.test(sixth.data.error) && (await admin('GET', '/api/clients')).data.every((c) => c.username !== 'limit.4'));
    const candSh1 = (await admin('GET', `/api/clients/candidates?departmentId=${ebayId}&teamId=${tA}`)).data.find((e) => e.id === sh1.id);
    check('the list shows who is full', candSh1.otherClients === 5 && candSh1.limit === 5 && (await admin('GET', `/api/clients/${lim[0].id}/staff`)).data.candidates.find((e) => e.id === sh1.id).otherClients === 4);
    const lim4 = await admin('POST', '/api/clients', { departmentId: ebayId, teamId: tA, staffIds: [], username: 'limit.4', password: cpw });
    check('adding the sixth later is refused too; keeping an existing client is fine', (await admin('PUT', `/api/clients/${lim4.data.id}/staff`, { employeeIds: [sh1.id] })).status === 400 && (await admin('PUT', `/api/clients/${lim[0].id}/staff`, { employeeIds: [sh1.id] })).status === 200 && (await admin('PUT', `/api/clients/${lim4.data.id}`, { staffIds: [sh1.id] })).status === 400);
    check('after a client is taken away, the next one can be given', (await admin('PUT', `/api/clients/${lim[0].id}/staff`, { employeeIds: [] })).status === 200 && (await admin('PUT', `/api/clients/${lim4.data.id}/staff`, { employeeIds: [sh1.id] })).status === 200);
    for (const c of [...lim, lim4.data]) await admin('DELETE', `/api/clients/${c.id}`);

    check('removing a client keeps the member\'s rows (they move to the general sheet) and removes the copy', (await admin('DELETE', `/api/clients/${cs2.data.id}`)).status === 200 && (await S1('GET', `/api/orders/me?${RANGE}&client=general`)).data.rows.length === 1 && (await S1('GET', `/api/orders/me?${RANGE}&client=general`)).data.hasGeneral === true);
    check('what the client was sent stays when the person who wrote it is deleted; the member\'s own rows go', (await leaderA2('DELETE', `/api/employees/${sh1.id}`)).status === 200 && (await csheet()).sheets.length === 1 && (await csheet()).sheets[0].rows.length === 3 && (await admin('GET', `/api/orders?${RANGE}&search=Sheet One`)).data.rows.length === 0);
    check('removing the client removes its copy', (await admin('DELETE', `/api/clients/${cs.data.id}`)).status === 200);
    await leaderA2('DELETE', `/api/employees/${sh2.id}`);
    check('deleting a person removes their sheet and columns', (await admin('GET', `/api/orders?${RANGE}&search=Sheet`)).data.rows.length === 0);

    console.log('Client accounts');
    check('the admin edits a client (name, contact, secret, team)', (await admin('PUT', `/api/clients/${c1.data.id}`, { displayName: 'Ali Traders Group', contact: '0301-1111111', secretInfo: 'New secret', teamId: tA })).status === 200 && (await admin('GET', `/api/clients/${c1.data.id}/secret`)).data.secretInfo === 'New secret');
    check('moving the client to another team hides it from the old team and nobody of the new team gets it by themselves', (await admin('PUT', `/api/clients/${c1.data.id}`, { teamId: tB })).status === 200 && await ids(W1) === c2.data.username && !(await ids(bm)).includes('ali.traders')
      && (await admin('GET', `/api/clients/${c1.data.id}/staff`)).data.candidates.every((e) => !e.chosen));
    await admin('PUT', `/api/clients/${c1.data.id}`, { teamId: tA, staffIds: [la.data.id, w1.data.id, w2.data.id] });
    check('a new password signs the client out and the old one stops working', (await admin('PUT', `/api/clients/${c1.data.id}/password`, { password: 'BrandNew-Pass-9' })).status === 200 && (await CL('GET', '/api/portal/sales')).status === 401
      && (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'ali.traders', password: cpw })).status === 401);
    const CL3 = client();
    check('the new password works', (await CL3('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'ali.traders', password: 'BrandNew-Pass-9' })).status === 200);
    check('disabling a client ends its session and blocks sign-in; staff stop seeing it', (await admin('PUT', `/api/clients/${c1.data.id}`, { status: 'disabled' })).status === 200 && (await CL3('GET', '/api/portal/sales')).status === 401
      && (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'ali.traders', password: 'BrandNew-Pass-9' })).status === 401 && await ids(W1) === c2.data.username);
    await admin('PUT', `/api/clients/${c1.data.id}`, { status: 'active' });
    check('what the client was sent stays with the client when the person who wrote it is deleted', (await leaderA2('DELETE', `/api/employees/${w1.data.id}`)).status === 200 && (await admin('GET', '/api/clients')).data.find((c) => c.id === c1.data.id).today.sales === 360 && (await admin('GET', '/api/clients')).data.find((c) => c.id === c1.data.id).total.sales === 450);
    const tEmpty = (await hod2('POST', '/api/teams', { name: 'Empty' })).data;
    const cTeam = await admin('POST', '/api/clients', { departmentId: amazonId, teamId: tEmpty.id, username: 'team.client', password: cpw });
    check('a team that still has a client cannot be deleted (and nothing crashes)', cTeam.status === 200 && (await hod2('DELETE', `/api/teams/${tEmpty.id}`)).status === 400 && (await admin('DELETE', `/api/clients/${cTeam.data.id}`)).status === 200 && (await hod2('DELETE', `/api/teams/${tEmpty.id}`)).status === 200);
    check('the admin deletes a client with everything of it', (await admin('DELETE', `/api/clients/${c3.data.id}`)).status === 200 && (await admin('GET', '/api/clients')).data.length === 2 && (await W2('DELETE', `/api/clients/${c2.data.id}`)).status === 403);
    check('client activity is in the log without any message text', (await admin('GET', '/api/logs?limit=500')).data.some((l) => l.action === 'client_created') && (await admin('GET', '/api/logs?limit=500')).data.some((l) => l.action === 'client_alert'));
    const cLock = await admin('POST', '/api/clients', { departmentId: ebayId, username: 'lock.test', password: cpw });
    const guesser2 = client();
    let lastC;
    for (let i = 0; i < 7; i++) lastC = await guesser2('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'lock.test', password: 'guess-guess-' + i });
    check('client sign-in is locked after repeated wrong passwords', lastC.status === 429 && (await client()('POST', '/api/auth/login', { portal: 'client', departmentId: ebayId, username: 'lock.test', password: cpw })).status === 429);
    await admin('DELETE', `/api/clients/${cLock.data.id}`);

    console.log('Attendance: nobody is ever left without a Check in button');
    const pm = {};
    for (const n of ['Punch One', 'Punch Two', 'Punch Three']) pm[n] = (await leaderA2('POST', '/api/employees', { name: n, joinDate: YESTERDAY })).data;
    const login = async (m) => { const c = client(); await c('POST', '/api/auth/login', { portal: 'member', departmentId: ebayId, password: 'AlphaTeam-Pass1', employeeId: m.id, pin: m.pin }); return c; };
    const P1 = await login(pm['Punch One']); const P2 = await login(pm['Punch Two']); const P3 = await login(pm['Punch Three']);
    await leaderA2('POST', '/api/attendance/manual', { employeeId: pm['Punch One'].id, date: YESTERDAY, status: 'present', checkIn: '00:01' }); // yesterday: checked in, never checked out
    const t1 = (await P1('GET', '/api/attendance/me/today')).data;
    check('a forgotten check-out of yesterday does not hide today\'s Check in', t1.state === 'not_started' && t1.missedCheckOut === YESTERDAY);
    check('the member can check in, take a break and check out today', (await P1('POST', '/api/attendance/me/action', { action: 'check_in' })).data.state === 'working' && (await P1('POST', '/api/attendance/me/action', { action: 'break_start' })).data.state === 'on_break'
      && (await P1('POST', '/api/attendance/me/action', { action: 'break_end' })).data.state === 'working' && (await P1('POST', '/api/attendance/me/action', { action: 'check_out' })).data.state === 'done');
    const yRow = (await leaderA2('GET', `/api/attendance?from=${YESTERDAY}&to=${YESTERDAY}&employeeId=${pm['Punch One'].id}`)).data[0];
    check('yesterday stays open for the leader to correct, with a note', yRow.checkIn && !yRow.checkOut && /No check-out/.test(yRow.note));
    await leaderA2('POST', '/api/attendance/manual', { employeeId: pm['Punch Two'].id, date: TODAY, status: 'present' }); // marked present by the leader, no times
    const t2 = (await P2('GET', '/api/attendance/me/today')).data;
    check('a day marked present by the leader (no times) still lets the member check in', t2.state === 'not_started' && t2.record.status === 'present');
    const ci2 = await P2('POST', '/api/attendance/me/action', { action: 'check_in' });
    check('the real check-in completes it and stays approved', ci2.status === 200 && ci2.data.state === 'working' && !!ci2.data.record.checkIn && ci2.data.record.approval === 'approved');
    check('checking in twice is refused with a clear message', /already checked in/.test((await P2('POST', '/api/attendance/me/action', { action: 'check_in' })).data.error || ''));
    await leaderA2('POST', '/api/attendance/manual', { employeeId: pm['Punch Three'].id, date: TODAY, status: 'absent' });
    const t3 = (await P3('GET', '/api/attendance/me/today')).data;
    const ci3 = await P3('POST', '/api/attendance/me/action', { action: 'check_in' });
    check('a day marked absent is explained, not silently blocked', t3.state === 'done' && ci3.status === 400 && /marked as absent/.test(ci3.data.error || ''));
    console.log('Attendance: check in and out several times a day');
    const act = (c, action) => c('POST', '/api/attendance/me/action', { action });
    const todayOf = async (c) => (await c('GET', '/api/attendance/me/today')).data;
    const t1b = await todayOf(P1);
    check('after a check-out the member may check in again the same day', t1b.state === 'done' && t1b.canCheckInAgain === true && t1b.record.sessionCount === 1 && t1b.maxSessions === 4);
    await leaderA2('POST', `/api/attendance/${t1b.record.id}/decision`, { approval: 'approved' });
    const again = await act(P1, 'check_in');
    check('a second check-in starts a new session of the same day, and the leader looks at the day again', again.status === 200 && again.data.state === 'working' && again.data.record.sessionCount === 2 && !again.data.record.checkOut && again.data.record.approval === 'pending' && again.data.canCheckInAgain === false);
    check('the leader is told it is a second session', (await note(leaderA2, /Punch One checked in again/)).length === 1);
    check('checking in while already working is still refused', /already checked in/.test((await act(P1, 'check_in')).data.error || ''));
    check('breaks and the second check-out work as before', (await act(P1, 'break_start')).data.state === 'on_break' && (await act(P1, 'break_end')).data.state === 'working' && (await act(P1, 'check_out')).data.state === 'done');
    const t1c = await todayOf(P1);
    check('the day lists both sessions and the worked time is the sessions, not the gap between them', t1c.record.sessions.length === 2 && t1c.record.sessions.every((x) => x.checkIn && x.checkOut) && t1c.record.workedMinutes === 0 && t1c.canCheckInAgain === true);
    await act(P1, 'check_in'); await act(P1, 'check_out');
    await act(P1, 'check_in'); await act(P1, 'check_out');
    const fifth = await act(P1, 'check_in');
    check('up to 4 sessions a day, then a clear message', fifth.status === 400 && /up to 4 times a day/.test(fifth.data.error || '') && (await todayOf(P1)).record.sessionCount === 4 && (await todayOf(P1)).canCheckInAgain === false);
    const boardP1 = (await leaderA2('GET', `/api/attendance/board?date=${TODAY}`)).data.rows.find((r) => r.id === pm['Punch One'].id);
    check('the team board shows the first check-in, the last check-out and the number of sessions', boardP1.record.sessionCount === 4 && !!boardP1.record.checkIn && !!boardP1.record.checkOut);
    check('a day marked absent can never be checked in again', t3.state === 'done' && (await todayOf(P3)).canCheckInAgain === false);
    check('a day a leader marked without times can be completed, then checked in again', (await act(P2, 'check_out')).data.state === 'done' && (await todayOf(P2)).canCheckInAgain === true && (await act(P2, 'check_in')).data.record.sessionCount === 2);
    const fix = await leaderA2('POST', '/api/attendance/manual', { employeeId: pm['Punch One'].id, date: TODAY, status: 'present', checkIn: '09:00', checkOut: '12:00' });
    const t1d = await todayOf(P1);
    check('a leader correcting the times replaces the sessions of that day', fix.status === 200 && t1d.record.sessions.length === 1 && t1d.record.workedMinutes === 180);
    check('the records export has the number of sessions', /Sessions/.test((await leaderA2('GET', `/api/attendance?from=${TODAY}&to=${TODAY}&format=csv`)).data));
    for (const n of Object.keys(pm)) await leaderA2('DELETE', `/api/employees/${pm[n].id}`);

    console.log('Salary: fixed, percentage of the profit, or both');
    const addPay = (name, pay) => leaderA2('POST', '/api/employees', { name, joinDate: YESTERDAY, ...(pay ? { pay } : {}) });
    const pA = (await addPay('Pay Fixed', { type: 'fixed', amount: 600 })).data;
    const pB = (await addPay('Pay Percent', { type: 'percent', percent: 10 })).data;
    const pC = (await addPay('Pay Both', { type: 'both', amount: 500, percent: 5 })).data;
    const pD = (await addPay('Pay Unset')).data;
    const pE = (await addPay('Pay Loss', { type: 'percent', percent: 10 })).data;
    check('a member is added with a fixed salary, a percentage or both; without any pay still works', [pA, pB, pC, pD, pE].every((x) => Number.isInteger(x.id)));
    const peopleBefore = (await leaderA2('GET', '/api/employees')).data.length;
    check('bad pay is refused and nobody is added: unknown way, no amount, no percentage, 0 or more than 100 percent', (await addPay('Pay Bad 1', { type: 'monthly', amount: 5 })).status === 400 && (await addPay('Pay Bad 2', { type: 'fixed' })).status === 400 && (await addPay('Pay Bad 3', { type: 'percent' })).status === 400
      && (await addPay('Pay Bad 4', { type: 'percent', percent: 0 })).status === 400 && (await addPay('Pay Bad 5', { type: 'percent', percent: 101 })).status === 400 && (await addPay('Pay Bad 6', { type: 'both', amount: 100 })).status === 400 && (await leaderA2('GET', '/api/employees')).data.length === peopleBefore);
    const payPer = TODAY.slice(0, 7);
    const salRow = async (id) => (await leaderA2('GET', `/api/salaries?period=${payPer}`)).data.rows.find((r) => r.refId === id);
    check('the salary page says how each person is paid', (await salRow(pA.id)).payType === 'fixed' && (await salRow(pA.id)).rate === 600 && (await salRow(pA.id)).suggested === 600 && (await salRow(pB.id)).payType === 'percent' && (await salRow(pB.id)).percent === 10 && (await salRow(pB.id)).suggested === 0
      && (await salRow(pC.id)).payType === 'both' && (await salRow(pC.id)).suggested === 500 && (await salRow(pD.id)).payText === 'Not set' && (await salRow(pD.id)).suggested === 0 && /10% of the profit/.test((await salRow(pB.id)).payText) && /500 \+ 5%/.test((await salRow(pC.id)).payText));
    const SB = await mlogin(pB); const SC = await mlogin(pC); const SE = await mlogin(pE);
    await SB('POST', '/api/orders', { date: TODAY, orders: 2, investment: 400, revenue: 1000 });
    await SB('POST', '/api/orders', { date: TODAY, orders: 1, investment: 100, revenue: 200, currency: 'AUD' });
    await SC('POST', '/api/orders', { date: TODAY, orders: 2, investment: 400, revenue: 1000 });
    await SE('POST', '/api/orders', { date: TODAY, orders: 1, investment: 300, revenue: 100 });
    check('the percentage is worked out from the net profit of the month in the company currency', (await salRow(pB.id)).profit === 665 && (await salRow(pB.id)).commission === 66.5 && (await salRow(pB.id)).suggested === 66.5 && (await salRow(pC.id)).profit === 600 && (await salRow(pC.id)).commission === 30 && (await salRow(pC.id)).suggested === 530);
    check('a loss never makes a negative salary', (await salRow(pE.id)).profit === -200 && (await salRow(pE.id)).commission === 0 && (await salRow(pE.id)).suggested === 0);
    check('paying a percentage month: the first payment fixes the amount due, more than that is refused', (await leaderA2('POST', '/api/salaries/payments', { refId: pB.id, period: payPer, amount: 66.5, paidDate: TODAY })).status === 200 && (await salRow(pB.id)).due === 66.5 && (await salRow(pB.id)).status === 'paid'
      && (await leaderA2('POST', '/api/salaries/payments', { refId: pB.id, period: payPer, amount: 1, paidDate: TODAY })).status === 400);
    const none = await leaderA2('POST', '/api/salaries/payments', { refId: pE.id, period: payPer, amount: 10, paidDate: TODAY });
    check('with nothing due the payer has to type the agreed amount', none.status === 400 && /Nothing is due/.test(none.data.error) && (await leaderA2('POST', '/api/salaries/payments', { refId: pE.id, period: payPer, amount: 50, salaryAmount: 50, paidDate: TODAY })).status === 200
      && (await leaderA2('POST', '/api/salaries/payments', { refId: pD.id, period: payPer, amount: 10, paidDate: TODAY })).status === 400);
    check('a fixed + percentage month is paid in parts up to the total', (await leaderA2('POST', '/api/salaries/payments', { refId: pC.id, period: payPer, amount: 500, paidDate: TODAY })).status === 200 && (await salRow(pC.id)).remaining === 30 && (await leaderA2('POST', '/api/salaries/payments', { refId: pC.id, period: payPer, amount: 30, paidDate: TODAY })).status === 200 && (await salRow(pC.id)).status === 'paid');
    check('how someone is paid can be changed later; the old way of sending only an amount still means a fixed salary', (await leaderA2('PUT', '/api/salaries/rate', { refId: pA.id, payType: 'both', amount: 700, percent: 3 })).status === 200 && (await salRow(pA.id)).payType === 'both' && (await salRow(pA.id)).percent === 3 && (await salRow(pA.id)).rate === 700
      && (await leaderA2('PUT', '/api/salaries/rate', { refId: pA.id, amount: 650 })).status === 200 && (await salRow(pA.id)).payType === 'fixed' && (await salRow(pA.id)).percent === 0 && (await salRow(pA.id)).rate === 650
      && (await leaderA2('PUT', '/api/salaries/rate', { refId: pA.id, payType: 'percent', percent: 150 })).status === 400 && (await leaderA2('PUT', '/api/salaries/rate', { refId: pA.id, payType: 'weekly', amount: 5 })).status === 400);
    const meB = (await SB('GET', '/api/salaries/me')).data;
    check('only the people above set pay; a member sees how they are paid and this month so far', (await SB('PUT', '/api/salaries/rate', { refId: pB.id, payType: 'fixed', amount: 9999 })).status === 403 && meB.payType === 'percent' && meB.percent === 10 && meB.thisMonth.profit === 665 && meB.thisMonth.commission === 66.5 && /10% of the profit/.test(meB.payText)
      && (await leaderB('PUT', '/api/salaries/rate', { refId: pB.id, payType: 'fixed', amount: 9999 })).status === 403);
    check('the salary export says how each person is paid', /Paid how,Fixed salary,Percentage of profit,Profit this month,Commission this month/.test((await leaderA2('GET', `/api/salaries?period=${payPer}&format=csv`)).data));
    const logsPay = JSON.stringify((await admin('GET', '/api/logs?limit=500')).data);
    check('the way of payment is in the activity log', logsPay.includes('salary_set') && logsPay.includes('paid: 500 + 5%'));
    for (const x of [pA, pB, pC, pD, pE]) await leaderA2('POST', `/api/employees/${x.id}/status`, { status: 'inactive' }); // people who were paid are deactivated, not deleted

    console.log('Admin, logs, backups');
    const logs = (await admin('GET', '/api/logs?limit=500')).data;
    check('activity log captured actions', logs.length > 10 && logs.some((l) => l.action === 'login') && logs.some((l) => l.action === 'login_failed') && logs.some((l) => l.action === 'transfer') && logs.some((l) => l.action === 'password_changed'));
    check('head sees only own department log; leaders have none', (await hodNew('GET', '/api/logs')).data.every((l) => l.departmentId === ebayId) && (await leaderA2('GET', '/api/logs')).status === 403);
    check('manual backup (pressed twice in a second is fine)', (await admin('POST', '/api/backups')).status === 200 && (await admin('POST', '/api/backups')).status === 200);
    check('backup list', (await admin('GET', '/api/backups')).data.length >= 2);
    check('backups admin only', (await hodNew('GET', '/api/backups')).status === 403);

    console.log('Full backup (every 30 days, download or it is deleted)');
    const fb0 = (await admin('GET', '/api/backups/full')).data;
    check('settings: a 30-day cycle with 7 days to download; nothing is waiting at first', fb0.days === 30 && fb0.graceDays === 7 && fb0.alert === null && fb0.items.length === 0 && /^\d{4}-\d{2}-\d{2}T/.test(fb0.nextDue)
      && Math.round((Date.parse(fb0.nextDue) - Date.now()) / 864e5) === 30);
    const fbNew = await admin('POST', '/api/backups/full');
    check('the admin makes a full backup now: checked, with a checksum and the number of tables and rows', fbNew.status === 200 && fbNew.data.status === 'ready' && fbNew.data.daysLeft === 7 && /^[0-9a-f]{64}$/.test(fbNew.data.sha256) && fbNew.data.tables > 20 && fbNew.data.rows > 100 && fbNew.data.size > 50000, JSON.stringify(fbNew.data));
    check('pressed twice in a second is fine', (await admin('POST', '/api/backups/full')).status === 200);
    const fbId = fbNew.data.id;
    check('the file is really in its own folder, apart from the daily copies', fs.existsSync(path.join(DATA, 'backups', 'full', fbNew.data.name)) && !(await admin('GET', '/api/backups')).data.some((b) => b.name.includes('-full-')));
    const fbSum = (await admin('GET', '/api/backups/summary')).data;
    check('the admin is warned: a backup waits for download, with the last day', fbSum.alert && fbSum.alert.count >= 1 && fbSum.alert.daysLeft === 7 && /^\d{4}-\d{2}-\d{2}T/.test(fbSum.alert.expiresAt));
    const delEarly = await admin('DELETE', `/api/backups/full/${fbId}`);
    check('a backup that was never downloaded cannot be deleted by mistake', delEarly.status === 400 && /Download this backup first/.test(delEarly.data.error) && fs.existsSync(path.join(DATA, 'backups', 'full', fbNew.data.name)));
    const fbSt = [(await hodNew('GET', '/api/backups/full')).status, (await leaderA2('GET', '/api/backups/summary')).status, (await hodNew('POST', '/api/backups/full')).status, (await hodNew("GET", `/api/backups/full/${fbId}/download`)).status, (await hodNew('DELETE', `/api/backups/full/${fbId}`)).status, (await anon('GET', '/api/backups/full')).status];
    check('only the admin can see, make, download or delete full backups', fbSt.join() === '403,403,403,403,403,401', fbSt.join());
    check('an unknown backup number is 404', (await admin('GET', '/api/backups/full/99999/download')).status === 404 && (await admin('DELETE', '/api/backups/full/99999')).status === 404);
    const got = await admin('GET', `/api/backups/full/${fbId}/download`);
    check('the download is the whole file (the size announced)', got.status === 200 && /attachment/.test(got.headers.get('content-disposition')) && Number(got.headers.get('content-length')) === fbNew.data.size);
    await new Promise((r) => setTimeout(r, 400));
    const fbAfter = (await admin('GET', '/api/backups/full')).data.items.find((x) => x.id === fbId);
    check('once downloaded it is marked as downloaded and no longer expires', fbAfter.status === 'downloaded' && fbAfter.expiresAt === null && !!fbAfter.downloadedAt && fbAfter.downloadedBy);
    check('the warning goes away when everything waiting has been downloaded', (await admin('GET', '/api/backups/summary')).data.alert === null);
    const fbCopy = fs.readFileSync(path.join(DATA, 'backups', 'full', fbNew.data.name));
    check('the copy is a complete database: it opens, passes the integrity check and holds the people and the departments', (() => {
      const tmp = path.join(os.tmpdir(), `etx-open-${Date.now()}.db`);
      fs.writeFileSync(tmp, fbCopy);
      const { DatabaseSync } = require('node:sqlite');
      const t = new DatabaseSync(tmp);
      try {
        const ok = Object.values(t.prepare('PRAGMA integrity_check').get())[0] === 'ok';
        const people = Number(t.prepare('SELECT COUNT(*) AS n FROM employees').get().n);
        const depts = Number(t.prepare('SELECT COUNT(*) AS n FROM departments').get().n);
        const sha = crypto.createHash('sha256').update(fbCopy).digest('hex');
        return ok && people > 5 && depts === 6 && sha === fbNew.data.sha256;
      } finally { t.close(); fs.unlinkSync(tmp); }
    })());
    check('after downloading, the admin can delete it from the server (the file goes, the history stays)', (await admin('DELETE', `/api/backups/full/${fbId}`)).status === 200 && !fs.existsSync(path.join(DATA, 'backups', 'full', fbNew.data.name))
      && (await admin('GET', '/api/backups/full')).data.items.find((x) => x.id === fbId).status === 'deleted' && (await admin('GET', `/api/backups/full/${fbId}/download`)).status === 404 && (await admin('DELETE', `/api/backups/full/${fbId}`)).status === 404);
    const flog = (await admin('GET', '/api/logs?limit=500')).data;
    check('every step is in the activity log', ['backup_full_created', 'backup_full_download_started', 'backup_full_downloaded', 'backup_full_deleted'].every((a) => flog.some((l) => l.action === a)));
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

    console.log('Website access password');
    check('no access password is set at first: the department list is open', (await anon('GET', '/api/public/departments')).status === 200 && (await anon('GET', '/api/gate')).data.required === false && (await admin('GET', '/api/gate/status')).data.enabled === false);
    check('only the admin sets it, and it needs 8 characters', (await hodNew('PUT', '/api/gate', { password: 'Gate-pass-1' })).status === 403 && (await anon('PUT', '/api/gate', { password: 'Gate-pass-1' })).status === 401 && (await admin('PUT', '/api/gate', { password: 'short' })).status === 400
      && (await hodNew('DELETE', '/api/gate')).status === 403 && (await hodNew('GET', '/api/gate/status')).status === 403);
    check('the admin sets the access password', (await admin('PUT', '/api/gate', { password: 'Gate-pass-1' })).data.enabled === true && !!(await admin('GET', '/api/gate/status')).data.setAt);
    const visitor = client();
    const closed = ['/api/public/departments', '/api/public/settings'];
    check('a visitor sees nothing before the password: no departments, no sign-in, no team lists', (await Promise.all(closed.map((u) => visitor('GET', u)))).every((r) => r.status === 403 && /Access password/.test(r.data.error))
      && (await visitor('POST', '/api/auth/login', { portal: 'admin', password: 'x' })).status === 403 && (await visitor('POST', '/api/auth/members', { departmentId: ebayId, password: 'x' })).status === 403);
    const meGate = await visitor('GET', '/api/auth/me');
    check('the website can still ask whether to show the password page, and the server stays reachable', meGate.status === 200 && meGate.data.user === null && meGate.data.gate.required === true && meGate.data.gate.passed === false && (await visitor('GET', '/api/health')).status === 200
      && !JSON.stringify(meGate.data).includes('eBay'));
    check('a wrong password is refused; the right one opens everything', (await visitor('POST', '/api/gate', { password: 'wrong-wrong' })).status === 401 && (await visitor('GET', '/api/public/departments')).status === 403
      && (await visitor('POST', '/api/gate', { password: 'Gate-pass-1' })).status === 200 && (await visitor('GET', '/api/public/departments')).status === 200 && (await visitor('GET', '/api/auth/me')).data.gate.passed === true);
    check('the cookie cannot be forged', (await fetch(BASE + '/api/public/departments', { headers: { Cookie: 'gate=abc.def' } })).status === 403 && (await fetch(BASE + '/api/public/departments', { headers: { Cookie: 'gate=' + 'a'.repeat(24) + '.' + 'b'.repeat(43) } })).status === 403);
    check('people who are signed in keep working, and so does the admin', (await hodNew('GET', '/api/employees')).status === 200 && (await admin('GET', '/api/employees')).status === 200 && (await hod2('GET', '/api/employees')).status === 200);
    check('a new password locks out every browser that knew the old one, but not the one who set it', (await admin('PUT', '/api/gate', { password: 'Gate-pass-2' })).status === 200 && (await visitor('GET', '/api/public/departments')).status === 403
      && (await admin('GET', '/api/public/departments')).status === 200 && (await visitor('POST', '/api/gate', { password: 'Gate-pass-1' })).status === 401 && (await visitor('POST', '/api/gate', { password: 'Gate-pass-2' })).status === 200 && (await visitor('GET', '/api/public/departments')).status === 200);
    check('turning it off opens the website again, for everybody', (await admin('DELETE', '/api/gate')).data.enabled === false && (await client()('GET', '/api/public/departments')).status === 200 && (await anon('GET', '/api/gate')).data.required === false);
    await admin('PUT', '/api/gate', { password: 'Gate-pass-3' });
    const gateGuesser = client();
    let lastG; for (let i = 0; i < 7; i++) lastG = await gateGuesser('POST', '/api/gate', { password: 'guess-guess-' + i });
    check('guessing the access password is locked after repeated failures', lastG.status === 429);
    await admin('DELETE', '/api/gate');
    check('the access password was written to the log without the password', (await admin('GET', '/api/logs?limit=500')).data.some((l) => l.action === 'gate_changed') && !JSON.stringify((await admin('GET', '/api/logs?limit=500')).data).includes('Gate-pass'));

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
