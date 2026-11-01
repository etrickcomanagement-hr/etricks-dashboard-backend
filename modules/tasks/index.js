'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const cf = require('../../core/customfields');
const { HttpError, int, str, num, oneOf, date, range, today, addDays, bad, parseJson } = require('../../core/util');

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// A task is only 'done' after the person who assigned it approves the submission.
const STATUSES = ['todo', 'in_progress', 'blocked', 'changes_requested', 'pending_approval', 'rejected', 'done'];
const WORKING = ['todo', 'in_progress', 'blocked']; // what the assignee may set by hand
const DECISIONS = { approve: 'done', changes: 'changes_requested', reject: 'rejected' };

// Department and team come from the assignee as they are now, so a transferred person keeps their tasks and takes them along.
const TASK_SELECT = `
  SELECT k.*, e.name AS assignee_name, e.emp_code, e.role AS assignee_role, e.department_id AS assignee_department_id, e.team_id, t.name AS team_name, d.name AS department_name
    FROM tasks k
    JOIN employees e ON e.id=k.assigned_to
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id`;

const shapeTask = (r) => ({ ...r, custom: parseJson(r.custom, {}), overdue: r.status !== 'done' && !!r.dueDate && r.dueDate < today() });
const assignee = (t) => ({ id: t.assignedTo, role: t.assigneeRole, departmentId: t.assigneeDepartmentId, teamId: t.teamId });

// Who reviews a submission: the person who assigned the task, the admin, or the head of the department.
const canReviewTask = (ctx, t) => ctx.user.role === 'admin' || (!!t.assignedById && t.assignedById === ctx.user.employeeId) || (ctx.user.role === 'hod' && ctx.canManage(assignee(t)));

// The person the submission goes to: whoever assigned it (the admin, a head or a leader); older tasks go to the people above.
function tellAssigner(t, assigneeId, payload) {
  if (t.assignedById) notify.send({ employeeId: t.assignedById }, payload);
  else if (t.assignedByRole === 'admin') notify.toAdmin(payload);
  else notify.toSuperiors(assigneeId, payload);
}

function submitForApproval(ctx, t, note) {
  const me = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId).name;
  const text = str(note, 'Completion note', { max: 600 });
  db.update('tasks', t.id, {
    status: 'pending_approval', submitNote: text, submittedAt: new Date().toISOString(), completedAt: null,
    reviewDecision: null, reviewNote: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date().toISOString(),
  });
  ctx.audit('task_submitted', 'task', t.id, t.title);
  tellAssigner(t, ctx.user.employeeId, { title: `${me} submitted a task for approval`, body: `${t.title}${text ? ` · ${text}` : ''}`, link: '#/tasks', kind: 'task' });
}

const WORKLOG_SELECT = `
  SELECT w.*, e.name AS employee_name, e.emp_code, e.role, e.department_id, e.team_id, k.title AS task_title
    FROM work_logs w
    JOIN employees e ON e.id=w.employee_id
    LEFT JOIN tasks k ON k.id=w.task_id`;

