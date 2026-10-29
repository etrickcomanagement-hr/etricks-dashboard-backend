# eTricks Dashboard Backend

The server of the eTricks Hub: sign-in, departments, employees, attendance, leave, tasks, orders, finance, salaries, complaints, reports, notifications (Web Push), activity log and backups. It stores everything in one SQLite file and has **no npm dependencies** (Node.js 22.13 or newer). The website is a separate repo (`etricks-dashboard`, hosted on Vercel).

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** → choose this repo. Railway detects Node and runs `npm start`.
2. **Add a Volume** to the service (Settings → Volumes) with mount path `/data`. This is where the database and backups live. **Without a volume all data is erased on every redeploy** (the logs show a warning if it is missing).
3. **Variables** (service → Variables):

   | Variable | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | the Admin portal password you want (at least 8 characters, use a long one) |
   | `SECURE_COOKIES` | `1` |
   | `TRUST_PROXY` | `1` |
   | `TZ` | `Asia/Karachi` (used for attendance dates and late marking) |
   | `VAPID_SUBJECT` | `mailto:you@yourcompany.com` (contact address for phone notifications) |

4. **Settings → Networking → Generate Domain.** Copy the address (for example `https://etricks-backend-production.up.railway.app`) and check `https://…/api/health` answers `{"ok":true}`.
5. Put that address into `vercel.json` of the website repo (`etricks-dashboard`).
6. Open the Vercel website, sign in to the **Admin portal** with `ADMIN_PASSWORD`, then go to **Departments → Passwords** and set the Team Leader and Team Member password of each department. (The six departments are created on first start with random passwords that nobody has seen.)

## Good to know

- The first start creates the departments (eBay, TikTok Shop, Etsy, Walmart, Shopify, Amazon) and the admin password. If `ADMIN_PASSWORD` is not set, a random one is printed once in the deploy log.
- A database backup is taken automatically every day (newest 30 kept in `/data/backups`). Download them from Admin → Settings & Backups and keep copies elsewhere. To restore, stop the service, replace `/data/etricks.db` with a backup file and start again.
- Sign-in attempts are limited (6 wrong tries lock that portal for 10 minutes). With `TRUST_PROXY=1` the client address is read from `X-Forwarded-For`, so keep the Railway address private and only use it through the website.
- All data stays in the Volume. Do not delete the Volume.

## Run it on your own computer

```
npm start        # http://127.0.0.1:3000 (API only, there is no website in this repo)
npm test         # end-to-end check of the whole API on a throw-away database
npm run demo     # sample people, attendance, orders, salaries (empty database only)
```

## Add a feature (payroll, CRM, recruitment...)

Create `modules/<name>/index.js` with its tables (`migrations`) and API (`routes`). It is loaded and migrated automatically and appears under Settings → Modules. Its screens go into the website repo as `modules/<name>.js`.

## Environment variables

`PORT` (set by Railway), `HOST` (0.0.0.0 on Railway), `DATA_DIR` (defaults to the Volume), `TZ`, `SESSION_HOURS` (12), `BACKUP_KEEP` (30), `SECURE_COOKIES`, `TRUST_PROXY`, `ADMIN_PASSWORD`, `VAPID_SUBJECT`, `PUSH_EXTRA_HOSTS`.
