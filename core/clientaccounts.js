'use strict';
const db = require('./db');

/*
 * One client portal, one section per person who works for the client.
 * The client never sees names: every person who writes for a client gets a fixed number for THAT client ("Account 1",
 * "Account 2" ...), in the order they first wrote an update or sent a sheet (so 1, 2, 3 ... without gaps). The number stays with what they wrote
 * (client_reports.account_no, sheet_publications.account_no), also after the person leaves.
 * Anybody who has no employee record (the admin writing an update) shares one account: who = 'x'.
 */
const whoOf = (employeeId) => (employeeId ? `e${employeeId}` : 'x');

// The account number of this person for this client; makes the next free one when there is none yet.
function ensure(clientId, employeeId) {
  const who = whoOf(employeeId);
  const row = db.get('SELECT number FROM client_accounts WHERE client_id=? AND who=?', clientId, who);
  if (row) return row.number;
  const next = db.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM client_accounts WHERE client_id=?', clientId).n;
  db.run('INSERT INTO client_accounts(client_id, who, number, created_at) VALUES (?,?,?,?)', clientId, who, next, new Date().toISOString());
  return next;
}

// Read only: null when the person has no account on this client yet.
function numberOf(clientId, employeeId) {
  return db.get('SELECT number FROM client_accounts WHERE client_id=? AND who=?', clientId, whoOf(employeeId))?.number ?? null;
}

module.exports = { ensure, numberOf, whoOf };
