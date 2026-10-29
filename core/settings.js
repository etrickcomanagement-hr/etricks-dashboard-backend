'use strict';
const db = require('./db');
const { parseJson } = require('./util');

// Add new defaults here; modules can read any key with settings.get('key').
const DEFAULTS = {
  companyName: 'eTricks',
  currency: 'USD',
  weeklyOff: [0], // JS getDay(): 0 = Sunday
  leaveTypes: ['Casual', 'Sick', 'Annual', 'Unpaid', 'Emergency'],
  defaultBreakMinutes: 60,
  disabledModules: [],
  expenseCategories: ['Electricity', 'Gas', 'Water', 'Internet', 'Rent', 'Software & tools', 'Office supplies', 'Maintenance', 'Marketing', 'Other'],
  scoreWeights: { attendance: 40, tasks: 40, rating: 20 },
};

function get(key) {
  const row = db.get('SELECT value FROM settings WHERE key=?', key);
  return row ? parseJson(row.value, DEFAULTS[key]) : DEFAULTS[key];
}
function set(key, value) {
  db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}
function all() {
  const out = { ...DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings')) if (r.key in DEFAULTS) out[r.key] = parseJson(r.value, DEFAULTS[r.key]);
  return out;
}

module.exports = { get, set, all, DEFAULTS };
