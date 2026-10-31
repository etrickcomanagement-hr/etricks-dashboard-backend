'use strict';
const db = require('./db');
const auth = require('./auth');
const { str, bad } = require('./util');

/*
 * Passwords of the people who sign in with a password:
 *   head of department  (employee, role hod)         set by the admin
 *   team leader         (employee, role team_leader) set by the head of department or the admin
 *   team members        share their TEAM's password (plus their own PIN); set by the leader, head or admin
 * Within a department no two people of the same kind may use the same password, because the sign-in
 * page works out who is signing in from the password alone.
 */
function validatePassword(value, label = 'Password') {
  const pw = str(value, label, { required: true, max: 100 });
  if (pw.length < 8) throw bad(`${label} must be at least 8 characters`);
  return pw;
}

function assertEmployeePasswordFree(departmentId, role, password, exceptEmployeeId = null) {
  const others = db.all("SELECT id, password_hash FROM employees WHERE department_id=? AND role=? AND status='active' AND password_hash IS NOT NULL AND id<>?", departmentId, role, exceptEmployeeId ?? -1);
  if (others.some((o) => auth.verifySecret(password, o.passwordHash))) {
    throw bad(role === 'hod' ? 'That password is already used. Choose a different one.' : 'Another team leader in this department already uses that password. Choose a different one.');
  }
}

function assertTeamPasswordFree(departmentId, password, exceptTeamId = null) {
  const others = db.all('SELECT id, member_hash FROM teams WHERE department_id=? AND member_hash IS NOT NULL AND id<>?', departmentId, exceptTeamId ?? -1);
  if (others.some((t) => auth.verifySecret(password, t.memberHash))) {
    throw bad('Another team in this department already uses that member password. Choose a different one.');
  }
}

function findEmployeeByPassword(departmentId, role, password) {
  return db.all("SELECT * FROM employees WHERE department_id=? AND role=? AND status='active' AND password_hash IS NOT NULL", departmentId, role)
    .find((e) => auth.verifySecret(password, e.passwordHash)) || null;
}

function findTeamByPassword(departmentId, password) {
  return db.all('SELECT * FROM teams WHERE department_id=? AND member_hash IS NOT NULL', departmentId)
    .find((t) => auth.verifySecret(password, t.memberHash)) || null;
}

module.exports = { validatePassword, assertEmployeePasswordFree, assertTeamPasswordFree, findEmployeeByPassword, findTeamByPassword };
