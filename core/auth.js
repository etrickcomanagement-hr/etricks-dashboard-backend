'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
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
// The same check, but done on a worker thread: while a password is being checked (it takes 50-200 ms on purpose) the server keeps
// answering everybody else. The sign-in uses this; the synchronous one above is only for rare jobs (setting a password).
const scryptAsync = promisify(crypto.scrypt);
async function verifySecretAsync(secret, stored) {
  if (!stored) return false;
  const [v, salt, hash] = stored.split('$');
  if (v !== 's1') return false;
  const calc = await scryptAsync(String(secret), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}

// A key that lives in the data folder, NOT in the database: with it a password gets a short "tag" so the sign-in can find which of
// the ten team leaders / teams a password belongs to by one lookup instead of checking all of them (ten slow checks). The tag only
// narrows the search: the password is still checked properly afterwards. A copy of the database alone says nothing about passwords.
let loginKey = null;
function tagOf(secret) {
  if (!loginKey) {
    const file = path.join(config.dataDir, '.login-key');
    try { loginKey = fs.readFileSync(file); } catch {
      loginKey = crypto.randomBytes(32);
      try { fs.writeFileSync(file, loginKey, { mode: 0o600 }); } catch { /* read-only folder: the key lives as long as the process */ }
    }
  }
  return crypto.createHmac('sha256', loginKey).update(String(secret)).digest('hex');
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession({ role, departmentId = null, employeeId = null, clientId = null, label }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.run(
    'INSERT INTO sessions(token_hash, role, department_id, employee_id, client_id, label, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
    sha(token), role, departmentId, employeeId, clientId, label, new Date().toISOString(), expires,
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
  const EMPLOYEE_ROLE = { member: 'member', leader: 'team_leader', hod: 'hod' };
  if (EMPLOYEE_ROLE[s.role]) {
    // members, team leaders and heads are people: the account must still exist, be active and keep the same role
    const e = db.get('SELECT status, role, department_id FROM employees WHERE id=?', s.employeeId);
    if (!e || e.status !== 'active' || e.role !== EMPLOYEE_ROLE[s.role] || e.departmentId !== s.departmentId) {
      db.run('DELETE FROM sessions WHERE token_hash=?', s.tokenHash);
      return null;
    }
  }
  if (s.role === 'client') {
    // a client account must still exist, be active and stay in the same department
    const c = db.get('SELECT status, department_id FROM clients WHERE id=?', s.clientId);
    if (!c || c.status !== 'active' || c.departmentId !== s.departmentId) {
      db.run('DELETE FROM sessions WHERE token_hash=?', s.tokenHash);
      return null;
    }
  }
  return { role: s.role, departmentId: s.departmentId, employeeId: s.employeeId, clientId: s.clientId ?? null, label: s.label, tokenHash: s.tokenHash };
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
    const now = Date.now();
    let a = attempts.get(key);
    // Old failures expire: 6 typos spread over weeks must not lock anyone out.
    if (!a || (a.until <= now && now - a.first > 15 * 60e3)) a = { n: 0, first: now, until: 0 };
    if (++a.n >= 6) { a.until = now + 10 * 60e3; a.n = 0; a.first = now; }
    attempts.set(key, a);
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until <= now && now - v.first > 15 * 60e3) attempts.delete(k);
  },
  ok(key) { attempts.delete(key); },
};

function generatePassword(len = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
}
const generatePin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

module.exports = { hashSecret, verifySecret, verifySecretAsync, tagOf, createSession, sessionFromToken, destroySession, purgeSessions, throttle, generatePassword, generatePin };
