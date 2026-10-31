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

// A team leader who no longer leads: stays on the payroll as an ordinary member without a team (to be placed with a transfer).
function stepDown(employeeId, teamName, by) {
  const e = db.get('SELECT role FROM employees WHERE id=?', employeeId);
  if (!e || e.role !== 'team_leader') return;
  db.update('employees', employeeId, { role: 'member', teamId: null, passwordHash: null, designation: 'Team member' });
  db.run('DELETE FROM sessions WHERE employee_id=?', employeeId);
  addHistory(employeeId, 'promotion', today(), `No longer team leader of ${teamName}`, by);
}

module.exports = { addHistory, createEmployee, stepDown, ROLE_TITLES };
