'use strict';
const db = require('./db');
const { HttpError } = require('./util');

/*
 * Who may see or manage whom.
 *
 *   admin   everyone
 *   hod     (head of department) everyone in their department except other heads; approves members' attendance
 *   leader  (team leader) only the members of the team they lead
 *   member  only themselves
 *
 * employees.role is 'member' | 'team_leader' | 'hod'; the session role is 'member' | 'leader' | 'hod' | 'admin'.
 * Team leaders' and heads' own attendance is approved by the admin only.
 */
const VISIBLE_ROLES = {
  admin: ['member', 'team_leader', 'hod'],
  hod: ['member', 'team_leader'],
  leader: ['member'],
  member: [],
};

const loadEmployee = (id) => db.get(
  'SELECT id, name, emp_code, department_id, team_id, role, status, designation FROM employees WHERE id=?', id);

function build(user) {
  let team;
  const myTeamId = () => {
    if (user.role !== 'leader') return null;
    if (team === undefined) team = db.get('SELECT id FROM teams WHERE leader_employee_id=? ORDER BY id LIMIT 1', user.employeeId)?.id ?? -1; // -1: leads no team yet
    return team;
  };
  const sameDept = (e) => Number(e.departmentId) === user.departmentId;
  const mine = (e) => user.employeeId != null && e.id === user.employeeId;

  const api = {
    myTeamId,
    // Team a list may be limited to: a leader is always limited to their own team.
    scopeTeam(requested) {
      if (user.role === 'leader') return myTeamId();
      return requested ? Number(requested) : null;
    },
    // Roles of the people whose rows a list may contain, as ",member,team_leader," for SQL: instr(?, ',' || e.role || ',') > 0
    rolesCsv() { return `,${(VISIBLE_ROLES[user.role] || []).join(',')},`; },
    canSee(e) {
      if (user.role === 'admin' || mine(e)) return true;
      if (user.role === 'hod') return sameDept(e) && e.role !== 'hod';
      if (user.role === 'leader') return e.role === 'member' && e.teamId === myTeamId();
      return false;
    },
    // Tasks, leave, complaints, reports, salaries of members ...
    canManage(e) {
      if (user.role === 'admin') return true;
      if (mine(e)) return false;
      if (user.role === 'hod') return sameDept(e) && (e.role === 'member' || e.role === 'team_leader');
      if (user.role === 'leader') return e.role === 'member' && e.teamId === myTeamId();
      return false;
    },
    // Attendance of heads and team leaders is checked by the admin only.
    canApprovePunch(e) {
      if (user.role === 'admin') return true;
      if (mine(e) || e.role !== 'member') return false;
      if (user.role === 'hod') return sameDept(e);
      if (user.role === 'leader') return e.teamId === myTeamId();
      return false;
    },
    assertSee(e) { if (!api.canSee(e)) throw new HttpError(403, 'You cannot open this person'); },
    assertManage(e) { if (!api.canManage(e)) throw new HttpError(403, 'You cannot manage this person'); },
  };
  return api;
}

module.exports = { build, loadEmployee, VISIBLE_ROLES };
