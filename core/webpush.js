'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const settings = require('./settings');

/*
 * Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291/8188), no dependencies.
 * Lets phones and computers show a system notification even when eTricks is closed.
 * Browsers only allow this on https:// pages (http://localhost counts as secure).
 */
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@etricks.local';
const { encrypt, validEndpoint, b64u, fromB64u } = require('./pushcrypto');

// ---- VAPID keys (created once, stored in the database settings) ----
let keys = null;
function vapid() {
  if (keys) return keys;
  let stored = settings.get('vapid');
  if (!stored) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' });
    stored = { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])), privateJwk: privateKey.export({ format: 'jwk' }) };
    settings.set('vapid', stored);
  }
  keys = { publicKey: stored.publicKey, privateKey: crypto.createPrivateKey({ key: stored.privateJwk, format: 'jwk' }) };
  return keys;
}
const publicKey = () => vapid().publicKey;

function authHeader(endpoint) {
  const { publicKey: pub, privateKey } = vapid();
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT };
  const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify(claims))}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${pub}`;
}

async function sendOne(sub, payload) {
  try {
    const body = encrypt(sub, Buffer.from(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: 'POST', body, signal: AbortSignal.timeout(10000),
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: authHeader(sub.endpoint) },
    });
    if (res.status === 404 || res.status === 410) db.run('DELETE FROM push_subscriptions WHERE id=?', sub.id); // browser unsubscribed
    else if (!res.ok) console.error(`[push] ${new URL(sub.endpoint).hostname} answered ${res.status}`);
  } catch (e) {
    console.error('[push] send failed:', e.message);
  }
}

// Fire-and-forget: never delays or breaks the action that caused the notification.
function pushTo(role, recipientId, payload) {
  try {
    const subs = db.all('SELECT * FROM push_subscriptions WHERE recipient_role=? AND recipient_id=?', role, recipientId);
    for (const s of subs) sendOne(s, payload);
  } catch (e) {
    console.error('[push] failed', e.message);
  }
}

module.exports = { publicKey, authHeader, encrypt, validEndpoint, pushTo };
