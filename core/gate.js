'use strict';
const crypto = require('node:crypto');
const settings = require('./settings');
const auth = require('./auth');

/*
 * The website access password. When the admin sets one, nobody sees the departments, the portals or anything else of the
 * website before typing it. Only the admin can set, change or turn it off.
 *
 *   - Server side, not just a screen: every call that needs no sign-in (the department list, every login) is refused
 *     without the gate cookie. People who are already signed in keep working when the password changes.
 *   - The cookie is signed with a secret that changes whenever the password changes, so a new password locks out every
 *     browser that knew the old one.
 */
const COOKIE = 'gate';
const DAYS = 30;

const hash = () => settings.get('gateHash');
const enabled = () => !!hash();
const secret = () => settings.get('gateSecret') || '';
const sign = (nonce) => crypto.createHmac('sha256', secret()).update(nonce).digest('base64url');

function parseCookie(header) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Has this browser typed the password (or is there no password)?
function passed(req) {
  if (!enabled()) return true;
  const v = parseCookie(req.headers.cookie);
  if (!v) return false;
  const [nonce, sig] = v.split('.');
  if (!nonce || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(nonce));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const check = (password) => enabled() && auth.verifySecret(String(password ?? ''), hash());
const token = () => { const nonce = crypto.randomBytes(18).toString('base64url'); return `${nonce}.${sign(nonce)}`; };
const cookieHeader = (secure) => `${COOKIE}=${token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`;

function set(password) {
  settings.set('gateHash', auth.hashSecret(password));
  settings.set('gateSecret', crypto.randomBytes(32).toString('hex')); // every browser that knew the old password is locked out
  settings.set('gateSetAt', new Date().toISOString());
}
function clear() {
  settings.set('gateHash', '');
  settings.set('gateSecret', '');
  settings.set('gateSetAt', '');
}
const status = () => ({ enabled: enabled(), setAt: enabled() ? settings.get('gateSetAt') || null : null });

// Calls that stay open without the password (the website asks them to find out whether to show the password page).
const OPEN = new Set(['/api/health', '/api/gate', '/api/auth/me']);

module.exports = { enabled, passed, check, set, clear, status, cookieHeader, OPEN };
