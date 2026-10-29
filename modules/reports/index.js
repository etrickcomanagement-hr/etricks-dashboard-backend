'use strict';
const db = require('../../core/db');
const settings = require('../../core/settings');
const { HttpError, range, today, addDays, monthStart, eachDay, parseYmd, oneOf, round, int } = require('../../core/util');

const PRESENT = ['present', 'late', 'half_day'];

// Weighted score over whichever components exist (a new joiner with no tasks is not punished for it).
function score(attRate, taskRate, avgRating) {
  const w = settings.get('scoreWeights');
  const parts = [[attRate, w.attendance], [taskRate, w.tasks], [avgRating == null ? null : (avgRating / 5) * 100, w.rating]].filter(([v]) => v != null);
  const total = parts.reduce((s, [, wt]) => s + wt, 0);
  return total ? round(parts.reduce((s, [v, wt]) => s + v * wt, 0) / total, 1) : null;
}

// Raw per-employee counters for a date range. Everything else (rates, scores) derives from these,
// so team and department reports can simply add the counters up.
function employeeMetrics(from, to, { departmentId = null, teamId = null, employeeId = null } = {}) {
  const emps = db.all(
    `SELECT e.id, e.emp_code, e.name, e.join_date, e.department_id, e.team_id, d.name AS department_name, t.name AS team_name
       FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN teams t ON t.id=e.team_id
      WHERE e.status='active' AND e.join_date<=? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR e.id=?)
      ORDER BY d.sort, t.name, e.name`, to, departmentId, departmentId, teamId, teamId, employeeId, employeeId);
  if (!emps.length) return [];

  const off = settings.get('weeklyOff');
  const att = db.all(
    `SELECT a.employee_id, a.date, a.status, a.approval, a.check_in, a.check_out,
            COALESCE((SELECT SUM((julianday(COALESCE(b.end_at, a.check_out, a.check_in)) - julianday(b.start_at)) * 1440)
                        FROM attendance_breaks b WHERE b.attendance_id=a.id), 0) AS break_min
       FROM attendance a WHERE a.date BETWEEN ? AND ? AND a.approval<>'rejected'`, from, to);
  const attBy = {};
  for (const a of att) (attBy[a.employeeId] ||= []).push(a);

  const leaves = db.all("SELECT employee_id, from_date, to_date FROM leave_requests WHERE status='approved' AND to_date>=? AND from_date<=?", from, to);
  const leaveBy = {};
  for (const l of leaves) (leaveBy[l.employeeId] ||= []).push(l);

  const tasks = db.all(
    `SELECT assigned_to, status, due_date, completed_at FROM tasks WHERE COALESCE(due_date, substr(created_at,1,10)) BETWEEN ? AND ?`, from, to);
  const taskBy = {};
  for (const t of tasks) (taskBy[t.assignedTo] ||= []).push(t);

  const logs = db.all(
    `SELECT employee_id, COALESCE(SUM(hours),0) AS hours, COALESCE(SUM(units),0) AS units, COUNT(rating) AS rating_count, COALESCE(SUM(rating),0) AS rating_sum
       FROM work_logs WHERE date BETWEEN ? AND ? GROUP BY employee_id`, from, to);
  const logBy = Object.fromEntries(logs.map((l) => [l.employeeId, l]));

  const now = today();
  return emps.map((e) => {
    const rows = attBy[e.id] || [];
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    const start = e.joinDate > from ? e.joinDate : from;
    let end = to > now ? now : to;
    if (end === now && !byDate[now]) end = addDays(now, -1); // today only counts once the person has a record
    const days = start <= end ? eachDay(start, end).filter((d) => !off.includes(parseYmd(d).getDay())) : [];

    const leaveDates = new Set();
    for (const l of leaveBy[e.id] || []) for (const d of eachDay(l.fromDate, l.toDate)) leaveDates.add(d);
    for (const r of rows) if (r.status === 'leave') leaveDates.add(r.date);

    let present = 0, late = 0, leaveDays = 0, workedMin = 0, workedDays = 0;
    for (const d of days) {
      const r = byDate[d];
      if (r && PRESENT.includes(r.status)) {
        present += r.status === 'half_day' ? 0.5 : 1;
        if (r.status === 'late') late++;
        if (r.checkIn && r.checkOut) {
          workedMin += Math.max(0, (new Date(r.checkOut) - new Date(r.checkIn)) / 60000 - r.breakMin);
          workedDays++;
        }
      } else if (leaveDates.has(d) || r?.status === 'leave') leaveDays++;
    }
    const ts = taskBy[e.id] || [];
    const done = ts.filter((t) => t.status === 'done');
    const lg = logBy[e.id];
    return {
      employeeId: e.id, empCode: e.empCode, name: e.name, departmentId: e.departmentId, departmentName: e.departmentName,
      teamId: e.teamId, teamName: e.teamName,
      workingDays: days.length, presentDays: present, leaveDays, lateCount: late, workedMinutes: workedMin, workedDays,
      tasksTotal: ts.length, tasksDone: done.length,
      tasksOnTime: done.filter((t) => !t.dueDate || t.completedAt.slice(0, 10) <= t.dueDate).length,
      tasksOverdue: ts.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < now).length,
      hoursLogged: lg ? round(lg.hours) : 0, units: lg ? lg.units : 0, ratingCount: lg ? lg.ratingCount : 0, ratingSum: lg ? lg.ratingSum : 0,
    };
  });
}

