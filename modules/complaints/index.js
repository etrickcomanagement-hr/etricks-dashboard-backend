'use strict';
const db = require('../../core/db');
const notify = require('../../core/notify');
const { HttpError, int, str, oneOf, date, range, today, bad } = require('../../core/util');
const { sniffFile } = require('./files');

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
    // 3: complaints and issues that employees raise themselves (to their leader, head or the admin), with replies and attachments
    `CREATE TABLE issues (
       id INTEGER PRIMARY KEY, submitted_by INTEGER NOT NULL REFERENCES employees(id),
       recipient_role TEXT NOT NULL, recipient_id INTEGER,
       category TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', subject TEXT NOT NULL, details TEXT NOT NULL, store_name TEXT,
       status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
     CREATE INDEX idx_issue_sub ON issues(submitted_by, id);
     CREATE INDEX idx_issue_rcpt ON issues(recipient_id, status);
     CREATE TABLE issue_messages (
       id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
       author_employee_id INTEGER, author_label TEXT NOT NULL, author_role TEXT NOT NULL, body TEXT, status_set TEXT, created_at TEXT NOT NULL);
     CREATE INDEX idx_issuemsg_issue ON issue_messages(issue_id, id);
     CREATE TABLE issue_files (
       id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
       name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
     CREATE INDEX idx_issuefile_issue ON issue_files(issue_id);`,
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

    // =====================================================================================
    // Complaints & issues that employees raise themselves.
    // Private: only the person who wrote it, the person it was sent to and the admin can open it.
    // =====================================================================================
    const ISSUE_CATEGORIES = ['General', 'Store/Account Related', 'Team/Workplace', 'Technical', 'Other'];
    const ISSUE_PRIORITIES = ['normal', 'urgent'];
    const ISSUE_STATUSES = ['open', 'in_review', 'resolved', 'closed'];
    const STATUS_TEXT = { open: 'Open', in_review: 'In review', resolved: 'Resolved', closed: 'Closed' };
    const MAX_FILES = 3;
    const MAX_FILE_BYTES = 1_000_000;

    const ISSUE_SELECT = `
      SELECT i.*, s.name AS submitter_name, s.emp_code AS submitter_code, s.role AS submitter_role, d.name AS department_name, t.name AS team_name,
             r.name AS recipient_name,
             (SELECT COUNT(*) FROM issue_messages x WHERE x.issue_id=i.id) AS message_count,
             (SELECT COUNT(*) FROM issue_files f WHERE f.issue_id=i.id) AS file_count
        FROM issues i
        JOIN employees s ON s.id=i.submitted_by JOIN departments d ON d.id=s.department_id LEFT JOIN teams t ON t.id=s.team_id
        LEFT JOIN employees r ON r.id=i.recipient_id`;

    const isRecipient = (ctx, i) => ctx.user.role === 'admin' || (i.recipientId != null && i.recipientId === ctx.user.employeeId);
    const isSubmitter = (ctx, i) => i.submittedBy === ctx.user.employeeId;
    const recipientTarget = (i) => (i.recipientRole === 'admin' || i.recipientId == null ? { role: 'admin' } : { employeeId: i.recipientId });
    const recipientLabel = (i) => (i.recipientRole === 'admin' ? 'Admin' : i.recipientName || { leader: 'Team leader', hod: 'Head of department' }[i.recipientRole]);

    // A stranger gets "not found": the existence of a private complaint is not revealed.
    function loadIssue(ctx, id) {
      const i = db.get(`${ISSUE_SELECT} WHERE i.id=?`, int(id, 'Complaint', { required: true }));
      if (!i || !(isSubmitter(ctx, i) || isRecipient(ctx, i))) throw new HttpError(404, 'Complaint not found');
      return i;
    }

    // Who this person can write to, with names.
    function recipientsFor(ctx) {
      const me = db.get('SELECT id, role, team_id, department_id FROM employees WHERE id=?', ctx.user.employeeId);
      const out = [];
      if (me.role === 'member') {
        const l = notify.leaderOfTeam(me.teamId);
        if (l) out.push({ role: 'leader', id: l, name: db.get('SELECT name FROM employees WHERE id=?', l).name });
      }
      if (me.role !== 'hod') {
        const h = notify.headOf(me.departmentId);
        if (h) out.push({ role: 'hod', id: h, name: db.get('SELECT name FROM employees WHERE id=?', h).name });
      }
      out.push({ role: 'admin', id: null, name: 'Administrator' });
      return out;
    }

    m.get('/api/issues/meta', { roles: ['admin', 'hod', 'leader', 'member'] }, () => ({ categories: ISSUE_CATEGORIES, priorities: ISSUE_PRIORITIES, statuses: ISSUE_STATUSES }));
    m.get('/api/issues/recipients', { roles: self }, (ctx) => recipientsFor(ctx));

    m.post('/api/issues', { roles: self, maxBody: 5_000_000 }, (ctx) => {
      const b = ctx.body;
      const wanted = oneOf(b.recipient, 'Send to', ['leader', 'hod', 'admin'], { required: true });
      const target = recipientsFor(ctx).find((r) => r.role === wanted);
      if (!target) throw bad(wanted === 'leader' ? 'Your team has no team leader yet. Send it to your head of department or the admin.' : 'You cannot send a complaint to that person');
      const category = oneOf(b.category, 'Category', ISSUE_CATEGORIES, { required: true });
      const priority = oneOf(b.priority, 'Priority', ISSUE_PRIORITIES, { def: 'normal' });
      const subject = str(b.subject, 'Subject', { required: true, max: 150 });
      const details = str(b.details, 'Complaint details', { required: true, max: 3000 });
      const storeName = str(b.storeName, 'Store / account name', { max: 100 });
      if (db.get("SELECT COUNT(*) AS n FROM issues WHERE submitted_by=? AND created_at>=?", ctx.user.employeeId, new Date(Date.now() - 864e5).toISOString()).n >= 15) throw bad('You have sent many complaints today. Please wait for a reply first.');

      const files = [];
      const list = Array.isArray(b.attachments) ? b.attachments : [];
      if (list.length > MAX_FILES) throw bad(`You can attach up to ${MAX_FILES} files`);
      for (const a of list) {
        const raw = String(a?.data || '');
        if (!/^[A-Za-z0-9+/=\s]+$/.test(raw) || raw.length > MAX_FILE_BYTES * 1.4) throw bad('An attachment is too large or damaged (1 MB per file)');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length > MAX_FILE_BYTES) throw bad('Each attachment must be 1 MB or smaller');
        const kind = sniffFile(buf);
        if (!kind) throw bad('Attachments can be pictures (PNG, JPG, GIF, WEBP) or PDF files');
        const base = String(a.name || 'file').replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '_').trim().slice(0, 60) || 'file';
        files.push({ name: `${base}.${kind.ext}`, mime: kind.mime, size: buf.length, data: buf });
      }

      const now = new Date().toISOString();
      const id = db.tx(() => {
        const r = db.insert('issues', {
          submittedBy: ctx.user.employeeId, recipientRole: target.role, recipientId: target.id, category, priority, subject, details, storeName,
          status: 'open', createdAt: now, updatedAt: now,
        });
        for (const f of files) db.insert('issue_files', { issueId: r.id, ...f, createdAt: now });
        return r.id;
      });
      ctx.audit('issue_submitted', 'issue', id, `${category}${priority === 'urgent' ? ' (urgent)' : ''} to ${target.role}`);
      const me = db.get('SELECT name FROM employees WHERE id=?', ctx.user.employeeId).name;
      notify.send(target.role === 'admin' ? { role: 'admin' } : { employeeId: target.id }, {
        title: `${priority === 'urgent' ? 'URGENT: ' : ''}New complaint from ${me}`, body: `${category}: ${subject}`, link: '#/issues', kind: 'issue',
      });
      return { id };
    });

    // What I sent, and how it is going.
    m.get('/api/issues/me', { roles: self }, (ctx) => db.all(`${ISSUE_SELECT} WHERE i.submitted_by=? ORDER BY i.id DESC LIMIT 300`, ctx.user.employeeId)
      .map((i) => ({ ...i, sentTo: recipientLabel(i) })));

    // What was sent to me (the admin sees everything).
    m.get('/api/issues', { roles: lead }, (ctx) => {
      const q = ctx.query;
      const search = q.search ? `%${q.search}%` : null;
      const admin = ctx.user.role === 'admin';
      return db.all(
        `${ISSUE_SELECT} WHERE (? = 1 OR i.recipient_id = ?) AND (? IS NULL OR i.status=?) AND (? IS NULL OR i.priority=?) AND (? IS NULL OR i.category=?)
            AND (? IS NULL OR s.name LIKE ? OR i.subject LIKE ? OR i.store_name LIKE ?)
          ORDER BY (i.status IN ('open','in_review')) DESC, (i.priority='urgent') DESC, i.id DESC LIMIT 500`,
        admin ? 1 : 0, ctx.user.employeeId ?? -1, q.status || null, q.status || null, q.priority || null, q.priority || null, q.category || null, q.category || null,
        search, search, search, search).map((i) => ({ ...i, sentTo: recipientLabel(i) }));
    });

    m.get('/api/issues/:id', { roles: ['admin', 'hod', 'leader', 'member'] }, (ctx) => {
      const i = loadIssue(ctx, ctx.params.id);
      return {
        ...i, sentTo: recipientLabel(i), canRespond: isRecipient(ctx, i), mine: isSubmitter(ctx, i),
        messages: db.all('SELECT * FROM issue_messages WHERE issue_id=? ORDER BY id', i.id),
        files: db.all('SELECT id, name, mime, size FROM issue_files WHERE issue_id=? ORDER BY id', i.id),
      };
    });

    // Reply and/or change the status. The writer can always reply; only the recipient (or the admin) changes the status.
    m.post('/api/issues/:id/messages', { roles: ['admin', 'hod', 'leader', 'member'] }, (ctx) => {
      const i = loadIssue(ctx, ctx.params.id);
      const body = str(ctx.body.body, 'Message', { max: 2000 });
      const recipient = isRecipient(ctx, i);
      const requested = ctx.body.status ? oneOf(ctx.body.status, 'Status', ISSUE_STATUSES) : null;
      if (requested && requested !== i.status && !recipient) throw new HttpError(403, 'Only the person it was sent to can change the status');
      if (!body && !(recipient && requested && requested !== i.status)) throw bad('Write a message or choose a new status');
      let status = i.status;
      if (recipient && requested) status = requested;
      else if (recipient && i.status === 'open') status = 'in_review'; // an answer means it is being looked at
      else if (!recipient && (i.status === 'resolved' || i.status === 'closed')) status = 'open'; // a follow-up reopens it
      const now = new Date().toISOString();
      const asSubmitterOnly = isSubmitter(ctx, i) && !(ctx.user.role === 'admin');
      db.tx(() => {
        db.insert('issue_messages', { issueId: i.id, authorEmployeeId: ctx.user.employeeId ?? null, authorLabel: ctx.user.label, authorRole: ctx.user.role, body, statusSet: status !== i.status ? status : null, createdAt: now });
        db.update('issues', i.id, { status, updatedAt: now, resolvedAt: status === 'resolved' || status === 'closed' ? i.resolvedAt || now : null });
      });
      ctx.audit('issue_reply', 'issue', i.id, status !== i.status ? `status ${status}` : 'reply');
      const excerpt = body ? body.slice(0, 140) : '';
      if (asSubmitterOnly) {
        notify.send(recipientTarget(i), { title: `${i.submitterName} replied to their complaint`, body: `${i.subject}${excerpt ? ` · ${excerpt}` : ''}`, link: '#/issues', kind: 'issue' });
      } else {
        notify.send({ employeeId: i.submittedBy }, {
          title: status !== i.status ? `Your complaint is now "${STATUS_TEXT[status]}"` : 'New reply to your complaint',
          body: `${i.subject}${excerpt ? ` · ${excerpt}` : ''}`, link: '#/my-complaints', kind: 'issue',
        });
      }
      return { ok: true, status };
    });

    // Attachments are served only to the people who may open the complaint, always as a download.
    m.get('/api/issues/:id/files/:fileId', { roles: ['admin', 'hod', 'leader', 'member'] }, (ctx) => {
      const i = loadIssue(ctx, ctx.params.id);
      const f = db.get('SELECT * FROM issue_files WHERE id=? AND issue_id=?', int(ctx.params.fileId, 'File', { required: true }), i.id);
      if (!f) throw new HttpError(404, 'File not found');
      return ctx.raw(200, { 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' }, Buffer.from(f.data));
    });
  },
};
