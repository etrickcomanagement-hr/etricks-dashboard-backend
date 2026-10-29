'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const { HttpError, int, str, oneOf, date, time, range, today, addDays, minutesBetween, toIso, bad } = require('../../core/util');

const STATUSES = ['present', 'late', 'half_day', 'absent', 'leave'];

const SELECT = `
  SELECT a.*, e.name AS employee_name, e.emp_code, e.department_id, e.team_id,
         d.name AS department_name, t.name AS team_name, s.break_minutes AS allowed_break
    FROM attendance a
    JOIN employees e ON e.id=a.employee_id
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id
    LEFT JOIN shifts s ON s.id=e.shift_id`;

// Adds break totals and worked time to attendance rows.
function decorate(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const breaks = db.all(`SELECT * FROM attendance_breaks WHERE attendance_id IN (${ids.map(() => '?').join(',')}) ORDER BY start_at`, ...ids);
  const byId = {};
  for (const b of breaks) (byId[b.attendanceId] ||= []).push(b);
  const nowIso = new Date().toISOString();
  return rows.map((r) => {
    const bs = byId[r.id] || [];
    const breakMinutes = bs.reduce((sum, b) => sum + minutesBetween(b.startAt, b.endAt || r.checkOut || nowIso), 0);
    return {
      ...r, breaks: bs, breakMinutes,
      onBreak: bs.some((b) => !b.endAt),
      overBreak: r.allowedBreak != null && breakMinutes > r.allowedBreak,
      workedMinutes: r.checkIn && r.checkOut ? Math.max(0, minutesBetween(r.checkIn, r.checkOut) - breakMinutes) : null,
    };
  });
}

function lateStatus(shift, now = new Date()) {
  if (!shift) return 'present';
  const [h, mi] = shift.startTime.split(':').map(Number);
  const limit = new Date(now);
  limit.setHours(h, mi + shift.graceMinutes, 0, 0);
  return now > limit ? 'late' : 'present';
}

function ownShift(employeeId) {
  return db.get('SELECT s.* FROM employees e JOIN shifts s ON s.id=e.shift_id WHERE e.id=?', employeeId);
}

// Latest record that is still open (night shifts check out after midnight).
function openRecord(employeeId) {
  return db.get(
    'SELECT * FROM attendance WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL AND date>=? ORDER BY date DESC LIMIT 1',
    employeeId, addDays(today(), -1));
}

function myToday(employeeId) {
  const rec = openRecord(employeeId) || db.get('SELECT * FROM attendance WHERE employee_id=? AND date=?', employeeId, today());
  const [record] = rec ? decorate(db.all(`${SELECT} WHERE a.id=?`, rec.id)) : [null];
  let state = 'not_started';
  if (record) state = record.checkOut ? 'done' : !record.checkIn ? 'done' : record.onBreak ? 'on_break' : 'working';
  return { date: today(), state, record, shift: ownShift(employeeId) };
}

function loadForDecision(ctx, id) {
  const rec = db.get(`${SELECT} WHERE a.id=?`, id);
  if (!rec) throw new HttpError(404, 'Attendance record not found');
  ctx.assertDept(rec.departmentId);
  return rec;
}