// Turns raw counters (one employee, or the sum of many) into the figures shown in reports.
function finish(c) {
  const required = Math.max(0, c.workingDays - c.leaveDays);
  const attendanceRate = required > 0 ? round(Math.min(100, (c.presentDays / required) * 100), 1) : null;
  const taskRate = c.tasksTotal > 0 ? round((c.tasksDone / c.tasksTotal) * 100, 1) : null;
  const avgRating = c.ratingCount > 0 ? round(c.ratingSum / c.ratingCount, 2) : null;
  return {
    ...c, absentDays: round(Math.max(0, required - c.presentDays), 1), attendanceRate, taskRate, avgRating,
    avgWorkedHours: c.workedDays > 0 ? round(c.workedMinutes / c.workedDays / 60, 1) : null,
    onTimeRate: c.tasksDone > 0 ? round((c.tasksOnTime / c.tasksDone) * 100, 1) : null,
    score: score(attendanceRate, taskRate, avgRating),
  };
}

const SUM_KEYS = ['workingDays', 'presentDays', 'leaveDays', 'lateCount', 'workedMinutes', 'workedDays', 'tasksTotal', 'tasksDone', 'tasksOnTime', 'tasksOverdue', 'hoursLogged', 'units', 'ratingCount', 'ratingSum'];
function aggregate(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, { ...labelFn(r), employees: 0, ...Object.fromEntries(SUM_KEYS.map((s) => [s, 0])) });
    const g = groups.get(k);
    g.employees++;
    for (const s of SUM_KEYS) g[s] += r[s];
  }
  return [...groups.values()].map((g) => finish({ ...g, hoursLogged: round(g.hoursLogged) }));
}

