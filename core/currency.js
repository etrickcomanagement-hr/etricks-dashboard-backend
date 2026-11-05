'use strict';
const settings = require('./settings');

/*
 * Money in three currencies. Every daily report carries its own currency; totals that mix currencies are converted with the
 * exchange rates the admin keeps in Settings ("1 AUD = x" in the company currency). Nothing is ever added up across currencies
 * without converting it first.
 */
const CURRENCIES = ['AUD', 'USD', 'GBP'];
const DEFAULT_RATES = { USD: 1, AUD: 0.65, GBP: 1.27 };

function rates() {
  const saved = settings.get('fxRates') || {};
  const out = {};
  for (const c of CURRENCIES) {
    const n = Number(saved[c]);
    out[c] = Number.isFinite(n) && n > 0 ? n : DEFAULT_RATES[c];
  }
  return out;
}

// A converter that reads the rates once: converter()(amount, 'GBP') -> amount in the company currency.
function converter() {
  const r = rates();
  return (amount, currency) => (Number(amount) || 0) * (r[currency] ?? 1);
}

// SQL that converts a column: SUM(o.revenue * <fxSql('o.currency')>). Rates are numbers from code, never user text.
function fxSql(column = 'currency') {
  const r = rates();
  return `(CASE ${column} WHEN 'AUD' THEN ${Number(r.AUD)} WHEN 'GBP' THEN ${Number(r.GBP)} ELSE ${Number(r.USD)} END)`;
}

module.exports = { CURRENCIES, DEFAULT_RATES, rates, converter, fxSql };
