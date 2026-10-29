'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const { HttpError } = require('./util');

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  const [v, salt, hash] = stored.split('$');
  if (v !== 's1') return false;
  const calc = crypto.scryptSync(String(secret), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession({ role, departmentId = null, employeeId = null, label }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.run(
    'INSERT INTO sessions(token_hash, role, department_id, employee_id, label, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    sha(token), role, departmentId, employeeId, label, new Date().toISOString(), expires,
  );
  return { token, expires };
}

function sessionFromToken(token) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash=?', sha(token));
  if (!s) return null;
  if (s.expiresAt < new Date().toISOString()) {
    db.run('DELETE FROM sessions WHERE token_hash=?', s.tokenHash);
    return null;
  }
  if (s.role === 'member') {
    const e = db.get('SELECT status FROM employees WHERE id=?', s.employeeId);
    if (!e || e.status !== 'active') {
      db.run('DELETE FROM sessions WHERE token_hash=?', s.tokenHash);
      return null;
    }
  }
  return { role: s.role, departmentId: s.departmentId, employeeId: s.employeeId, label: s.label, tokenHash: s.tokenHash };
}
const destroySession = (tokenHash) => db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
const purgeSessions = () => db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());

// Brute-force protection: 6 failures => 10 minute lock for that ip + portal.
const attempts = new Map();
const throttle = {
  check(key) {
    const a = attempts.get(key);
    if (a && a.until > Date.now()) {
      throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} minute(s).`);
    }
  },
  fail(key) {
    const a = attempts.get(key) || { n: 0, until: 0 };
    if (++a.n >= 6) { a.until = Date.now() + 10 * 60e3; a.n = 0; }
    attempts.set(key, a);
  },
  ok(key) { attempts.delete(key); },
};

function generatePassword(len = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
}
const generatePin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

module.exports = { hashSecret, verifySecret, createSession, sessionFromToken, destroySession, purgeSessions, throttle, generatePassword, generatePin };
