'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const { HttpError, int, str, oneOf, date, range, today, bad } = require('../../core/util');

/*
 * Complaints about a person, raised by whoever manages them: a team leader about a member of their team,
 * the head of department about a member or team leader, the admin about anybody.
 * The person is notified and sees the complaint in their portal (and can reply); it also appears in their performance report.
 */
const CATEGORIES = ['Attendance / punctuality', 'Work quality', 'Behaviour', 'Missed deadline', 'Policy violation', 'Customer / buyer complaint', 'Other'];
const SEVERITIES = ['low', 'medium', 'high'];
const STATUSES = ['open', 'under_review', 'resolved', 'dismissed'];

const SELECT = `
  SELECT c.*, e.name AS employee_name, e.emp_code, e.role AS employee_role, e.department_id AS employee_department_id, e.team_id,
         d.name AS department_name, t.name AS team_name
    FROM complaints c
    JOIN employees e ON e.id=c.employee_id
    JOIN departments d ON d.id=e.department_id
    LEFT JOIN teams t ON t.id=e.team_id`;

const subject = (c) => ({ id: c.employeeId, role: c.employeeRole, departmentId: c.employeeDepartmentId, teamId: c.teamId });

function load(ctx, id) {
  const c = db.get(`${SELECT} WHERE c.id=?`, id);
  if (!c) throw new HttpError(404, 'Complaint not found');
  ctx.assertSee(subject(c));
  return c;
}

