#!/bin/bash
# ---------------------------------------------------------------------------
# ClickDZ WA Bridge — DigitalOcean Droplet cloud-init user_data (FALLBACK deploy).
#
# Use when App Platform's buildpack detection misbehaves. Fully unattended:
# the sandbox has no SSH key and no interactive login, so everything the box
# needs is provisioned here at create time.
#
# Create via the DO skill:
#   python3 digitalocean.py droplets create \
#     --name clickdz-wa-bridge --region fra1 --size s-1vcpu-1gb \
#     --image ubuntu-24-04-x64 --tags wa-bridge \
#     --user-data "$(cat deploy/cloud-init.sh)"
#
# BEFORE creating: replace every <FILL:...> below with the real secret. Secrets
# are embedded at create time and live ONLY on the droplet (in /etc/wa-bridge.env)
# and in DO — never in the public git repo.
#
# Reach the bridge at http://<droplet-ip>:8080 with Authorization: Bearer <BRIDGE_TOKEN>.
# (Optionally front it with a firewall allowing only 80/443/8080 inbound.)
# ---------------------------------------------------------------------------
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# --- Node 22 + git ---
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# --- service user ---
useradd -m -r -s /usr/sbin/nologin wa || true

# --- clone the PUBLIC repo (no auth needed) ---
rm -rf /opt/wa-bridge
git clone --depth 1 -b main https://github.com/Clickdzpro1/clickdz-wa-bridge.git /opt/wa-bridge
cd /opt/wa-bridge
npm ci --omit=dev

# --- env file (secrets embedded at create time; NOT in git) ---
cat >/etc/wa-bridge.env <<'ENV'
BRIDGE_TOKEN=<FILL:SECRET>
BRIDGE_WEBHOOK_SECRET=<FILL:SECRET>
APP_WEBHOOK_URL=https://clickdzmax.vercel.app/api/whatsapp/bridge
KV_REST_API_URL=<FILL:SECRET>
KV_REST_API_TOKEN=<FILL:SECRET>
AUTH_STORE=redis
AUTH_STATE_PREFIX=wa:bridge:auth
LOG_LEVEL=info
PORT=8080
ENV
chmod 600 /etc/wa-bridge.env
chown -R wa:wa /opt/wa-bridge /etc/wa-bridge.env

# --- systemd unit with restart-on-failure ---
cat >/etc/systemd/system/wa-bridge.service <<'UNIT'
[Unit]
Description=ClickDZ WA Bridge
After=network-online.target
Wants=network-online.target

[Service]
User=wa
EnvironmentFile=/etc/wa-bridge.env
WorkingDirectory=/opt/wa-bridge
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=5
# hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now wa-bridge

# --- update path: 30-min git-pull + restart cron (auth state is in Redis, so
#     restarts are harmless and require no re-pairing) ---
cat >/etc/cron.d/wa-bridge-update <<'CRON'
*/30 * * * * root cd /opt/wa-bridge && git pull --ff-only && npm ci --omit=dev && systemctl restart wa-bridge
CRON
chmod 644 /etc/cron.d/wa-bridge-update
