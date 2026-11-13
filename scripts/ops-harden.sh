#!/bin/bash
# eTricks: make the server steadier. Run once on the server, as root (safe to run again):
#     bash /opt/etricks/app/scripts/ops-harden.sh
#
# What it does
#   1. Caddy (the HTTPS front door) waits up to 12 seconds for the app while the app restarts, instead of answering
#      "502 Bad Gateway". Connections are kept warm and compressed. The old Caddyfile is saved first and the new one is
#      checked before it is used; if the check fails nothing changes.
#   2. The service gets a polite stop (15 s), a bigger file limit and a 2 second restart.
#   3. "etricks-update" waits until the app answers again and says how long that took.
#   4. A watchdog looks at the health page every minute and restarts the service if it stops answering twice in a row.
set -euo pipefail
echo "== eTricks: making the server steadier"

# ---- 1. Caddy ----
CADDYFILE=/etc/caddy/Caddyfile
SITE=$(awk 'NF && $1 !~ /^[#{}]/ {print $1; exit}' "$CADDYFILE")
if [ -z "$SITE" ]; then echo "Caddy: cannot find the site address in $CADDYFILE, left as it was"; else
  cp -a "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  cat > "$CADDYFILE.new" <<EOF
$SITE {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
		lb_try_duration 12s
		lb_try_interval 250ms
		transport http {
			dial_timeout 3s
			keepalive 60s
			keepalive_idle_conns 64
			response_header_timeout 90s
		}
	}
}
EOF
  if caddy validate --config "$CADDYFILE.new" --adapter caddyfile >/dev/null 2>&1; then
    mv "$CADDYFILE.new" "$CADDYFILE"
    systemctl reload caddy
    echo "Caddy: updated and reloaded ($SITE)"
  else
    rm -f "$CADDYFILE.new"
    echo "Caddy: the new settings did not pass the check, left as they were"
  fi
fi

# ---- 2. the service ----
mkdir -p /etc/systemd/system/etricks.service.d
cat > /etc/systemd/system/etricks.service.d/steady.conf <<'EOF'
[Service]
Restart=always
RestartSec=2
TimeoutStopSec=15
LimitNOFILE=8192
EOF
systemctl daemon-reload
echo "Service: settings saved (they apply at the next restart)"

# ---- 3. the update helper ----
cat > /usr/local/bin/etricks-update <<'EOF'
#!/bin/bash
set -e
runuser -u etricks -- git -C /opt/etricks/app pull --ff-only
systemctl restart etricks
for i in $(seq 1 40); do
  if curl -fsS -m 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "eTricks updated and restarted (answering again after about $((i / 2)) seconds)."
    exit 0
  fi
  sleep 0.5
done
echo "WARNING: eTricks was restarted but does not answer yet. Look at: journalctl -u etricks -n 30"
exit 1
EOF
chmod +x /usr/local/bin/etricks-update
echo "Update helper: replaced"

# ---- 4. the watchdog ----
cat > /usr/local/bin/etricks-watchdog <<'EOF'
#!/bin/bash
# If the health page does not answer twice in a row (a minute apart), restart the service.
F=/run/etricks-watchdog.fails
if curl -fsS -m 8 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then rm -f "$F"; exit 0; fi
n=$(( $(cat "$F" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$F"
logger -t etricks-watchdog "health check failed ($n)"
if [ "$n" -ge 2 ]; then
  logger -t etricks-watchdog "restarting etricks"
  systemctl restart etricks
  rm -f "$F"
fi
EOF
chmod +x /usr/local/bin/etricks-watchdog
cat > /etc/systemd/system/etricks-watchdog.service <<'EOF'
[Unit]
Description=eTricks health check
[Service]
Type=oneshot
ExecStart=/usr/local/bin/etricks-watchdog
EOF
cat > /etc/systemd/system/etricks-watchdog.timer <<'EOF'
[Unit]
Description=Run the eTricks health check every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now etricks-watchdog.timer
echo "Watchdog: running every minute"

echo
echo "== done. Check:   curl -s http://127.0.0.1:3000/api/health"
echo "   Slow requests: journalctl -u etricks | grep '\[slow\]'"
echo "   Watchdog log:  journalctl -t etricks-watchdog"
