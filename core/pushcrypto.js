'use strict';
const crypto = require('node:crypto');

// Pure crypto helpers for Web Push (no database): message encryption per RFC 8291 / RFC 8188 (aes128gcm).
const ALLOWED_HOSTS = ['.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com', '.push.microsoft.com']
  .concat((process.env.PUSH_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean));

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// `fixed` ({ ecdh, salt }) exists only so tests can reproduce the RFC's worked example.
function encrypt({ p256dh, auth }, plaintext, fixed = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = fixed.ecdh || crypto.createECDH('prime256v1');
  const asPublic = fixed.ecdh ? ecdh.getPublicKey() : ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = fixed.salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Subscription endpoints come from browsers, so only genuine push services are ever contacted.
function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && ALLOWED_HOSTS.some((h) => {
      const bare = h.replace(/^\./, '');
      return u.hostname === bare || u.hostname.endsWith(`.${bare}`);
    });
  } catch { return false; }
}

module.exports = { encrypt, validEndpoint, b64u, fromB64u };
