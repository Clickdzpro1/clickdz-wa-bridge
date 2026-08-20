#!/bin/bash
# ---------------------------------------------------------------------------
# ClickDZ WA Bridge — DigitalOcean Droplet cloud-init user_data (PRIMARY deploy).
#
# Fully unattended: the sandbox has no SSH key and no interactive login, so
# everything the box needs is provisioned here at create time.
#
# Auth state is stored ON DISK at /var/lib/wa-bridge/auth (outside the git repo
# so updates never touch it). A droplet's disk persists across reboots and
# service restarts, so a paired WhatsApp number stays paired — only destroying
# the droplet forgets it. This needs NO external Redis, which is why it is the
# primary path here (the app's Upstash creds are Vercel "sensitive" env and are
# not readable via API).
#
# Create via the DO skill:
#   python3 digitalocean.py droplets create \
#     --name clickdz-wa-bridge --region fra1 --size s-1vcpu-1gb \
#     --image ubuntu-24-04-x64 --tags wa-bridge \
#     --user-data "$(cat deploy/cloud-init.sh)"
#
# BEFORE creating: replace <FILL:BRIDGE_TOKEN> and <FILL:BRIDGE_WEBHOOK_SECRET>
# with the real secrets. They are embedded at create time and live ONLY on the
# droplet (/etc/wa-bridge.env, chmod 600) and in DO — never in the public repo.
#
# Reach the bridge at http://<droplet-ip>:8080 with Authorization: Bearer <BRIDGE_TOKEN>.
# ---------------------------------------------------------------------------
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- Node 22 + git ---
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# --- service user + persistent auth-state dir (survives restarts/reboots) ---
useradd -m -r -s /usr/sbin/nologin wa || true
mkdir -p /var/lib/wa-bridge/auth
chown -R wa:wa /var/lib/wa-bridge

# --- clone the PUBLIC repo (no auth needed) ---
rm -rf /opt/wa-bridge
git clone --depth 1 -b main https://github.com/Clickdzpro1/clickdz-wa-bridge.git /opt/wa-bridge
cd /opt/wa-bridge
npm ci --omit=dev

# --- env file (secrets embedded at create time; NOT in git) ---
cat >/etc/wa-bridge.env <<'ENV'
BRIDGE_TOKEN=<FILL:BRIDGE_TOKEN>
BRIDGE_WEBHOOK_SECRET=<FILL:BRIDGE_WEBHOOK_SECRET>
APP_WEBHOOK_URL=https://clickdzmax.vercel.app/api/whatsapp/bridge
AUTH_STORE=disk
AUTH_DISK_DIR=/var/lib/wa-bridge/auth
LOG_LEVEL=info
PORT=8080
ENV
chmod 600 /etc/wa-bridge.env
chown -R wa:wa /opt/wa-bridge
chown wa:wa /etc/wa-bridge.env

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
# hardening (auth state lives under /var/lib/wa-bridge, kept writable)
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/wa-bridge

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now wa-bridge

# --- update path: hourly git-pull that ONLY restarts when HEAD actually moved
#     (a plain `git pull && restart` restarts every run even with no changes,
#     churning the WhatsApp connection — this checks the ref first) ---
cat >/usr/local/bin/wa-bridge-update.sh <<'UPD'
#!/bin/bash
set -euo pipefail
cd /opt/wa-bridge
before=$(git rev-parse HEAD)
git pull --ff-only origin main || exit 0
after=$(git rev-parse HEAD)
if [ "$before" != "$after" ]; then
  npm ci --omit=dev
  systemctl restart wa-bridge
fi
UPD
chmod 755 /usr/local/bin/wa-bridge-update.sh
cat >/etc/cron.d/wa-bridge-update <<'CRON'
17 * * * * root /usr/local/bin/wa-bridge-update.sh >/var/log/wa-bridge-update.log 2>&1
CRON
chmod 644 /etc/cron.d/wa-bridge-update