module.exports = {
  id: 'complaints',
  name: 'Complaints',
  description: 'Complaints raised by the person above (team leader, head or admin), with notifications and reports.',
  order: 48,
  CATEGORIES,

  migrations: [
    `CREATE TABLE complaints (
       id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), department_id INTEGER NOT NULL,
       filed_by_role TEXT NOT NULL, filed_by TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
       description TEXT NOT NULL, incident_date TEXT, status TEXT NOT NULL DEFAULT 'open', resolution_note TEXT,
       member_response TEXT, responded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
     CREATE INDEX idx_comp_emp ON complaints(employee_id, created_at);
     CREATE INDEX idx_comp_dept ON complaints(department_id, status);`,
    // 2: remember who filed it, so the reply goes back to that person
    'ALTER TABLE complaints ADD COLUMN filed_by_employee_id INTEGER;',
  ],

  routes(m) {
    const lead = ['admin', 'hod', 'leader'];
    const self = ['hod', 'leader', 'member'];

    m.get('/api/complaints/meta', { roles: ['admin', 'hod', 'leader', 'member'] }, () => ({ categories: CATEGORIES, severities: SEVERITIES, statuses: STATUSES }));

    m.get('/api/complaints', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const dept = ctx.scopeDept(q.departmentId);
      const team = ctx.scopeTeam(q.teamId);
      const { from, to } = range(q, { defFrom: '2000-01-01', defTo: '2999-12-31' });
      const search = q.search ? `%${q.search}%` : null;
      const rows = db.all(
        `${SELECT} WHERE instr(?, ',' || e.role || ',') > 0 AND (? IS NULL OR e.department_id=?) AND (? IS NULL OR e.team_id=?)
            AND (? IS NULL OR c.employee_id=?) AND (? IS NULL OR c.status=?)
            AND (? IS NULL OR c.severity=?) AND COALESCE(c.incident_date, substr(c.created_at,1,10)) BETWEEN ? AND ?
            AND (? IS NULL OR e.name LIKE ? OR e.emp_code LIKE ? OR c.description LIKE ?)
          ORDER BY (c.status IN ('open','under_review')) DESC, c.created_at DESC LIMIT 2000`,
        ctx.rolesCsv(), dept, dept, team, team, q.employeeId || null, q.employeeId || null, q.status || null, q.status || null, q.severity || null, q.severity || null,
        from, to, search, search, search, search).map((c) => ({ ...c, canManage: ctx.canManage(subject(c)) }));
      if (q.format === 'csv') {
        return ctx.csv('complaints.csv', [
          { label: 'Filed on', value: (r) => r.createdAt.slice(0, 10) }, { label: 'Incident date', key: 'incidentDate' }, { label: 'Code', key: 'empCode' }, { label: 'Employee', key: 'employeeName' },
          { label: 'Department', key: 'departmentName' }, { label: 'Team', key: 'teamName' }, { label: 'Category', key: 'category' }, { label: 'Severity', key: 'severity' }, { label: 'Complaint', key: 'description' },
          { label: 'Filed by', key: 'filedBy' }, { label: 'Status', key: 'status' }, { label: 'Member reply', key: 'memberResponse' }, { label: 'Resolution', key: 'resolutionNote' },
        ], rows);
      }
      return rows;
    });

    m.post('/api/complaints', { roles: lead }, (ctx) => {
      const b = ctx.body;
      const emp = db.get('SELECT id, name, role, department_id, team_id FROM employees WHERE id=?', int(b.employeeId, 'Employee', { required: true }));
      if (!emp) throw new HttpError(404, 'Employee not found');
      ctx.assertManage(emp);
      const incident = date(b.incidentDate, 'Incident date');
      if (incident && incident > today()) throw bad('Incident date cannot be in the future');
      const now = new Date().toISOString();
      const c = {
        employeeId: emp.id, departmentId: emp.departmentId, filedByRole: ctx.user.role, filedBy: ctx.user.label, filedByEmployeeId: ctx.user.employeeId ?? null,
        category: oneOf(b.category, 'Category', CATEGORIES, { required: true }), severity: oneOf(b.severity, 'Severity', SEVERITIES, { def: 'medium' }),
        description: str(b.description, 'Complaint details', { required: true, max: 1500 }), incidentDate: incident, createdAt: now, updatedAt: now,
      };
      const r = db.insert('complaints', c);
      ctx.audit('complaint_filed', 'complaint', r.id, `${emp.name}: ${c.category} (${c.severity})`, emp.departmentId);
      const payload = { kind: 'complaint', body: `${c.category} · ${c.severity} severity` };
      notify.send({ employeeId: emp.id }, { ...payload, title: 'A complaint was filed about you', link: '#/my-complaints' });
      // Everybody above the person is told, except the one who filed it.
      notify.toSuperiors(emp.id, { ...payload, title: `${ctx.user.label} filed a complaint about ${emp.name}`, link: '#/complaints' },
        { alsoHead: true, alsoAdmin: true, exceptEmployeeId: ctx.user.employeeId, exceptAdmin: ctx.user.role === 'admin' });
      return { id: r.id };
    });

    m.put('/api/complaints/:id', { roles: lead }, (ctx) => {
      const c = load(ctx, int(ctx.params.id, 'Complaint', { required: true }));
      if (!ctx.canManage(subject(c))) throw new HttpError(403, 'You cannot change this complaint');
      const b = ctx.body;
      const status = oneOf(b.status, 'Status', STATUSES, { def: c.status });
      const closed = status === 'resolved' || status === 'dismissed';
      db.update('complaints', c.id, {
        category: oneOf(b.category, 'Category', CATEGORIES, { def: c.category }), severity: oneOf(b.severity, 'Severity', SEVERITIES, { def: c.severity }),
        description: str(b.description, 'Complaint details', { max: 1500 }) || c.description, status,
        resolutionNote: b.resolutionNote !== undefined ? str(b.resolutionNote, 'Resolution note', { max: 500 }) : c.resolutionNote, resolvedAt: closed ? c.resolvedAt || new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      });
      ctx.audit('complaint_updated', 'complaint', c.id, `${c.employeeName}: ${status}`, c.employeeDepartmentId);
      if (status !== c.status) {
        notify.send({ employeeId: c.employeeId }, {
          title: `Your complaint is now "${status.replace('_', ' ')}"`, body: str(b.resolutionNote, 'Resolution note', { max: 120 }) || c.category, link: '#/my-complaints', kind: 'complaint',
        });
      }
      return { ok: true };
    });

    m.del('/api/complaints/:id', { roles: ['admin'] }, (ctx) => {
      const c = load(ctx, int(ctx.params.id, 'Complaint', { required: true }));
      db.run('DELETE FROM complaints WHERE id=?', c.id);
      ctx.audit('complaint_deleted', 'complaint', c.id, `${c.employeeName}: ${c.category}`, c.employeeDepartmentId);
      return { ok: true };
    });

    // ---- the person the complaint is about (member, team leader or head) ----
    m.get('/api/complaints/me', { roles: self }, (ctx) =>
      db.all(`${SELECT} WHERE c.employee_id=? ORDER BY c.created_at DESC`, ctx.user.employeeId));

    m.post('/api/complaints/:id/respond', { roles: self }, (ctx) => {
      const c = db.get(`${SELECT} WHERE c.id=? AND c.employee_id=?`, int(ctx.params.id, 'Complaint', { required: true }), ctx.user.employeeId);
      if (!c) throw new HttpError(404, 'Complaint not found');
      const text = str(ctx.body.response, 'Your reply', { required: true, max: 1000 });
      db.update('complaints', c.id, { memberResponse: text, respondedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      ctx.audit('complaint_reply', 'complaint', c.id, `${c.employeeName} replied`, c.employeeDepartmentId);
      const payload = { title: `${c.employeeName} replied to a complaint`, body: text.slice(0, 120), kind: 'complaint', link: '#/complaints' };
      if (c.filedByEmployeeId) notify.send({ employeeId: c.filedByEmployeeId }, payload);
      else notify.toAdmin(payload);
      return { ok: true };
    });
  },
};
