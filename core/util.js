'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---- dates (stored as 'YYYY-MM-DD' strings in server-local time) ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
const today = () => ymd();
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const monthStart = (s = today()) => s.slice(0, 8) + '01';
const eachDay = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
const toIso = (date, hhmm) => new Date(`${date}T${hhmm}:00`).toISOString();

// ---- case conversion (DB snake_case <-> API camelCase) ----
const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const snakeKey = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const camel = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out;
};

// ---- input validation ----
function str(v, name, { required = false, max = 200 } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} is invalid`);
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} is too long (max ${max})`);
  return s;
}
function int(v, name, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return n;
}
function num(v, name, { required = false, min = -1e12, max = 1e12 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return n;
}
function oneOf(v, name, list, { required = false, def = null } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return def;
  }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}
function date(v, name, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (!isYmd(v)) throw bad(`${name} must be a valid date (YYYY-MM-DD)`);
  return v;
}
function time(v, name, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${name} must be HH:MM`);
  return v;
}
function range(query, { defFrom = monthStart(), defTo = today() } = {}) {
  const from = date(query.from, 'from') || defFrom;
  const to = date(query.to, 'to') || defTo;
  if (from > to) throw bad('"from" must not be after "to"');
  // Only limit ranges the user typed in; "no date filter" defaults are intentionally wide.
  if (query.from && query.to && eachDayCount(from, to) > 800) throw bad('Date range is too large');
  return { from, to };
}
const eachDayCount = (from, to) => Math.round((parseYmd(to) - parseYmd(from)) / 864e5) + 1;

// ---- CSV ----
function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}

const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const round = (n, d = 2) => Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;

module.exports = {
  HttpError, bad, pad, ymd, parseYmd, isYmd, today, addDays, monthStart, eachDay, minutesBetween, toIso,
  camelKey, snakeKey, camel, str, int, num, oneOf, date, time, range, toCsv, parseJson, round,
};