module.exports = {
  id: 'tasks',
  name: 'Tasks & Daily Work',
  description: 'Task assignment by heads and team leaders and daily work logs.',
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
    // 2: optional "Remarks / Issues" on a daily work log (replaces the units field)
    'ALTER TABLE work_logs ADD COLUMN remarks TEXT;',
    // 3: task approval - who assigned it, what was submitted, and the latest review
    `ALTER TABLE tasks ADD COLUMN assigned_by_id INTEGER;
     ALTER TABLE tasks ADD COLUMN assigned_by_role TEXT;
     ALTER TABLE tasks ADD COLUMN submit_note TEXT;
     ALTER TABLE tasks ADD COLUMN submitted_at TEXT;
     ALTER TABLE tasks ADD COLUMN review_decision TEXT;
     ALTER TABLE tasks ADD COLUMN review_note TEXT;
     ALTER TABLE tasks ADD COLUMN reviewed_by TEXT;
     ALTER TABLE tasks ADD COLUMN reviewed_at TEXT;
     UPDATE tasks SET review_decision='approved' WHERE status='done';`,
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['hod', 'leader', 'member'];

    // ---- tasks: managers ----
    m.get('/api/tasks', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const rows = db.all(
        `${TASK_SELECT}
          WHERE instr(?, ',' || e.role || ',') > 0 AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR k.status=?) AND (? IS NULL OR k.assigned_to=?)
            AND (? IS NULL OR e.team_id=?) AND (? IS NULL OR k.priority=?) AND (? IS NULL OR k.title LIKE ? OR e.name LIKE ?)
          ORDER BY (k.status='done'), k.due_date IS NULL, k.due_date LIMIT 2000`,
        ctx.rolesCsv(), dept, dept, q.status || null, q.status || null, q.employeeId || null, q.employeeId || null,
        team, team, q.priority || null, q.priority || null,
        q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`).map(shapeTask).map((t) => ({ ...t, canReview: t.status === 'pending_approval' && canReviewTask(ctx, t) }));
      const filtered = q.overdue === '1' ? rows.filter((r) => r.overdue) : rows;
      if (q.format === 'csv') {
        return ctx.csv('tasks.csv', [
          { label: 'Title', key: 'title' }, { label: 'Assigned to', key: 'assigneeName' }, { label: 'Team', key: 'teamName' },
          { label: 'Department', key: 'departmentName' }, { label: 'Priority', key: 'priority' }, { label: 'Status', key: 'status' },
          { label: 'Due', key: 'dueDate' }, { label: 'Completed', key: 'completedAt' }, { label: 'Assigned by', key: 'assignedBy' }, { label: 'Last review', key: 'reviewNote' },
          ...cf.definitions('task').map((d) => ({ label: d.label, value: (r) => r.custom[d.key] })),
        ], filtered);
      }
      return filtered;
    });

    // Assign to one person, or to every active member of a team (one task each).
    m.post('/api/tasks', { roles: lead }, (ctx) => {
      const b = ctx.body;
      const title = str(b.title, 'Title', { required: true, max: 150 });
      const targets = [];
      if (b.teamId || ctx.user.role === 'leader' && !b.assignedTo) {
        const teamId = ctx.user.role === 'leader' ? ctx.myTeamId() : int(b.teamId, 'Team');
        const team = teamId > 0 && db.get('SELECT * FROM teams WHERE id=?', teamId);
        if (!team) throw bad('Team not found');
        ctx.assertDept(team.departmentId);
        targets.push(...db.all("SELECT id, role, department_id, team_id FROM employees WHERE team_id=? AND role='member' AND status='active'", team.id));
        if (!targets.length) throw bad('This team has no active members');
      } else {
        const e = db.get("SELECT id, role, department_id, team_id FROM employees WHERE id=? AND status='active'", int(b.assignedTo, 'Assignee', { required: true }));
        if (!e) throw bad('Person not found or inactive');
        ctx.assertManage(e);
        targets.push(e);
      }
      const now = new Date().toISOString();
      const common = {
        title, description: str(b.description, 'Description', { max: 1000 }), assignedBy: ctx.user.label, assignedById: ctx.user.employeeId ?? null, assignedByRole: ctx.user.role,
        priority: oneOf(b.priority, 'Priority', PRIORITIES, { def: 'medium' }), dueDate: date(b.dueDate, 'Due date'),
        custom: JSON.stringify(cf.sanitize('task', b.custom)), createdAt: now, updatedAt: now,
      };
      db.tx(() => { for (const e of targets) db.insert('tasks', { ...common, departmentId: e.departmentId, assignedTo: e.id }); });
      for (const e of targets) {
        notify.send({ employeeId: e.id }, {
          title: 'New task assigned to you', body: `${title}${common.dueDate ? ` · due ${common.dueDate}` : ''}${common.priority === 'urgent' || common.priority === 'high' ? ` · ${common.priority} priority` : ''}`,
          link: '#/my-tasks', kind: 'task',
        });
      }
      ctx.audit('create', 'task', null, `${title} -> ${targets.length} employee(s)`, targets[0].departmentId);
      return { created: targets.length };
    });

    m.put('/api/tasks/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get(`${TASK_SELECT} WHERE k.id=?`, id);
      if (!t) throw new HttpError(404, 'Task not found');
      ctx.assertManage(assignee(t));
      const b = ctx.body;
      const requested = oneOf(b.status, 'Status', STATUSES, { def: t.status });
      if (requested !== t.status) {
        if (!WORKING.includes(requested)) throw bad('A submitted task is completed with Approve, Request changes or Reject (the Review button)');
        if (t.status === 'done' || t.status === 'pending_approval') throw bad(t.status === 'done' ? 'This task is already completed' : 'This task is waiting for your review');
      }
      let status = requested;
      let assignedTo = t.assignedTo;
      if (b.assignedTo && Number(b.assignedTo) !== t.assignedTo) {
        const e = db.get("SELECT id, role, department_id, team_id FROM employees WHERE id=? AND status='active'", int(b.assignedTo, 'Assignee'));
        if (!e || e.departmentId !== t.assigneeDepartmentId) throw bad('Assignee must be an active person of this department');
        ctx.assertManage(e);
        assignedTo = e.id;
        if (t.status !== 'done') status = 'todo'; // a new person starts the task afresh
      }
      db.update('tasks', id, {
        title: str(b.title, 'Title', { required: true, max: 150 }), description: str(b.description, 'Description', { max: 1000 }),
        priority: oneOf(b.priority, 'Priority', PRIORITIES, { def: t.priority }), dueDate: date(b.dueDate, 'Due date'),
        assignedTo, status, completedAt: status === 'done' ? t.completedAt : null,
        ...(assignedTo !== t.assignedTo ? { submitNote: null, submittedAt: null, reviewDecision: null, reviewNote: null, reviewedBy: null, reviewedAt: null } : {}),
        custom: JSON.stringify(cf.sanitize('task', b.custom, parseJson(t.custom, {}))), updatedAt: new Date().toISOString(),
      });
      ctx.audit('update', 'task', id, b.title, t.assigneeDepartmentId);
      if (assignedTo !== t.assignedTo) notify.send({ employeeId: assignedTo }, { title: 'A task was assigned to you', body: str(b.title, 'Title', { max: 150 }), link: '#/my-tasks', kind: 'task' });
      return { ok: true };
    });

    m.del('/api/tasks/:id', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get(`${TASK_SELECT} WHERE k.id=?`, id);
      if (!t) throw new HttpError(404, 'Task not found');
      ctx.assertManage(assignee(t));
      db.tx(() => { db.run('UPDATE work_logs SET task_id=NULL WHERE task_id=?', id); db.run('DELETE FROM tasks WHERE id=?', id); });
      ctx.audit('delete', 'task', id, t.title, t.assigneeDepartmentId);
      return { ok: true };
    });

    // ---- tasks: my own (members, team leaders and heads all receive tasks) ----
    m.get('/api/tasks/me', { roles: self }, (ctx) =>
      db.all(`${TASK_SELECT} WHERE k.assigned_to=? ORDER BY (k.status='done'), k.due_date IS NULL, k.due_date`, ctx.user.employeeId).map(shapeTask));

    m.post('/api/tasks/:id/status', { roles: self }, (ctx) => {
      const id = int(ctx.params.id, 'Task', { required: true });
      const t = db.get('SELECT * FROM tasks WHERE id=? AND assigned_to=?', id, ctx.user.employeeId);
      if (!t) throw new HttpError(404, 'Task not found');
      const status = oneOf(ctx.body.status, 'Status', STATUSES, { required: true });
      if (t.status === 'done') throw bad('This task is already completed and approved');
      if (t.status === 'pending_approval') throw bad('This task is waiting for approval. You can change it again after the review.');
      if (status === 'done' || status === 'pending_approval') { submitForApproval(ctx, t, ctx.body.note); return { ok: true, status: 'pending_approval' }; } // older screens
      if (!WORKING.includes(status)) throw bad('You cannot set that status');
      db.update('tasks', id, { status, completedAt: null, updatedAt: new Date().toISOString() });
      ctx.audit('task_status', 'task', id, `${t.title}: ${status}`);
      if (status !== t.status && status === 'blocked') {
        const who = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId).name;
        notify.toSuperiors(ctx.user.employeeId, { title: `${who} marked a task blocked`, body: t.title, link: '#/tasks', kind: 'task' });
      }
      return { ok: true, status };
    });

    // The assignee hands the finished work in; it stays "Pending approval" until the assigner decides.
    m.post('/api/tasks/:id/submit', { roles: self }, (ctx) => {
      const t = db.get('SELECT * FROM tasks WHERE id=? AND assigned_to=?', int(ctx.params.id, 'Task', { required: true }), ctx.user.employeeId);
      if (!t) throw new HttpError(404, 'Task not found');
      if (t.status === 'done') throw bad('This task is already completed and approved');
      if (t.status === 'pending_approval') throw bad('This task is already waiting for approval');
      submitForApproval(ctx, t, ctx.body.note);
      return { ok: true, status: 'pending_approval' };
    });

    // Approve = completed. Request changes / Reject = sent back with feedback (the note is required).
    m.post('/api/tasks/:id/review', { roles: lead }, (ctx) => {
      const t = db.get(`${TASK_SELECT} WHERE k.id=?`, int(ctx.params.id, 'Task', { required: true }));
      if (!t) throw new HttpError(404, 'Task not found');
      ctx.assertSee(assignee(t));
      if (!canReviewTask(ctx, t)) throw new HttpError(403, 'Only the person who assigned this task (or the admin / head) can review it');
      if (t.status !== 'pending_approval') throw bad('This task has no submission waiting for review');
      const decision = oneOf(ctx.body.decision, 'Decision', Object.keys(DECISIONS), { required: true });
      const note = str(ctx.body.note, 'Feedback', { max: 600, required: decision !== 'approve' });
      const status = DECISIONS[decision];
      const now = new Date().toISOString();
      db.update('tasks', t.id, {
        status, completedAt: decision === 'approve' ? now : null, reviewDecision: decision === 'approve' ? 'approved' : decision === 'changes' ? 'changes_requested' : 'rejected',
        reviewNote: note, reviewedBy: ctx.user.label, reviewedAt: now, updatedAt: now,
      });
      ctx.audit(`task_${decision === 'approve' ? 'approved' : decision === 'changes' ? 'changes_requested' : 'rejected'}`, 'task', t.id, `${t.title} (${t.assigneeName})`, t.assigneeDepartmentId);
      const title = { approve: 'Your task was approved', changes: 'Changes requested on your task', reject: 'Your task submission was rejected' }[decision];
      notify.send({ employeeId: t.assignedTo }, { title, body: `${t.title}${note ? ` · ${note}` : ''}`, link: '#/my-tasks', kind: 'task' });
      return { ok: true, status };
    });

    // ---- daily work logs ----
    m.post('/api/worklogs', { roles: self }, (ctx) => {
      const b = ctx.body;
      const day = date(b.date, 'Date') || today();
      if (day > today()) throw bad('Cannot log work for a future date');
      const taskId = int(b.taskId, 'Task');
      if (taskId && !db.get('SELECT 1 AS x FROM tasks WHERE id=? AND assigned_to=?', taskId, ctx.user.employeeId)) throw bad('Task not found');
      const r = db.insert('work_logs', {
        employeeId: ctx.user.employeeId, date: day, taskId, summary: str(b.summary, 'What did you work on?', { required: true, max: 600 }),
        hours: num(b.hours, 'Hours', { min: 0, max: 24 }) ?? 0, units: int(b.units, 'Units', { min: 0, max: 100000 }) ?? 0,
        remarks: str(b.remarks, 'Remarks / Issues', { max: 600 }), createdAt: new Date().toISOString(),
      });
      ctx.audit('worklog', 'work_log', r.id, day);
      if (b.remarks && String(b.remarks).trim()) {
        const who = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId).name;
        notify.toSuperiors(ctx.user.employeeId, { title: `${who} added remarks / issues to their daily work`, body: String(b.remarks).trim().slice(0, 140), link: '#/worklogs', kind: 'task' });
      }
      return { id: r.id };
    });

    m.get('/api/worklogs/me', { roles: self }, (ctx) => {
      const { from, to } = range(ctx.query, { defFrom: addDays(today(), -30) });
      return db.all(`${WORKLOG_SELECT} WHERE w.employee_id=? AND w.date BETWEEN ? AND ? ORDER BY w.date DESC, w.id DESC`, ctx.user.employeeId, from, to);
    });

    m.get('/api/worklogs', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const { from, to } = range(q, { defFrom: today() });
      const rows = db.all(
        `${WORKLOG_SELECT} WHERE instr(?, ',' || e.role || ',') > 0 AND w.date BETWEEN ? AND ? AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
           AND (? IS NULL OR w.employee_id=?) AND (? IS NULL OR e.name LIKE ? OR w.summary LIKE ?) ORDER BY w.date DESC, e.name LIMIT 2000`,
        ctx.rolesCsv(), from, to, dept, dept, team, team, q.employeeId || null, q.employeeId || null, q.search ? `%${q.search}%` : null, `%${q.search}%`, `%${q.search}%`)
        .map((w) => ({ ...w, canReview: ctx.canManage({ id: w.employeeId, role: w.role, departmentId: w.departmentId, teamId: w.teamId }) }));
      if (q.format === 'csv') {
        return ctx.csv('work-logs.csv', [
          { label: 'Date', key: 'date' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' },
          { label: 'Task', key: 'taskTitle' }, { label: 'Summary', key: 'summary' }, { label: 'Hours', key: 'hours' },
          { label: 'Remarks / Issues', key: 'remarks' }, { label: 'Rating', key: 'rating' }, { label: 'Review note', key: 'reviewNote' },
        ], rows);
      }
      return rows;
    });

    m.post('/api/worklogs/:id/review', { roles: lead }, (ctx) => {
      const id = int(ctx.params.id, 'Work log', { required: true });
      const w = db.get(`${WORKLOG_SELECT} WHERE w.id=?`, id);
      if (!w) throw new HttpError(404, 'Work log not found');
      ctx.assertManage({ id: w.employeeId, role: w.role, departmentId: w.departmentId, teamId: w.teamId });
      db.update('work_logs', id, {
        rating: int(ctx.body.rating, 'Rating', { required: true, min: 1, max: 5 }), reviewNote: str(ctx.body.note, 'Note', { max: 300 }),
        reviewedBy: ctx.user.label, reviewedAt: new Date().toISOString(),
      });
      ctx.audit('worklog_reviewed', 'work_log', id, `${w.employeeName} ${w.date}`, w.departmentId);
      return { ok: true };
    });
  },
};
