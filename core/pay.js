'use strict';
const db = require('./db');
const { num, oneOf, bad, round } = require('./util');

/*
 * How a person is paid. Three ways:
 *   fixed    a monthly salary
 *   percent  a percentage of the net profit the person's daily sheet shows for the month (commission)
 *   both     the fixed salary plus that percentage
 * The rate lives in salary_rates (payee_type 'member', ref_id = the employee).
 */
const PAY_TYPES = ['fixed', 'percent', 'both'];
const LABEL = { fixed: 'Fixed salary', percent: 'Percentage of the profit', both: 'Fixed salary + percentage' };

// Reads { type | payType, amount, percent }. Without a type, an amount alone means a fixed salary (older callers).
function validate(p, { required = false } = {}) {
  if (p === undefined || p === null) {
    if (required) throw bad('Choose how this person is paid');
    return null;
  }
  const type = oneOf(p.type ?? p.payType ?? (p.amount != null && p.amount !== '' ? 'fixed' : undefined), 'Pay type', PAY_TYPES, { required: true });
  const amount = type === 'percent' ? 0 : num(p.amount, 'Fixed monthly salary', { required: true, min: 0.01, max: 1e9 });
  const percent = type === 'fixed' ? 0 : num(p.percent, 'Percentage', { required: true, min: 0.01, max: 100 });
  return { payType: type, amount, percent };
}

function save(employeeId, rate) {
  db.run(
    `INSERT INTO salary_rates(payee_type, ref_id, amount, payee_name, updated_at, pay_type, percent) VALUES ('member',?,?,?,?,?,?)
     ON CONFLICT(payee_type, ref_id) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at, pay_type=excluded.pay_type, percent=excluded.percent`,
    employeeId, rate.amount, null, new Date().toISOString(), rate.payType, rate.percent);
}

// What a rate gives for a month in which the person made `profit` (company currency). A loss never makes a negative salary.
function compute(rate, profit) {
  if (!rate) return { fixed: 0, commission: 0, due: 0 };
  const fixed = rate.payType === 'percent' ? 0 : rate.amount || 0;
  const commission = rate.payType === 'fixed' ? 0 : round(Math.max(0, profit || 0) * (rate.percent || 0) / 100);
  return { fixed: round(fixed), commission, due: round(fixed + commission) };
}

function describe(rate) {
  if (!rate) return 'Not set';
  if (rate.payType === 'percent') return `${rate.percent}% of the profit`;
  if (rate.payType === 'both') return `${rate.amount} + ${rate.percent}% of the profit`;
  return `${rate.amount} a month`;
}

module.exports = { PAY_TYPES, LABEL, validate, save, compute, describe };
