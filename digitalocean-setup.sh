#!/bin/bash
# eTricks backend: first-boot setup for a fresh Ubuntu 24.04 DigitalOcean Droplet.
#
# Paste this whole file into "Advanced Options -> Add Initialization scripts" when creating the Droplet.
# Change the two lines marked EDIT. Everything else installs by itself (about 3 to 5 minutes):
# Node.js, the backend from GitHub, a system service that restarts it, HTTPS (Caddy) and a firewall.
# The result is written to /root/etricks-info.txt and /var/log/etricks-setup.log.
set -euo pipefail
exec > >(tee -a /var/log/etricks-setup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

ADMIN_PASSWORD="EDIT-ME-at-least-8-characters"   # EDIT: Admin portal password (no quotes or backslashes)
VAPID_SUBJECT="mailto:EDIT-ME@example.com"       # EDIT: your email (shown to phone push services)
REPO="https://github.com/etrickcomanagement-hr/etricks-dashboard-backend.git"

echo "== eTricks setup started: $(date)"
if [[ "$ADMIN_PASSWORD" == EDIT-ME* || ${#ADMIN_PASSWORD} -lt 8 ]]; then
  echo "STOP: set ADMIN_PASSWORD (at least 8 characters) at the top of this script, then recreate the Droplet." >&2
  exit 1
fi

# --- packages ---
apt-get update -y
apt-get install -y curl git ca-certificates ufw caddy fail2ban
# Node.js 24 (same as the tests); fall back to the 22 LTS line if 24 is unavailable
(curl -fsSL https://deb.nodesource.com/setup_24.x | bash -) || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash -)
apt-get install -y nodejs
echo "Node $(node -v)"

# --- a little swap so small servers never run out of memory ---
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- app user, code and data folder (the database lives in /var/lib/etricks) ---
id -u etricks >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/etricks --shell /usr/sbin/nologin etricks
mkdir -p /var/lib/etricks && chown etricks:etricks /var/lib/etricks && chmod 700 /var/lib/etricks
if [ -d /opt/etricks/app/.git ]; then
  runuser -u etricks -- git -C /opt/etricks/app pull --ff-only
else
  runuser -u etricks -- git clone --depth 1 "$REPO" /opt/etricks/app
fi

# --- settings (readable by root only) ---
umask 077
cat > /etc/etricks.env <<EOF
PORT=3000
HOST=127.0.0.1
DATA_DIR=/var/lib/etricks
SECURE_COOKIES=1
TRUST_PROXY=1
TZ=Asia/Karachi
ADMIN_PASSWORD=$ADMIN_PASSWORD
VAPID_SUBJECT=$VAPID_SUBJECT
EOF
chmod 600 /etc/etricks.env
umask 022

# --- service that starts at boot and restarts if it ever stops ---
cat > /etc/systemd/system/etricks.service <<'EOF'
[Unit]
Description=eTricks Hub backend
After=network-online.target
Wants=network-online.target

[Service]
User=etricks
WorkingDirectory=/opt/etricks/app
EnvironmentFile=/etc/etricks.env
ExecStart=/usr/bin/node --no-warnings server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/etricks

[Install]
WantedBy=multi-user.target
EOF

# --- HTTPS: <ip-with-dashes>.sslip.io points at this server's IP, Caddy gets a free certificate for it ---
IP=$(curl -fsS -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || curl -fsS -m 10 https://api.ipify.org)
SITE="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

# --- firewall: only SSH, HTTP and HTTPS are reachable from outside ---
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# --- helper to update later: run "etricks-update" on the server ---
cat > /usr/local/bin/etricks-update <<'EOF'
#!/bin/bash
set -e
runuser -u etricks -- git -C /opt/etricks/app pull --ff-only
systemctl restart etricks
echo "eTricks updated and restarted."
EOF
chmod +x /usr/local/bin/etricks-update

# --- start everything ---
systemctl enable --now fail2ban
systemctl daemon-reload
systemctl enable --now etricks
systemctl restart caddy

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done

{
  echo "eTricks backend address: https://$SITE"
  echo "Health check:            https://$SITE/api/health"
  echo "Put the first line into vercel.json of the website repo (keep /api/:path* after it)."
  echo "Update later:            etricks-update"
  echo "Logs:                    journalctl -u etricks -f"
} > /root/etricks-info.txt
cat /root/etricks-info.txt
[ "${OK:-0}" = 1 ] && echo "== eTricks is running: $(date)" || echo "== WARNING: backend did not answer yet, check: journalctl -u etricks"
