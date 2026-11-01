'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');
const audit = require('./audit');
const scope = require('./scope');
const { HttpError, toCsv } = require('./util');

const PUBLIC_DIR = path.join(config.root, 'public');
const routes = [];
let moduleGate = () => true; // set by core/modules.js: (moduleId) => enabled?

function add(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, regex, keys, handler, opts });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function buildCtx(req, url, params, user, body) {
  const ctx = {
    req, user, params, body,
    query: Object.fromEntries(url.searchParams),
    ip: clientIp(req),
    cookies: parseCookies(req.headers.cookie),
    // Department the caller may act on: admins pick freely (or null = all), others are locked to their own.
    scopeDept(requested) {
      if (user.role === 'admin') return requested ? Number(requested) : null;
      return user.departmentId;
    },
    assertDept(deptId) {
      if (user.role !== 'admin' && Number(deptId) !== user.departmentId) throw new HttpError(403, 'Not allowed for this department');
    },
    ...(user ? scope.build(user) : {}), // scopeTeam, canSee, canManage, canApprovePunch, assertSee, assertManage ...
    audit(action, entity, entityId, details, departmentId) {
      audit.log(ctx, action, entity, entityId, details, departmentId ?? user?.departmentId ?? null);
    },
    csv(name, columns, rows) {
      return { __raw: true, status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }, body: toCsv(columns, rows) };
    },
    raw(status, headers, body) { return { __raw: true, status, headers, body }; },
  };
  return ctx;
}

async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
  if (!route) throw new HttpError(404, 'Not found');
  const m = url.pathname.match(route.regex);
  const params = {};
  route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

  if (route.opts.module && !moduleGate(route.opts.module)) throw new HttpError(404, 'This module is disabled');

  let user = null;
  const token = parseCookies(req.headers.cookie).sid;
  if (route.opts.roles || token) user = auth.sessionFromToken(token);
  if (route.opts.roles) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (!route.opts.roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this');
  }
  if (req.method !== 'GET' && req.headers['x-etricks'] !== '1') throw new HttpError(403, 'Missing request header');

  const body = req.method === 'GET' ? {} : await readBody(req, route.opts.maxBody);
  const ctx = buildCtx(req, url, params, user, body);
  ctx.res = res;
  const result = await route.handler(ctx);
  if (result && result.__raw) {
    res.writeHead(result.status, { ...result.headers, 'Content-Length': Buffer.byteLength(result.body) });
    return res.end(result.body);
  }
  if (result && result.__file) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${result.name}"` });
    return fs.createReadStream(result.path).pipe(res);
  }
  sendJson(res, 200, result === undefined ? { ok: true } : result);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  if (!fs.existsSync(PUBLIC_DIR)) { // API-only deployment (the website is hosted elsewhere)
    if (url.pathname === '/') return sendJson(res, 200, { service: 'eTricks Hub API', status: 'running' });
    throw new HttpError(404, 'Not found');
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[error]', req.method, req.url, e);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server' : e.message });
    }
  });
}

module.exports = { add, createServer, setModuleGate: (fn) => (moduleGate = fn), parseCookies };
