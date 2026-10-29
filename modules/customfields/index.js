'use strict';
const db = require('../../core/db');
const cf = require('../../core/customfields');
const { HttpError, str, int, oneOf, bad } = require('../../core/util');

module.exports = {
  id: 'customfields',
  name: 'Custom Fields',
  description: 'Add your own fields to employees, tasks and finance entries without code changes.',
  core: true,
  order: 8,

  migrations: [
    `CREATE TABLE custom_fields (
       id INTEGER PRIMARY KEY, entity TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,
       options TEXT, required INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 100,
       active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE (entity, key));`,
  ],

  routes(m) {
    m.get('/api/custom-fields', { roles: ['admin', 'leader', 'member'] }, (ctx) => {
      const entity = oneOf(ctx.query.entity, 'Entity', cf.ENTITIES, { required: true });
      return cf.definitions(entity);
    });

    const input = (b) => {
      const type = oneOf(b.type, 'Type', cf.TYPES, { required: true });
      const options = type === 'select'
        ? String(b.options || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
        : [];
      if (type === 'select' && !options.length) throw bad('Add at least one choice for a dropdown field');
      return {
        label: str(b.label, 'Label', { required: true, max: 60 }),
        type, options: JSON.stringify(options), required: b.required ? 1 : 0,
        sort: int(b.sort ?? 100, 'Order', { min: 0, max: 9999 }),
      };
    };

    m.post('/api/custom-fields', { roles: ['admin'] }, (ctx) => {
      const entity = oneOf(ctx.body.entity, 'Entity', cf.ENTITIES, { required: true });
      const f = input(ctx.body);
      const key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';
      if (db.get('SELECT 1 AS x FROM custom_fields WHERE entity=? AND key=?', entity, key)) throw bad('A field with this name already exists');
      const r = db.insert('custom_fields', { entity, key, ...f, createdAt: new Date().toISOString() });
      ctx.audit('create', 'custom_field', r.id, `${entity}: ${f.label}`, null);
      return { id: r.id };
    });

    m.put('/api/custom-fields/:id', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Field', { required: true });
      if (!db.get('SELECT 1 AS x FROM custom_fields WHERE id=?', id)) throw new HttpError(404, 'Field not found');
      const f = input(ctx.body);
      db.update('custom_fields', id, f); // key and entity stay fixed so stored values keep working
      ctx.audit('update', 'custom_field', id, f.label, null);
      return { ok: true };
    });

    // Hides the field; values already saved stay in the database.
    m.del('/api/custom-fields/:id', { roles: ['admin'] }, (ctx) => {
      const id = int(ctx.params.id, 'Field', { required: true });
      const f = db.get('SELECT * FROM custom_fields WHERE id=?', id);
      if (!f) throw new HttpError(404, 'Field not found');
      db.update('custom_fields', id, { active: 0, key: `${f.key}__removed_${Date.now()}` });
      ctx.audit('delete', 'custom_field', id, `${f.entity}: ${f.label}`, null);
      return { ok: true };
    });
  },
};
