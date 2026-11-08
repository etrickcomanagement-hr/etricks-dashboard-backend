'use strict';
// The 30-day full-backup cycle with a fake clock: due, warnings, deletion when not downloaded, clean-up after download.
// Run: node scripts/backup-cycle-test.js   (also part of npm test)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'etx-cycle-'));
process.env.ADMIN_PASSWORD = 'Cycle-admin-pass-1';
process.env.FULL_BACKUP_KEEP = '2';

const modules = require('../core/modules');
modules.loadAll();
const db = require('../core/db');
const backup = require('../core/backup');
const config = require('../core/config');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };
const DAY = 864e5;
const notes = () => db.all("SELECT * FROM notifications WHERE recipient_role='admin' AND kind='backup' ORDER BY id");
const onDisk = (n) => fs.existsSync(path.join(config.fullBackupDir, n));
const rows = () => db.all('SELECT * FROM full_backups ORDER BY id');
const sleepSec = () => new Promise((r) => setTimeout(r, 1100)); // backup names carry the second

(async () => {
  const t0 = Date.now();
  console.log('Full backup cycle');
  backup.maintain(t0);
  check('first start: the 30 days begin, nothing is made yet', rows().length === 0 && backup.summary().alert === null);
  backup.maintain(t0 + 29 * DAY);
  check('after 29 days still nothing', rows().length === 0);

  backup.maintain(t0 + 30 * DAY);
  check('after 30 days a full backup is made by itself', rows().length === 1 && rows()[0].kind === 'auto' && onDisk(rows()[0].file));
  const first = rows()[0];
  check('the admin is alerted that it is ready and that it will be deleted if not downloaded', notes().length === 1 && /30-day backup is ready/.test(notes()[0].title) && /deleted automatically/.test(notes()[0].body) && notes()[0].link === '#/settings');
  check('the summary raises the warning with a deadline 7 days away', backup.summary(t0 + 30 * DAY).alert.count === 1 && backup.summary(t0 + 30 * DAY).alert.daysLeft === 7);
  backup.maintain(t0 + 30 * DAY + 3600e3);
  check('running again does not make a second backup or repeat the alert', rows().length === 1 && notes().length === 1);

  backup.maintain(t0 + 34.5 * DAY);
  check('about 2.5 days before the end: one warning', notes().length === 2 && /will be deleted in 3 days?/.test(notes()[1].title) && onDisk(first.file));
  backup.maintain(t0 + 34.6 * DAY);
  check('the same warning is not repeated', notes().length === 2);
  backup.maintain(t0 + 36.5 * DAY);
  check('the last day: a final, urgent warning', notes().length === 3 && /deleted in 1 day/.test(notes()[2].title) && backup.summary(t0 + 36.5 * DAY).alert.daysLeft === 1);

  backup.maintain(t0 + 37 * DAY + 1000);
  const gone = rows()[0];
  check('not downloaded in 7 days: the file is deleted, the history stays, the admin is told', !onDisk(first.file) && gone.removedAt && /Not downloaded/.test(gone.removedReason) && notes().length === 4 && /was deleted because it was not downloaded/.test(notes()[3].title) && backup.summary().alert === null);
  check('the activity log has it', db.get("SELECT 1 AS x FROM activity_log WHERE action='backup_full_expired'") && db.get("SELECT 1 AS x FROM activity_log WHERE action='backup_full_created'"));
  check('the next one comes 30 days after the last (not sooner)', rows().length === 1 && Math.abs(Date.parse(backup.summary().nextDue) - (Date.parse(first.createdAt) + 30 * DAY)) < 1000);

  // downloaded copies: they stay until deleted, and only the newest FULL_BACKUP_KEEP (2) are kept
  await sleepSec(); const a = backup.createFull('manual'); backup.markDownloaded(a.id, 'Administrator');
  await sleepSec(); const b = backup.createFull('manual'); backup.markDownloaded(b.id, 'Administrator');
  await sleepSec(); const c = backup.createFull('manual'); backup.markDownloaded(c.id, 'Administrator');
  check('manual backups make no alert of their own', notes().length === 4);
  backup.maintain(Date.now());
  check('a downloaded copy no longer expires, even much later', (backup.maintain(Date.now() + 20 * DAY), onDisk(c.name) && onDisk(b.name)));
  check('only the newest 2 downloaded copies stay on the server; the older one is removed', !onDisk(a.name) && onDisk(b.name) && onDisk(c.name) && /already downloaded/.test(db.get('SELECT removed_reason AS r FROM full_backups WHERE id=?', a.id).r));

  // a file that vanished from disk
  fs.unlinkSync(path.join(config.fullBackupDir, c.name));
  backup.maintain(Date.now());
  check('a file that disappeared is noticed and recorded, nothing crashes', db.get('SELECT removed_at AS r FROM full_backups WHERE id=?', c.id).r && backup.fullFile(c.id) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
