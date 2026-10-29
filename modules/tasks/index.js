'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const cf = require('../../core/customfields');
const { HttpError, int, str, num, oneOf, date, range, today, addDays, bad, parseJson } = require('../../core/util');

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

const TASK_SELECT = `
  SELECT k.*, e.name AS assignee_name, e.emp_code, e.team_id, t.name AS team_name, d.name AS department_name
    FROM tasks k
    JOIN employees e ON e.id=k.assigned_to
    JOIN departments d ON d.id=k.department_id
    LEFT JOIN teams t ON t.id=e.team_id`;

const shapeTask = (r) => ({ ...r, custom: parseJson(r.custom, {}), overdue: r.status !== 'done' && !!r.dueDate && r.dueDate < today() });

const WORKLOG_SELECT = `
  SELECT w.*, e.name AS employee_name, e.emp_code, e.department_id, k.title AS task_title
    FROM work_logs w
    JOIN employees e ON e.id=w.employee_id
    LEFT JOIN tasks k ON k.id=w.task_id`;

module.exports = {
  id: 'tasks',
  name: 'Tasks & Daily Work',
  description: 'Task assignment by team leaders and daily work logs from employees.',
  order: 50,

  migrations: [
    `CREATE TABLE tasks (
       id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id), title TEXT NOT NULL, description TEXT,
       assigned_to INTEGER NOT NULL REFERENCES employees(id), assigned_by TEXT, priority TEXT NOT NULL DEFAULT 'medium',
       status TEXT NOT NULL DEFAULT 'todo', due_date TEXT, completed_at TEXT, custom TEXT DEFAULT '{}',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX idx_task_assignee ON tasks(assigned_to, status);
     CREATE INDEX idx_task_dept ON tasks(department_id, status);
     CREATE TABLE work_logs (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), date TEXT NOT NULL,
       task_id INTEGER REFERENCES tasks(id), summary TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0,
       rating INTEGER, review_note TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL);
     CREATE INDEX idx_wl_emp ON work_logs(employee_id, date);`,
  ],

  routes(m) {
    const lead = ['admin', 'leader'];

    // ---- tasks: leader side ----
    m.get('/api/tasks', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const rows = db.all(
        `${TASK_SELECT}
          WHERE (? IS NULL OR k.department_id=?) AND (? IS NULL OR k.status=?) AND (? IS NULL OR k.assigned_to=?)
            AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR k.priority=?) AND (? IS NULL OR k.title LIKE ? OR e.name LIKE ?)
          ORDER BY (k.status='done'), k.due_date IS NULL, k.due_date LIMIT 2000`,
        dept, dept, q.status || null, q.status || null, q.employeeId || null, q.employeeId || null,
        q.teamId || null, q.teamId || null, q.priority || null, q.priority || null,
        q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`).map(shapeTask);
      const filtered = q.overdue === '1' ? rows.filter((r) => r.overdue) : rows;
      if (q.format === 'csv') {
        return ctx.csv('tasks.csv', [
          { label: 'Title', key: 'title' }, { label: 'Assigned to', key: 'assigneeName' }, { label: 'Team', key: 'teamName' },
          { label: 'Department', key: 'departmentName' }, { label: 'Priority', key: 'priority' }, { label: 'Status', key: 'status' },
          { label: 'Due', key: 'dueDate' }, { label: 'Completed', key: 'completedAt' }, { label: 'Assigned by', key: 'assignedBy' },
          ...cf.definitions('task').map((d) => ({ label: d.label, value: (r) => r.custom[d.key] })),
        ], filtered);
      }
      return filtered;
    });

    // Assign to one employee, or to everyone in a team (one task each).
    m.post('/api/tasks', { roles: lead }, (ctx) => {
      const b = ctx.body;
      const title = str(b.title, 'Title', { required: true, max: 150 });
      const targets = [];
      if (b.teamId) {
        const team = db.get('SELECT * FROM teams WHERE id=?', int(b.teamId, 'Team'));
        if (!team) throw bad('Team not found');
        ctx.assertDept(team.departmentId);
        targets.push(...db.all("SELECT id, department_id FROM employees WHERE team_id=? AND status='active'", team.id));
        if (!targets.length) throw bad('This team has no active members');
      } else {
        const e = db.get("SELECT id, department_id FROM employees WHERE id=? AND status='active'", int(b.assignedTo, 'Assignee', { required: true }));
        if (!e) throw bad('Employee not found or inactive');
        ctx.assertDept(e.departmentId);
        targets.push(e);
      }
      const now = new Date().toISOString();
      const common = {
        title, description: str(b.description, 'Description', { max: 1000 }), assignedBy: ctx.user.label,
        priority: oneOf(b.priority, 'Priority', PRIORITIES, { def: 'medium' }), dueDate: date(b.dueDate, 'Due date'),
        custom: JSON.stringify(cf.sanitize('task', b.custom)), createdAt: now, updatedAt: now,
      };
      db.tx(() => { for (const e of targets) db.insert('tasks', { ...common, departmentId: e.departmentId, assignedTo: e.id }); });
      for (const e of targets) {
        notify.send({ role: 'member', employeeId: e.id }, {
          title: 'New task assigned to you', body: `${title}${common.dueDate ? ` · due ${common.dueDate}` : ''}${common.priority === 'urgent' || common.priority === 'high' ? ` · ${common.priority} priority` : ''}`,
          link: '#/my-tasks', kind: 'task',
        });
      }
      ctx.audit('create', 'task', null, `${title} -> ${targets.length} employee(s)`, targets[0].departmentId);
      return { created: targets.length };
    });

    m.put('/api/tasks/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get('SELECT * FROM tasks WHERE id=?', id);
      if (!t) throw new HttpError(404, 'Task not found');
      ctx.assertDept(t.departmentId);
      const b = ctx.body;
      const status = oneOf(b.status, 'Status', STATUSES, { def: t.status });
      let assignedTo = t.assignedTo;
      if (b.assignedTo && Number(b.assignedTo) !== t.assignedTo) {
        const e = db.get("SELECT id FROM employees WHERE id=? AND department_id=? AND status='active'", int(b.assignedTo, 'Assignee'), t.departmentId);
        if (!e) throw bad('Assignee must be an active employee of this department');
        assignedTo = e.id;
      }
      db.update('tasks', id, {
        title: str(b.title, 'Title', { required: true, max: 150 }), description: str(b.description, 'Description', { max: 1000 }),
        priority: oneOf(b.priority, 'Priority', PRIORITIES, { def: t.priority }), dueDate: date(b.dueDate, 'Due date'),
        assignedTo, status, completedAt: status === 'done' ? t.completedAt || new Date().toISOString() : null,
        custom: JSON.stringify(cf.sanitize('task', b.custom, parseJson(t.custom, {}))), updatedAt: new Date().toISOString(),
      });
      ctx.audit('update', 'task', id, b.title, t.departmentId);
      if (assignedTo !== t.assignedTo) notify.send({ role: 'member', employeeId: assignedTo }, { title: 'A task was assigned to you', body: str(b.title, 'Title', { max: 150 }), link: '#/my-tasks', kind: 'task' });
      return { ok: true };
    });

    m.del('/api/tasks/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get('SELECT * FROM tasks WHERE id=?', id);
      if (!t) throw new HttpError(404, 'Task not found');
      ctx.assertDept(t.departmentId);
      db.tx(() => { db.run('UPDATE work_logs SET task_id=NULL WHERE task_id=?', id); db.run('DELETE FROM tasks WHERE id=?', id); });
      ctx.audit('delete', 'task', id, t.title, t.departmentId);
      return { ok: true };
    });

    // ---- tasks: member side ----
    m.get('/api/tasks/me', { roles: ['member'] }, (ctx) =>
      db.all(`${TASK_SELECT} WHERE k.assigned_to=? ORDER BY (k.status='done'), k.due_date IS NULL, k.due_date`, ctx.user.employeeId).map(shapeTask));

    m.post('/api/tasks/:id/status', { roles: ['member'] }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get('SELECT * FROM tasks WHERE id=? AND assigned_to=?', id, ctx.user.employeeId);
      if (!t) throw new HttpError(404, 'Task not found');
      const status = oneOf(ctx.body.status, 'Status', STATUSES, { required: true });
      db.update('tasks', id, { status, completedAt: status === 'done' ? t.completedAt || new Date().toISOString() : null, updatedAt: new Date().toISOString() });
      ctx.audit('task_status', 'task', id, `${t.title}: ${status}`);
      if (status !== t.status && (status === 'done' || status === 'blocked')) {
        const who = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId).name;
        notify.leaderOf(t.departmentId, { title: `${who} marked a task ${status === 'done' ? 'done' : 'blocked'}`, body: t.title, link: '#/tasks', kind: 'task' });
      }
      return { ok: true };
    });

    // ---- daily work logs ----
    m.post('/api/worklogs', { roles: ['member'] }, (ctx) => {
      const b = ctx.body;
      const day = date(b.date, 'Date') || today();
      if (day > today()) throw bad('Cannot log work for a future date');
      const taskId = int(b.taskId, 'Task');
      if (taskId && !db.get('SELECT 1 AS x FROM tasks WHERE id=? AND assigned_to=?', taskId, ctx.user.employeeId)) throw bad('Task not found');
      const r = db.insert('work_logs', {
        employeeId: ctx.user.employeeId, date: day, taskId, summary: str(b.summary, 'What did you work on?', { required: true, max: 600 }),
        hours: num(b.hours, 'Hours', { min: 0, max: 24 }) ?? 0, units: int(b.units, 'Units / orders handled', { min: 0, max: 100000 }) ?? 0,
        createdAt: new Date().toISOString(),
      });
      ctx.audit('worklog', 'work_log', r.id, day);
      return { id: r.id };
    });

    m.get('/api/worklogs/me', { roles: ['member'] }, (ctx) => {
      const { from, to } = range(ctx.query, { defFrom: addDays(today(), -30) });
      return db.all(`${WORKLOG_SELECT} WHERE w.employee_id=? AND w.date BETWEEN ? AND ? ORDER BY w.date DESC, w.id DESC`, ctx.user.employeeId, from, to);
    });

    m.get('/api/worklogs', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const { from, to } = range(q, { defFrom: today() });
      const rows = db.all(
        `${WORKLOG_SELECT} WHERE w.date BETWEEN ? AND ? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR w.employee_id=?)
           AND (? IS NULL OR e.name LIKE ? OR w.summary LIKE ?) ORDER BY w.date DESC, e.name LIMIT 2000`,
        from, to, dept, dept, q.employeeId || null, q.employeeId || null, q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`);
      if (q.format === 'csv') {
        return ctx.csv('work-logs.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' },
          { label: 'Task', key: 'taskTitle' }, { label: 'Summary', key: 'summary' }, { label: 'Hours', key: 'hours' },
          { label: 'Units/orders', key: 'units' }, { label: 'Rating', key: 'rating' }, { label: 'Review note', key: 'reviewNote' },
        ], rows);
      }
      return rows;
    });

    m.post('/api/worklogs/:id/review', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Work log', { required: true });
      const w = db.get(`${WORKLOG_SELECT} WHERE w.id=?`, id);
      if (!w) throw new HttpError(404, 'Work log not found');
      ctx.assertDept(w.departmentId);
      db.update('work_logs', id, {
        rating: int(ctx.body.rating, 'Rating', { required: true, min: 1, max: 5 }), reviewNote: str(ctx.body.note, 'Note', { max: 300 }),
        reviewedBy: ctx.user.label, reviewedAt: new Date().toISOString(),
      });
      ctx.audit('worklog_reviewed', 'work_log', id, `${w.employeeName} ${w.date}`, w.departmentId);
      return { ok: true };
    });
  },
};
