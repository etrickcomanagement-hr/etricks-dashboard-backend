'use strict';
const db = require('./db');
const { bad, isYmd, parseJson } = require('./util');

const ENTITIES = ['employee', 'task', 'finance'];
const TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];

function definitions(entity) {
  return db.all('SELECT * FROM custom_fields WHERE entity=? AND active=1 ORDER BY sort, id', entity)
    .map((d) => ({ ...d, options: parseJson(d.options, []), required: !!d.required }));
}

// Validates user-supplied custom values against the admin-defined fields; unknown keys are dropped.
function sanitize(entity, input, existing = {}) {
  const out = { ...existing };
  const src = input && typeof input === 'object' ? input : {};
  for (const d of definitions(entity)) {
    if (d.key in src) {
      let v = src[d.key];
      if (v === '' || v === null || v === undefined) v = null;
      else if (d.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) throw bad(`${d.label} must be a number`);
      } else if (d.type === 'date') {
        if (!isYmd(v)) throw bad(`${d.label} must be a valid date`);
      } else if (d.type === 'select') {
        if (!d.options.includes(v)) throw bad(`${d.label} has an invalid choice`);
      } else if (d.type === 'checkbox') v = v === true || v === 'true' || v === 1;
      else { v = String(v).trim().slice(0, 1000); }
      out[d.key] = v;
    }
    if (d.required && (out[d.key] === null || out[d.key] === undefined || out[d.key] === '')) throw bad(`${d.label} is required`);
  }
  return out;
}

module.exports = { ENTITIES, TYPES, definitions, sanitize };