function performance(level, from, to, scope) {
  const emps = employeeMetrics(from, to, scope);
  if (level === 'employee') return emps.map(finish).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (level === 'team') {
    return aggregate(emps, (r) => r.teamId ?? `d${r.departmentId}`, (r) => ({ teamId: r.teamId, teamName: r.teamName || '(No team)', departmentId: r.departmentId, departmentName: r.departmentName }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }
  const fin = Object.fromEntries(db.all(
    `SELECT department_id, SUM(orders) AS orders, SUM(investment) AS investment, SUM(revenue) AS revenue, SUM(expenses) AS expenses
       FROM finance_entries WHERE date BETWEEN ? AND ? GROUP BY department_id`, from, to).map((f) => [f.departmentId, f]));
  return aggregate(emps, (r) => r.departmentId, (r) => ({ departmentId: r.departmentId, departmentName: r.departmentName }))
    .map((d) => {
      const f = fin[d.departmentId] || { orders: 0, investment: 0, revenue: 0, expenses: 0 };
      return { ...d, orders: f.orders, investment: round(f.investment), revenue: round(f.revenue), profit: round(f.revenue - f.investment - f.expenses) };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

const COLUMNS = {
  employee: [
    { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'name' }, { label: 'Department', key: 'departmentName' }, { label: 'Team', key: 'teamName' },
  ],
  team: [{ label: 'Team', key: 'teamName' }, { label: 'Department', key: 'departmentName' }, { label: 'Employees', key: 'employees' }],
  department: [{ label: 'Department', key: 'departmentName' }, { label: 'Employees', key: 'employees' }],
};
const METRIC_COLUMNS = [
  { label: 'Working days', key: 'workingDays' }, { label: 'Present days', key: 'presentDays' }, { label: 'Leave days', key: 'leaveDays' },
  { label: 'Absent days', key: 'absentDays' }, { label: 'Late', key: 'lateCount' }, { label: 'Attendance %', key: 'attendanceRate' },
  { label: 'Avg hours/day', key: 'avgWorkedHours' }, { label: 'Tasks', key: 'tasksTotal' }, { label: 'Tasks done', key: 'tasksDone' },
  { label: 'Task completion %', key: 'taskRate' }, { label: 'On-time %', key: 'onTimeRate' }, { label: 'Overdue', key: 'tasksOverdue' },
  { label: 'Hours logged', key: 'hoursLogged' }, { label: 'Units/orders handled', key: 'units' }, { label: 'Avg rating (1-5)', key: 'avgRating' },
  { label: 'Score', key: 'score' },
];
const FINANCE_COLUMNS = [
  { label: 'Orders', key: 'orders' }, { label: 'Investment', key: 'investment' }, { label: 'Sales', key: 'revenue' }, { label: 'Profit', key: 'profit' },
];

// One row per team member: attendance + tasks (from employeeMetrics) with the orders they reported and complaints about them.
function memberRows(from, to, scope) {
  const base = performance('employee', from, to, scope);
  const orders = Object.fromEntries(db.all(
    `SELECT employee_id, COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(investment),0) AS investment, COALESCE(SUM(revenue),0) AS revenue
       FROM member_orders WHERE date BETWEEN ? AND ? GROUP BY employee_id`, from, to).map((o) => [o.employeeId, o]));
  const complaints = Object.fromEntries(db.all(
    `SELECT employee_id, COUNT(*) AS total, SUM(status IN ('open','under_review')) AS open FROM complaints
      WHERE COALESCE(incident_date, substr(created_at,1,10)) BETWEEN ? AND ? GROUP BY employee_id`, from, to).map((c) => [c.employeeId, c]));
  const openAll = Object.fromEntries(db.all("SELECT employee_id, COUNT(*) AS n FROM complaints WHERE status IN ('open','under_review') GROUP BY employee_id").map((c) => [c.employeeId, c.n]));
  return base.map((r) => {
    const o = orders[r.employeeId] || { orders: 0, investment: 0, revenue: 0 };
    return {
      ...r, ordersTaken: o.orders, investment: round(o.investment), sales: round(o.revenue), profit: round(o.revenue - o.investment),
      complaints: complaints[r.employeeId]?.total || 0, openComplaints: openAll[r.employeeId] || 0,
    };
  });
}

// Everything about one person for a period: the printable "member report".
function employeeReport(employeeId, from, to) {
  const emp = db.get(
    `SELECT e.id, e.emp_code, e.name, e.designation, e.role, e.status, e.join_date, e.phone, e.department_id, d.name AS department_name,
            t.name AS team_name, s.name AS shift_name
       FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN shifts s ON s.id=e.shift_id WHERE e.id=?`, employeeId);
  if (!emp) throw new HttpError(404, 'Employee not found');
  const row = memberRows(from, to, { employeeId })[0] || null;
  const orderRows = db.all('SELECT * FROM member_orders WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 200', employeeId, from, to);
  const o = orderRows.reduce((s, r) => ({ orders: s.orders + r.orders, investment: s.investment + r.investment, revenue: s.revenue + r.revenue }), { orders: 0, investment: 0, revenue: 0 });
  return {
    employee: emp, from, to,
    metrics: row,
    orders: { orders: o.orders, investment: round(o.investment), sales: round(o.revenue), profit: round(o.revenue - o.investment), entries: orderRows.length, rows: orderRows.map((r) => ({ ...r, profit: round(r.revenue - r.investment) })) },
    attendance: db.all('SELECT date, status, approval, check_in, check_out FROM attendance WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 120', employeeId, from, to),
    tasks: db.all(
      `SELECT title, status, priority, due_date, completed_at FROM tasks WHERE assigned_to=? AND COALESCE(due_date, substr(created_at,1,10)) BETWEEN ? AND ?
        ORDER BY COALESCE(due_date, substr(created_at,1,10)) DESC LIMIT 60`, employeeId, from, to),
    complaints: db.all(
      `SELECT id, category, severity, description, incident_date, status, filed_by, resolution_note, member_response, created_at FROM complaints
        WHERE employee_id=? AND (COALESCE(incident_date, substr(created_at,1,10)) BETWEEN ? AND ? OR status IN ('open','under_review')) ORDER BY created_at DESC`, employeeId, from, to),
  };
}

function todayStats(departmentId) {
  const day = today();
  const emps = db.all("SELECT id, department_id FROM employees WHERE status='active' AND join_date<=? AND (? IS NULL OR department_id=?)", day, departmentId, departmentId);
  const recs = db.all(
    `SELECT a.employee_id, a.status, a.approval, e.department_id FROM attendance a JOIN employees e ON e.id=a.employee_id
      WHERE a.date=? AND (? IS NULL OR e.department_id=?)`, day, departmentId, departmentId);
  const recBy = Object.fromEntries(recs.map((r) => [r.employeeId, r]));
  const onLeave = new Set(db.all("SELECT employee_id FROM leave_requests WHERE status='approved' AND from_date<=? AND to_date>=?", day, day).map((l) => l.employeeId));
  const out = {};
  for (const e of emps) {
    const o = (out[e.departmentId] ||= { employees: 0, present: 0, late: 0, onLeave: 0, notMarked: 0, pendingAttendance: 0 });
    const r = recBy[e.id];
    o.employees++;
    if (r && PRESENT.includes(r.status)) { o.present++; if (r.status === 'late') o.late++; }
    else if (r?.status === 'leave' || (!r && onLeave.has(e.id))) o.onLeave++;
    else if (!r) o.notMarked++;
    if (r?.approval === 'pending') o.pendingAttendance++;
  }
  return out;
}

module.exports = {
  id: 'reports',
  name: 'Dashboard & Performance Reports',
  description: 'Admin / leader dashboards and employee, team and department performance.',
  order: 70,

  routes(m) {
    const lead = ['admin', 'leader'];

    m.get('/api/reports/performance', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const level = oneOf(q.level, 'Level', ['employee', 'team', 'department'], { def: 'employee' });
      const { from, to } = range(q);
      const dept = ctx.scopeDept(q.departmentId);
      const rows = performance(level, from, to, { departmentId: dept, teamId: q.teamId || null });
      if (q.format === 'csv') {
        const cols = [...COLUMNS[level], ...METRIC_COLUMNS, ...(level === 'department' ? FINANCE_COLUMNS : [])];
        return ctx.csv(`performance-${level}-${from}-to-${to}.csv`, cols, rows);
      }
      return { level, from, to, rows };
    });

    // All members side by side: attendance, orders, sales, tasks, complaints, score.
    m.get('/api/reports/members', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const { from, to } = range(q);
      const rows = memberRows(from, to, { departmentId: ctx.scopeDept(q.departmentId), teamId: q.teamId || null });
      if (q.format === 'csv') {
        return ctx.csv(`member-report-${from}-to-${to}.csv`, [
          { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'name' }, { label: 'Department', key: 'departmentName' }, { label: 'Team', key: 'teamName' },
          { label: 'Attendance %', key: 'attendanceRate' }, { label: 'Present days', key: 'presentDays' }, { label: 'Absent days', key: 'absentDays' }, { label: 'Late', key: 'lateCount' },
          { label: 'Orders taken', key: 'ordersTaken' }, { label: 'Investment', key: 'investment' }, { label: 'Sales', key: 'sales' }, { label: 'Profit', key: 'profit' },
          { label: 'Tasks done', key: 'tasksDone' }, { label: 'Tasks total', key: 'tasksTotal' }, { label: 'Complaints (period)', key: 'complaints' },
          { label: 'Open complaints', key: 'openComplaints' }, { label: 'Score', key: 'score' },
        ], rows);
      }
      return { from, to, rows };
    });

    m.get('/api/reports/employee/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Employee', { required: true });
      const { from, to } = range(ctx.query);
      const rep = employeeReport(id, from, to);
      ctx.assertDept(rep.employee.departmentId);
      return rep;
    });

    m.get('/api/reports/me', { roles: ['member'] }, (ctx) => {
      const { from, to } = range(ctx.query);
      return employeeReport(ctx.user.employeeId, from, to);
    });

    m.get('/api/dashboard', { roles: lead }, (ctx) => {
      const dept = ctx.scopeDept(ctx.query.departmentId);
      const day = today();
      const mFrom = monthStart();
      const stats = todayStats(dept);
      const sum = (key) => Object.values(stats).reduce((s, o) => s + o[key], 0);

      const trend = eachDay(addDays(day, -13), day).map((d) => ({
        date: d,
        present: db.get(
          `SELECT COUNT(*) AS n FROM attendance a JOIN employees e ON e.id=a.employee_id
            WHERE a.date=? AND a.status IN ('present','late','half_day') AND a.approval<>'rejected' AND (? IS NULL OR e.department_id=?)`, d, dept, dept).n,
      }));

      const taskRows = db.all(
        `SELECT status, due_date FROM tasks WHERE (? IS NULL OR department_id=?)`, dept, dept);
      const fin = db.all('SELECT * FROM finance_entries WHERE date>=? AND (? IS NULL OR department_id=?)', mFrom, dept, dept);
      const tot = { orders: 0, investment: 0, revenue: 0, expenses: 0 };
      for (const f of fin) for (const k of Object.keys(tot)) tot[k] += f[k];

      const perf = performance('employee', mFrom, day, { departmentId: dept });
      const departments = ctx.user.role === 'admin' && !dept
        ? db.all('SELECT id, name, color FROM departments WHERE active=1 ORDER BY sort, name').map((d) => {
            const f = fin.filter((x) => x.departmentId === d.id);
            const t = f.reduce((a, x) => ({ orders: a.orders + x.orders, investment: a.investment + x.investment, revenue: a.revenue + x.revenue, expenses: a.expenses + x.expenses }), { orders: 0, investment: 0, revenue: 0, expenses: 0 });
            return {
              ...d, ...(stats[d.id] || { employees: 0, present: 0, late: 0, onLeave: 0, notMarked: 0, pendingAttendance: 0 }),
              pendingLeave: db.get("SELECT COUNT(*) AS n FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.status='pending' AND e.department_id=?", d.id).n,
              openTasks: db.get("SELECT COUNT(*) AS n FROM tasks WHERE department_id=? AND status<>'done'", d.id).n,
              orders: t.orders, revenue: round(t.revenue), investment: round(t.investment), profit: round(t.revenue - t.investment - t.expenses),
            };
          })
        : null;

      return {
        date: day, scope: dept,
        today: { employees: sum('employees'), present: sum('present'), late: sum('late'), onLeave: sum('onLeave'), notMarked: sum('notMarked') },
        pending: {
          attendance: sum('pendingAttendance'),
          leave: db.get("SELECT COUNT(*) AS n FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.status='pending' AND (? IS NULL OR e.department_id=?)", dept, dept).n,
        },
        tasks: {
          open: taskRows.filter((t) => t.status !== 'done').length,
          overdue: taskRows.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < day).length,
          done: taskRows.filter((t) => t.status === 'done').length,
        },
        finance: { from: mFrom, to: day, orders: tot.orders, investment: round(tot.investment), revenue: round(tot.revenue), profit: round(tot.revenue - tot.investment - tot.expenses) },
        trend, departments,
        topPerformers: perf.filter((p) => p.score != null).slice(0, 5),
        lowAttendance: perf.filter((p) => p.attendanceRate != null && p.workingDays >= 3).sort((a, b) => a.attendanceRate - b.attendanceRate).slice(0, 5),
      };
    });

    m.get('/api/dashboard/me', { roles: ['member'] }, (ctx) => {
      const day = today();
      const [me] = performance('employee', monthStart(), day, { employeeId: ctx.user.employeeId });
      const pendingLeave = db.get("SELECT COUNT(*) AS n FROM leave_requests WHERE employee_id=? AND status='pending'", ctx.user.employeeId).n;
      const rank = (() => {
        const all = performance('employee', monthStart(), day, { departmentId: ctx.user.departmentId });
        const idx = all.findIndex((r) => r.employeeId === ctx.user.employeeId);
        return idx >= 0 && all[idx].score != null ? { position: idx + 1, of: all.length } : null;
      })();
      return { month: me || null, pendingLeave, rank };
    });
  },
};
