'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');

/*
 * What the server can say about itself, so a complaint ("it was slow at 3 pm") can be answered with numbers.
 *   - for every API route: how often it was called, how long it took (average, 95th percentile, slowest), how many failed
 *   - how long the server was "stuck" (event-loop delay: the time a request waits before the server even starts on it)
 *   - memory
 *   - every request slower than SLOW_MS is written to the log with its time, so `journalctl -u etricks | grep slow` finds it
 * Nothing here stores any request content.
 */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 700;
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity]; // ms; enough for a percentile without keeping every sample

const started = Date.now();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const routes = new Map();
let total = 0, failed = 0, slow = 0, lastSlowLog = 0;
const browserErrors = []; // the last problems the website itself reported (a blank page, a failed screen)
let browserErrorCount = 0;

function record(key, ms, status, label) {
  total++;
  let r = routes.get(key);
  if (!r) routes.set(key, (r = { key, n: 0, ms: 0, max: 0, errors: 0, serverErrors: 0, hist: new Array(BUCKETS.length).fill(0) }));
  r.n++; r.ms += ms; if (ms > r.max) r.max = ms;
  if (status >= 400) { r.errors++; failed++; }
  if (status >= 500) r.serverErrors++;
  r.hist[BUCKETS.findIndex((b) => ms <= b)]++;
  if (ms > SLOW_MS) {
    slow++;
    const now = Date.now();
    if (now - lastSlowLog > 1000) { lastSlowLog = now; console.warn(`[slow] ${Math.round(ms)} ms ${label || key} -> ${status}`); } // at most one line a second
  }
}

const percentile = (r, p) => {
  const want = Math.ceil(r.n * p);
  let seen = 0;
  for (let i = 0; i < BUCKETS.length; i++) { seen += r.hist[i]; if (seen >= want) return BUCKETS[i] === Infinity ? Math.round(r.max) : BUCKETS[i]; }
  return Math.round(r.max);
};

function snapshot() {
  const mem = process.memoryUsage();
  const ms = (ns) => Math.max(0, Math.round((ns / 1e6 - 20) * 10) / 10); // the histogram counts its own 20 ms timer tick: what is left is the time the server was really stuck
  return {
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    requests: total, failed, slowRequests: slow, slowLimitMs: SLOW_MS,
    eventLoop: { meanMs: ms(loop.mean), p99Ms: ms(loop.percentile(99)), maxMs: ms(loop.max) },
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    browserErrors: { count: browserErrorCount, recent: browserErrors.slice(0, 10) },
    routes: [...routes.values()].map((r) => ({
      route: r.key, calls: r.n, avgMs: Math.round((r.ms / r.n) * 10) / 10, p95Ms: percentile(r, 0.95), maxMs: Math.round(r.max), errors: r.errors, serverErrors: r.serverErrors, totalMs: Math.round(r.ms),
    })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 40), // the routes that cost the most time in total come first
  };
}

function browserError(e) {
  browserErrorCount++;
  browserErrors.unshift({ at: new Date().toISOString(), ...e });
  if (browserErrors.length > 30) browserErrors.pop();
}

function reset() { routes.clear(); total = failed = slow = 0; browserErrors.length = 0; browserErrorCount = 0; loop.reset(); }

module.exports = { record, snapshot, reset, browserError };
