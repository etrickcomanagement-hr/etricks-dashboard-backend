'use strict';
/*
 * Load test: a company's worth of data (many people, clients, years of updates) and many people online at once,
 * each doing what the screens really do (polling the chat, the alerts, the notifications ...).
 *   node scripts/load-test.js [--staff 60] [--clients 40] [--seconds 40] [--rows 1]
 * Prints, per request type, how many calls, the average, the 95th percentile and the slowest time in milliseconds,
 * and what the server says about itself (how long it was stuck, memory).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const STAFF = arg('staff', 60), CLIENTS = arg('clients', 40), SECONDS = arg('seconds', 40), SCALE = arg('rows', 1);
const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'etx-load-'));
const ADMIN_PW = 'Load-admin-pass-1';
const ROOT = path.join(__dirname, '..');

const startServer = () => new Promise((resolve) => {
  const p = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: ADMIN_PW }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => d.toString().includes('running') && resolve(p));
});
const stopServer = (p) => new Promise((r) => { p.on('exit', r); p.kill(); });

function client() {
  const jar = new Map();
  const call = async (method, url, body) => {
    const t0 = performance.now();
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Etricks': '1', ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) { const kv = line.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, ms: performance.now() - t0 };
  };
  return call;
}
const must = async (p) => { const r = await p; if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

(async () => {
  // ---------- 1. structure through the API: department, teams, leaders, members, clients ----------
  console.log(`Preparing: ${STAFF} people online, ${CLIENTS} clients online, a year of data ...`);
  let srv = await startServer();
  const admin = client();
  await must(admin('POST', '/api/auth/login', { portal: 'admin', password: ADMIN_PW }));
  const dept = (await must(admin('GET', '/api/departments')))[0].id;
  await must(admin('PUT', `/api/departments/${dept}/head`, { name: 'Load Head', password: 'LoadHead-Pass-1' }));
  const shift = (await must(admin('GET', '/api/shifts')))[0];
  const teams = [];
  for (let t = 1; t <= 10; t++) {
    const id = (await must(admin('POST', '/api/teams', { departmentId: dept, name: `Team ${t}` }))).id;
    const lead = await must(admin('POST', `/api/teams/${id}/leader`, { name: `Leader ${t}`, password: `LoadLead-Pass-${t}` }));
    await must(admin('PUT', `/api/teams/${id}/member-password`, { password: `LoadTeam-Pass-${t}` }));
    teams.push({ id, lead, members: [] });
  }
  const membersPerTeam = Math.max(1, Math.ceil((STAFF - 12) / 10));
  for (const t of teams) for (let m = 1; m <= membersPerTeam; m++) t.members.push(await must(admin('POST', '/api/employees', { name: `Member ${t.id}-${m}`, teamId: t.id, joinDate: '2026-01-05', shiftId: shift.id })));
  const everyone = teams.flatMap((t) => [t.lead, ...t.members]);
  const clients = [];
  for (let c = 1; c <= CLIENTS + 20; c++) {
    const staff = [...everyone].sort(() => Math.random() - 0.5).slice(0, 5).map((e) => e.id);
    const r = await must(admin('POST', '/api/clients', { departmentId: dept, teamId: null, staffIds: staff, username: `client${String(c).padStart(3, '0')}`, password: 'LoadClient-Pass-1', currency: ['USD', 'AUD', 'GBP'][c % 3] }));
    clients.push({ id: r.id, username: r.username, staff });
  }
  await stopServer(srv);

  // ---------- 2. a lot of history, straight into the database ----------
  const db = new DatabaseSync(path.join(DATA, 'etricks.db'));
  db.exec('PRAGMA journal_mode = WAL');
  const now = new Date().toISOString();
  const ins = (sql, rows) => { const st = db.prepare(sql); db.exec('BEGIN'); for (const r of rows) st.run(...r); db.exec('COMMIT'); };
  const REPORTS = Math.round(400 * SCALE), MSGS = Math.round(80 * SCALE), ORDERS = Math.round(900 * SCALE);
  const rows = [];
  clients.forEach((c) => { for (let i = 0; i < REPORTS; i++) { const who = c.staff[i % c.staff.length]; rows.push([c.id, dayAgo(i % 330), 'eBay', 'Main', 1 + (i % 7), 10 + (i % 40), 25 + (i % 90), `Listed ${i % 20} products and answered buyers`, who, 'Staff', now, now, ['USD', 'AUD', 'GBP'][i % 3], 1 + (i % c.staff.length)]); } });
  ins('INSERT INTO client_reports(client_id,date,market,store,orders,investment,sales,note,submitted_by,submitted_label,created_at,updated_at,currency,account_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows);
  const msgs = [];
  clients.forEach((c, k) => { for (let i = 0; i < MSGS; i++) msgs.push([c.id, i % 9 === 0 ? 'alert' : 'inquiry', i % 2, i % 2 ? null : c.staff[0], i % 2 ? null : 'Staff', `Message number ${i} about the order and the store settings`, new Date(Date.now() - (MSGS - i) * 3600e3).toISOString(), i < MSGS - 3 ? now : null]); });
  ins('INSERT INTO client_messages(client_id,channel,from_client,staff_id,staff_label,body,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)', msgs);
  const orders = [];
  everyone.forEach((e) => { for (let i = 0; i < ORDERS; i++) orders.push([e.id, dept, dayAgo(i % 330), 'Main', 1 + (i % 5), 8 + (i % 30), 20 + (i % 70), 'note', now, now, 'eBay', ['USD', 'AUD', 'GBP'][i % 3], clients.find((c) => c.staff.includes(e.id))?.id ?? null, `ORD-${i}`, 'Buyer Name, City']); });
  ins('INSERT INTO member_orders(employee_id,department_id,date,store,orders,investment,revenue,note,created_at,updated_at,market,currency,client_id,order_id,customer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', orders);
  const notes = [];
  everyone.forEach((e) => { for (let i = 0; i < 250; i++) notes.push(['employee', e.id, 'chat', `Notification ${i}`, 'Something happened', '#/dashboard', new Date(Date.now() - i * 3600e3).toISOString(), i > 5 ? now : null]); });
  for (let i = 0; i < 600; i++) notes.push(['admin', 0, 'chat', `Admin notification ${i}`, 'Something happened', '#/dashboard', new Date(Date.now() - i * 3600e3).toISOString(), i > 5 ? now : null]);
  ins('INSERT INTO notifications(recipient_role,recipient_id,kind,title,body,link,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)', notes);
  const logs = [];
  for (let i = 0; i < Math.round(60000 * SCALE); i++) logs.push([new Date(Date.now() - i * 60e3).toISOString(), 'member', 'Someone', dept, 'orders_reported', 'orders', i, 'details of what happened', '1.2.3.4']);
  ins('INSERT INTO activity_log(ts,actor_role,actor_name,department_id,action,entity,entity_id,details,ip) VALUES (?,?,?,?,?,?,?,?,?)', logs);
  const att = [];
  everyone.forEach((e) => { for (let i = 1; i < 200; i++) att.push([e.id, dayAgo(i), new Date().toISOString(), new Date().toISOString(), 'present', 'approved', now]); });
  ins('INSERT OR IGNORE INTO attendance(employee_id,date,check_in,check_out,status,approval,created_at) VALUES (?,?,?,?,?,?,?)', att);
  db.close();
  console.log(`  data: ${rows.length} client updates, ${msgs.length} chat messages, ${orders.length} sheet rows, ${notes.length} notifications, ${logs.length} log lines; database ${(fs.statSync(path.join(DATA, 'etricks.db')).size / 1048576).toFixed(1)} MB`);

  // ---------- 3. everybody signs in ----------
  srv = await startServer();
  const staffSessions = [];
  const loginTeams = teams.slice();
  const pickStaff = [];
  pickStaff.push({ kind: 'admin', call: admin });
  const hod = client(); await must(hod('POST', '/api/auth/login', { portal: 'hod', departmentId: dept, password: 'LoadHead-Pass-1' }));
  pickStaff.push({ kind: 'hod', call: hod });
  for (const t of loginTeams) {
    const l = client(); await must(l('POST', '/api/auth/login', { portal: 'leader', departmentId: dept, password: `LoadLead-Pass-${teams.indexOf(t) + 1}` }));
    pickStaff.push({ kind: 'leader', call: l, emp: t.lead });
    for (const m of t.members) { const c = client(); await must(c('POST', '/api/auth/login', { portal: 'member', departmentId: dept, password: `LoadTeam-Pass-${teams.indexOf(t) + 1}`, employeeId: m.id, pin: m.pin })); pickStaff.push({ kind: 'member', call: c, emp: m }); }
  }
  const staff = pickStaff.slice(0, STAFF);
  const clientUsers = [];
  for (const c of clients.slice(0, CLIENTS)) { const u = client(); await must(u('POST', '/api/auth/login', { portal: 'client', departmentId: dept, username: c.username, password: 'LoadClient-Pass-1' })); clientUsers.push({ call: u, c }); }
  console.log(`  signed in: ${staff.length} staff and ${clientUsers.length} clients`);

  // ---------- 4. what each screen really asks, and how often ----------
  const stats = new Map();
  const note = (name, ms, status) => { let s = stats.get(name); if (!s) stats.set(name, (s = { name, ms: [], errors: 0 })); s.ms.push(ms); if (status >= 400) s.errors++; };
  const loops = [];
  const every = (ms, fn) => loops.push({ ms, fn });
  const asTimed = (u, label, url) => async () => { const r = await u.call('GET', url); note(label, r.ms, r.status); };
  const stopAt = Date.now() + SECONDS * 1000;
  const run = (ms, fn) => new Promise((resolve) => {
    const tick = async () => { if (Date.now() >= stopAt) return resolve(); try { await fn(); } catch (e) { note('NETWORK ERROR', 0, 599); } setTimeout(tick, ms * (0.85 + Math.random() * 0.3)); };
    setTimeout(tick, Math.random() * ms);
  });
  const jobs = [];
  for (const s of staff) {
    const u = s;
    const one = (label, ms, url) => jobs.push(run(ms, asTimed(u, label, url)));
    one('staff: notifications (every 30 s)', 30000, '/api/notifications?limit=30');
    one('staff: client alerts summary (every 6 s)', 6000, '/api/client-alerts/summary');
    if (s.kind === 'member' || s.kind === 'leader') {
      one('member: my clients list (Client Updates, every 8 s)', 8000, '/api/clients');
      one('member: my daily sheet (every 10 s)', 10000, '/api/orders/me?from=' + dayAgo(30) + '&to=' + ymd(new Date()));
      one('member: client updates list', 8000, `/api/client-reports?from=${dayAgo(6)}&to=${ymd(new Date())}`);
      one('member: dashboard', 20000, '/api/dashboard/me');
    } else {
      one('head/admin: dashboard', 20000, '/api/dashboard');
      one('head/admin: clients list (every 8 s)', 8000, '/api/clients');
      if (s.kind === 'admin') one('admin: backup bar (every 10 min, here every 20 s)', 20000, '/api/backups/summary');
    }
  }
  for (const u of clientUsers) {
    const one = (label, ms, url) => jobs.push(run(ms, asTimed(u, label, url)));
    one('client: summary (every 6 s)', 6000, '/api/portal/summary');
    one('client: chat poll (every 3.5 s)', 3500, '/api/portal/chat?channel=inquiry&after=999999');
    one('client: sheet stamp (every 10 s)', 10000, '/api/portal/sheet/stamp');
    one('client: sales page (every 30 s)', 30000, '/api/portal/sales');
    one('client: chat open (a person opens the page)', 25000, '/api/portal/chat?channel=inquiry');
  }
  console.log(`Running for ${SECONDS} seconds with everybody online ...`);
  const t0 = Date.now();
  await Promise.all(jobs);
  const elapsed = (Date.now() - t0) / 1000;

  // ---------- 5. the numbers ----------
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const rowsOut = [...stats.values()].map((s) => ({ name: s.name, calls: s.ms.length, avg: s.ms.reduce((x, y) => x + y, 0) / s.ms.length, p95: pct(s.ms, 0.95), max: Math.max(...s.ms), errors: s.errors })).sort((a, b) => b.avg * b.calls - a.avg * a.calls);
  const total = rowsOut.reduce((t, r) => t + r.calls, 0);
  console.log(`\n${total} requests in ${elapsed.toFixed(0)} s = ${(total / elapsed).toFixed(1)} per second, ${rowsOut.reduce((t, r) => t + r.errors, 0)} failed\n`);
  console.log('request'.padEnd(58), 'calls'.padStart(6), 'avg ms'.padStart(8), 'p95 ms'.padStart(8), 'max ms'.padStart(8), 'errors'.padStart(7));
  for (const r of rowsOut) console.log(r.name.padEnd(58), String(r.calls).padStart(6), r.avg.toFixed(1).padStart(8), r.p95.toFixed(0).padStart(8), r.max.toFixed(0).padStart(8), String(r.errors).padStart(7));
  const m = (await admin('GET', '/api/metrics')).data;
  console.log(`\nserver: event loop mean ${m.eventLoop.meanMs} ms, p99 ${m.eventLoop.p99Ms} ms, max ${m.eventLoop.maxMs} ms; memory ${m.memoryMb.rss} MB; slow requests (> ${m.slowLimitMs} ms): ${m.slowRequests}`);
  console.log('server view, routes that cost the most time:');
  for (const r of m.routes.slice(0, 8)) console.log('  ', r.route.padEnd(46), `calls ${r.calls}, avg ${r.avgMs} ms, p95 ${r.p95Ms} ms, max ${r.maxMs} ms`);
  await stopServer(srv);
  const worst = Math.max(...rowsOut.map((r) => r.p95));
  console.log(`\nworst 95th percentile: ${worst.toFixed(0)} ms`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