module.exports = {
  id: 'attendance',
  name: 'Attendance, Shifts & Breaks',
  description: 'Daily check-in/out, breaks, late tracking and leader approval.',
  order: 30,

  migrations: [
    `CREATE TABLE attendance (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), date TEXT NOT NULL,
       check_in TEXT, check_out TEXT, status TEXT NOT NULL DEFAULT 'present',
       approval TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, note TEXT,
       manual INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (employee_id, date));
     CREATE INDEX idx_att_date ON attendance(date);
     CREATE TABLE attendance_breaks (
       id INTEGER PRIMARY KEY, attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
       start_at TEXT NOT NULL, end_at TEXT);`,
  ],

  routes(m) {
    const lead = ['admin', 'leader'];

    // ---- member self-service ----
    m.get('/api/attendance/me/today', { roles: ['member'] }, (ctx) => myToday(ctx.user.employeeId));

    m.post('/api/attendance/me/action', { roles: ['member'] }, (ctx) => {
      const empId = ctx.user.employeeId;
      const action = oneOf(ctx.body.action, 'Action', ['check_in', 'break_start', 'break_end', 'check_out'], { required: true });
      const nowIso = new Date().toISOString();

      db.tx(() => {
        if (action === 'check_in') {
          if (db.get('SELECT 1 AS x FROM attendance WHERE employee_id=? AND date=?', empId, today())) throw bad('Attendance for today is already recorded');
          db.insert('attendance', { employeeId: empId, date: today(), checkIn: nowIso, status: lateStatus(ownShift(empId)), createdAt: nowIso });
          return;
        }
        const rec = openRecord(empId);
        if (!rec) throw bad('You have not checked in yet');
        const openBreak = db.get('SELECT * FROM attendance_breaks WHERE attendance_id=? AND end_at IS NULL', rec.id);
        if (action === 'break_start') {
          if (openBreak) throw bad('You are already on a break');
          db.insert('attendance_breaks', { attendanceId: rec.id, startAt: nowIso });
        } else if (action === 'break_end') {
          if (!openBreak) throw bad('You are not on a break');
          db.update('attendance_breaks', openBreak.id, { endAt: nowIso });
        } else {
          if (openBreak) db.update('attendance_breaks', openBreak.id, { endAt: nowIso });
          // Re-submitting for approval whenever the day is closed keeps the leader's view current.
          db.update('attendance', rec.id, { checkOut: nowIso, approval: rec.approval === 'rejected' ? 'pending' : rec.approval });
        }
      });
      ctx.audit(action, 'attendance', null, null);
      const result = myToday(empId);
      if ((action === 'check_in' || action === 'check_out') && result.record) {
        const emp = db.get('SELECT name, department_id FROM employees WHERE id=?', empId);
        const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const r = result.record;
        notify.leaderOf(emp.departmentId, action === 'check_in'
          ? { title: `${emp.name} checked in`, body: `At ${hm(r.checkIn)}${r.status === 'late' ? ' (late)' : ''}`, link: '#/attendance', kind: 'attendance' }
          : { title: `${emp.name} checked out`, body: `At ${hm(r.checkOut)}${r.workedMinutes != null ? ` · worked ${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : ''}${r.overBreak ? ' · break over the allowed time' : ''}`, link: '#/attendance', kind: 'attendance' });
      }
      return result;
    });

    m.get('/api/attendance/me', { roles: ['member'] }, (ctx) => {
      const { from, to } = range(ctx.query);
      return decorate(db.all(`${SELECT} WHERE a.employee_id=? AND a.date BETWEEN ? AND ? ORDER BY a.date DESC`, ctx.user.employeeId, from, to));
    });

    // ---- leader / admin ----
    m.get('/api/attendance', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const { from, to } = range(q, { defFrom: today() });
      const dept = ctx.scopeDept(q.departmentId);
      const rows = decorate(db.all(
        `${SELECT}
          WHERE a.date BETWEEN ? AND ? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
            AND (? IS NULL OR a.employee_id=?) AND (? IS NULL OR a.status=?) AND (? IS NULL OR a.approval=?)
            AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ?)
          ORDER BY a.date DESC, e.name LIMIT 3000`,
        from, to, dept, dept, q.teamId || null, q.teamId || null, q.employeeId || null, q.employeeId || null,
        q.status || null, q.status || null, q.approval || null, q.approval || null,
        q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`));
      if (q.format === 'csv') {
        const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
        return ctx.csv('attendance.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' },
          { label: 'Department', key: 'departmentName' }, { label: 'Team', key: 'teamName' }, { label: 'Status', key: 'status' },
          { label: 'Check in', value: (r) => tm(r.checkIn) }, { label: 'Check out', value: (r) => tm(r.checkOut) },
          { label: 'Break (min)', key: 'breakMinutes' }, { label: 'Worked (min)', key: 'workedMinutes' },
          { label: 'Approval', key: 'approval' }, { label: 'Decided by', key: 'decidedBy' }, { label: 'Note', key: 'note' },
        ], rows);
      }
      return rows;
    });

    // Every active employee with their record for one day (so absentees are visible too).
    m.get('/api/attendance/board', { roles: lead }, (ctx) => {
      const day = date(ctx.query.date, 'Date') || today();
      const dept = ctx.scopeDept(ctx.query.departmentId);
      const emps = db.all(
        `SELECT e.id, e.emp_code, e.name, e.department_id, e.team_id, d.name AS department_name, t.name AS team_name, s.name AS shift_name
           FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN shifts s ON s.id=e.shift_id
          WHERE e.status='active' AND e.join_date<=? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
          ORDER BY d.sort, t.name, e.name`, day, dept, dept, ctx.query.teamId || null, ctx.query.teamId || null);
      const recs = Object.fromEntries(decorate(db.all(`${SELECT} WHERE a.date=?`, day)).map((r) => [r.employeeId, r]));
      const leaves = new Set(db.all("SELECT employee_id FROM leave_requests WHERE status='approved' AND from_date<=? AND to_date>=?", day, day).map((l) => l.employeeId));
      const rows = emps.map((e) => ({ ...e, record: recs[e.id] || null, onLeave: leaves.has(e.id) }));
      const count = (fn) => rows.filter(fn).length;
      return {
        date: day, rows,
        summary: {
          total: rows.length,
          present: count((r) => r.record && ['present', 'late', 'half_day'].includes(r.record.status)),
          late: count((r) => r.record?.status === 'late'),
          onLeave: count((r) => r.onLeave && !r.record),
          notMarked: count((r) => !r.record && !r.onLeave),
          pendingApproval: count((r) => r.record?.approval === 'pending'),
        },
      };
    });

    m.post('/api/attendance/:id/decision', { roles: lead }, (ctx) => {
      const rec = loadForDecision(ctx, int(ctx.params.id, 'Record', { required: true }));
      const approval = oneOf(ctx.body.approval, 'Decision', ['approved', 'rejected'], { required: true });
      db.update('attendance', rec.id, { approval, decidedBy: ctx.user.label, decidedAt: new Date().toISOString(), note: str(ctx.body.note, 'Note', { max: 300 }) ?? rec.note });
      ctx.audit(`attendance_${approval}`, 'attendance', rec.id, `${rec.employeeName} ${rec.date}`, rec.departmentId);
      notify.send({ role: 'member', employeeId: rec.employeeId }, { title: `Attendance ${approval}`, body: `Your attendance for ${rec.date} was ${approval}`, link: '#/my-attendance', kind: 'attendance' });
      return { ok: true };
    });

    m.post('/api/attendance/bulk-decision', { roles: lead }, (ctx) => {
      const approval = oneOf(ctx.body.approval, 'Decision', ['approved', 'rejected'], { required: true });
      const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
      if (!ids.length) throw bad('Select at least one record');
      let n = 0;
      db.tx(() => {
        for (const id of ids) {
          const rec = loadForDecision(ctx, id);
          db.update('attendance', id, { approval, decidedBy: ctx.user.label, decidedAt: new Date().toISOString() });
          notify.send({ role: 'member', employeeId: rec.employeeId }, { title: `Attendance ${approval}`, body: `Your attendance for ${rec.date} was ${approval}`, link: '#/my-attendance', kind: 'attendance' });
          n++;
        }
      });
      ctx.audit(`attendance_bulk_${approval}`, 'attendance', null, `${n} record(s)`);
      return { updated: n };
    });

    // Leader/admin adds or corrects a day (absent, leave, forgotten check-out ...). Counts as approved.
    m.post('/api/attendance/manual', { roles: lead }, (ctx) => {
      const b = ctx.body;
      const empId = int(b.employeeId, 'Employee', { required: true });
      const emp = db.get('SELECT * FROM employees WHERE id=?', empId);
      if (!emp) throw new HttpError(404, 'Employee not found');
      ctx.assertDept(emp.departmentId);
      const day = date(b.date, 'Date', { required: true });
      if (day > today()) throw bad('Cannot mark attendance for a future date');
      const status = oneOf(b.status, 'Status', STATUSES, { required: true });
      const inT = time(b.checkIn, 'Check in'), outT = time(b.checkOut, 'Check out');
      const data = {
        status, approval: 'approved', decidedBy: ctx.user.label, decidedAt: new Date().toISOString(), manual: 1,
        note: str(b.note, 'Note', { max: 300 }), checkIn: inT ? toIso(day, inT) : null, checkOut: outT ? toIso(day, outT) : null,
      };
      if (data.checkIn && data.checkOut && data.checkOut <= data.checkIn) data.checkOut = toIso(addDays(day, 1), outT); // overnight shift
      const existing = db.get('SELECT id, check_in FROM attendance WHERE employee_id=? AND date=?', empId, day);
      let id;
      if (existing) {
        const keepTimes = ['present', 'late', 'half_day'].includes(status); // keep the member's own punches unless overridden
        if (keepTimes && !inT) delete data.checkIn;
        if (keepTimes && !outT) delete data.checkOut;
        db.update('attendance', existing.id, data);
        id = existing.id;
      } else {
        id = db.insert('attendance', { employeeId: empId, date: day, createdAt: new Date().toISOString(), ...data }).id;
      }
      ctx.audit('attendance_manual', 'attendance', id, `${emp.name} ${day} ${status}`, emp.departmentId);
      return { id };
    });
  },
};
