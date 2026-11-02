'use strict';
const db = require('./db');
const auth = require('./auth');
const { today } = require('./util');

const ROLE_TITLES = { member: 'Team member', team_leader: 'Team leader', hod: 'Head of department' };

function addHistory(employeeId, type, eventDate, details, by) {
  db.insert('employee_history', { employeeId, eventType: type, eventDate: eventDate || today(), details, recordedBy: by, createdAt: new Date().toISOString() });
}

// Inserts an employee, gives them the next code (ETX-0001 ...) and writes the first line of their history.
// Call inside db.tx() when more writes must succeed or fail together.
function createEmployee(data, by) {
  const next = db.get('SELECT COALESCE(MAX(id),0)+1 AS n FROM employees').n;
  const empCode = `ETX-${String(next).padStart(4, '0')}`;
  const row = {
    name: data.name, email: data.email ?? null, phone: data.phone ?? null, cnic: data.cnic ?? null, address: data.address ?? null,
    dateOfBirth: data.dateOfBirth ?? null, gender: data.gender ?? null, emergencyName: data.emergencyName ?? null, emergencyPhone: data.emergencyPhone ?? null,
    designation: data.designation ?? null, role: data.role || 'member', status: data.status || 'active', joinDate: data.joinDate || today(),
    departmentId: data.departmentId, teamId: data.teamId ?? null, shiftId: data.shiftId ?? null,
    pinHash: data.pin ? auth.hashSecret(data.pin) : null, passwordHash: data.password ? auth.hashSecret(data.password) : null,
    custom: data.custom || '{}', empCode, createdAt: new Date().toISOString(),
  };
  const r = db.insert('employees', row);
  const dept = db.get('SELECT name FROM departments WHERE id=?', row.departmentId)?.name || 'the company';
  addHistory(r.id, 'joined', row.joinDate, `Joined ${dept} as ${row.designation || ROLE_TITLES[row.role] || 'team member'}`, by);
  return { id: r.id, empCode };
}

// Everything that belongs to a person is removed together. Salary payments are financial records, so a person who was paid is deactivated instead.
function purge(employeeId) {
  const id = employeeId;
  const paid = db.get(`SELECT COUNT(*) AS n FROM salary_payments p JOIN salary_records r ON r.id=p.record_id WHERE r.payee_type='member' AND r.ref_id=?`, id).n;
  if (paid) return { blocked: `${paid} salary payment${paid === 1 ? '' : 's'} recorded` };
  const counts = {};
  const del = (name, sql, ...args) => { counts[name] = db.run(sql, ...args).changes; };
  db.tx(() => {
    db.run('UPDATE teams SET leader_employee_id=NULL WHERE leader_employee_id=?', id);
    db.run("UPDATE issues SET recipient_role='admin', recipient_id=NULL WHERE recipient_id=?", id);
    db.run('UPDATE tasks SET assigned_by_id=NULL WHERE assigned_by_id=?', id);
    db.run('UPDATE complaints SET filed_by_employee_id=NULL WHERE filed_by_employee_id=?', id);
    db.run('UPDATE employee_transfers SET requested_by_employee_id=NULL WHERE requested_by_employee_id=?', id);
    db.run('UPDATE issue_messages SET author_employee_id=NULL WHERE author_employee_id=?', id);
    db.run('UPDATE work_logs SET task_id=NULL WHERE task_id IN (SELECT id FROM tasks WHERE assigned_to=?)', id);
    del('attendance', 'DELETE FROM attendance WHERE employee_id=?', id); // breaks go with it
    del('leave', 'DELETE FROM leave_requests WHERE employee_id=?', id);
    del('workLogs', 'DELETE FROM work_logs WHERE employee_id=?', id);
    del('tasks', 'DELETE FROM tasks WHERE assigned_to=?', id);
    del('dailyReports', 'DELETE FROM member_orders WHERE employee_id=?', id);
    del('complaints', 'DELETE FROM complaints WHERE employee_id=?', id);
    del('issues', 'DELETE FROM issues WHERE submitted_by=?', id); // messages and files go with it
    del('transfers', 'DELETE FROM employee_transfers WHERE employee_id=?', id);
    db.run("DELETE FROM salary_payments WHERE record_id IN (SELECT id FROM salary_records WHERE payee_type='member' AND ref_id=?)", id);
    db.run("DELETE FROM salary_records WHERE payee_type='member' AND ref_id=?", id);
    db.run("DELETE FROM salary_rates WHERE payee_type='member' AND ref_id=?", id);
    db.run("DELETE FROM notifications WHERE recipient_role='employee' AND recipient_id=?", id);
    db.run("DELETE FROM push_subscriptions WHERE recipient_role='employee' AND recipient_id=?", id);
    db.run('DELETE FROM sessions WHERE employee_id=?', id);
    db.run('DELETE FROM employee_history WHERE employee_id=?', id);
    db.run('DELETE FROM employees WHERE id=?', id);
  });
  return { counts };
}

// A team leader who no longer leads: stays on the payroll as an ordinary member without a team (to be placed with a transfer).
function stepDown(employeeId, teamName, by) {
  const e = db.get('SELECT role FROM employees WHERE id=?', employeeId);
  if (!e || e.role !== 'team_leader') return;
  db.update('employees', employeeId, { role: 'member', teamId: null, passwordHash: null, designation: 'Team member' });
  db.run('DELETE FROM sessions WHERE employee_id=?', employeeId);
  addHistory(employeeId, 'promotion', today(), `No longer team leader of ${teamName}`, by);
}

module.exports = { addHistory, createEmployee, stepDown, purge, ROLE_TITLES };
