# ClickDZ WhatsApp QR Bridge

Multi-account WhatsApp **QR-paired** (WhatsApp-Web-style) bridge for the ClickDZ
copilot. It runs a [Baileys](https://github.com/WhiskeySockets/Baileys) v7 socket
per linked number, exposes a small API-key-authenticated HTTP API, and pushes
inbound messages + lifecycle events to the app over an HMAC-signed webhook. Auth
state is persisted in **Redis (Upstash REST)** so sessions survive restarts and
redeploys on platforms with no disk.

The Meta **Cloud API** channel stays as-is; QR accounts are additive.

> [!CAUTION]
> **Ban-risk warning.** WhatsApp QR-pairing via Baileys uses an unofficial,
> reverse-engineered implementation of the WhatsApp Web protocol. It is **not**
> sanctioned by WhatsApp/Meta and violates WhatsApp's Terms of Service. Any number
> linked this way can be rate-limited, temporarily suspended, or permanently banned
> at any time, without warning or appeal — independent of how carefully the bridge
> behaves. **NEVER link the primary ClickDZ business number** or any number the
> business cannot afford to lose. Use dedicated secondary numbers only, treat every
> linked number as disposable, keep sending volumes human-like, and retain the
> official Meta Cloud API path as the durable channel for anything business-critical.

---

## Architecture at a glance

- **Runtime:** Node 22+, ESM. **Deps (minimal):** `@whiskeysockets/baileys` (v7),
  `qrcode`, `pino`. HTTP is bare `node:http` (no framework). Redis is spoken over
  Upstash REST with `fetch` — no DB client.
- **Auth state + roster:** custom `SignalKeyStore` plus a durable instance
  registry over Upstash REST, or disk-backed state on a Droplet. Every persisted
  instance is automatically rebooted after a restart; paired numbers do not
  silently disappear from the process roster.
- **Inbound:** `messages.upsert` (1:1 text and rich media) → a per-instance HMAC
  signed POST to the app. Media bytes are retained under `MEDIA_DIR` and fetched
  through the authenticated media endpoint; tokens never reach the browser.
- **Outbound (app→WhatsApp):** `POST /instances/:id/messages/text` with
  `x-api-key: $BRIDGE_TOKEN`.
- **Single-instance invariant:** exactly one process; Baileys holds one live
  WebSocket per account. **Never scale out** (duplicate sockets → double sends /
  ban risk). Scale up instead.

---

## HTTP API

`GET /health` — **no auth.** `{ ok: true, accounts: <n>, uptime: <seconds> }`.

All other endpoints require `x-api-key: $BRIDGE_TOKEN` (the legacy
`Authorization: Bearer` form is also accepted; both use constant-time compare):

| Method & path | Body | Returns |
|---|---|---|
| `GET /instances` | — | `[{id,label,status,connected,phone?,connectedAt?}]` |
| `POST /instances` | `{name,webhookUrl}` | `{id,label,status,webhookSecret}`; the secret is returned once |
| `POST /instances/:id/logout` | — | `{ok:true}` (logout + forget auth/registry state) |
| `GET /instances/:id/qr` | — | `{qr:<raw string>\|null,status,connected}` (`202` while the QR is not ready) |
| `GET /instances/:id/qr.png` | — | Current QR PNG (`202` while not ready) |
| `POST /instances/:id/messages/text` | `{to,text}` | `{ok:true,messageId}` |
| `GET /instances/:id/messages/:mid/media` | — | Original media bytes with their Content-Type |

`status ∈ pairing | connected | disconnected | logged_out`.
Pairing flow: `POST /instances {name,webhookUrl}` → poll
`GET /instances/:id/qr` and render `/instances/:id/qr.png` → scan with the phone
→ `status` flips to `connected` and the QR clears.

Admin diagnostics use `x-admin-key: $ADMIN_API_KEY` and return sanitized status
only: `GET /admin/tenants`, `GET /admin/instances`, and `GET /admin/sessions`.
`POST /admin/tenants` returns the tenant API key for app self-provisioning.

### Outbound events → app webhook

Each instance gets its own webhook secret. The bridge POSTs an envelope to that
instance's webhook URL with `X-WA-Event`, `X-WA-Instance`, and
`X-WA-Signature: <hex>`, where `hex = HMAC_SHA256(instanceSecret, rawBody)`.
Delivery retries with exponential backoff (1s, 2s, 4s, 8s, 30s); a webhook
failure never crashes the socket.

```jsonc
{ "event":"message", "instanceId":"<id>", "timestamp":"<ISO>",
  "data": { "id":"<wa id>", "chatPhone":"<digits>", "pushName":"...",
    "text":"caption or text", "hasMedia":true,
    "media": { "type":"image|audio|video|document|sticker",
      "mimeType":"...", "fileName":"...", "voice":true } } }
```

Rich media is relayed as structured metadata. The app uses the authenticated
media endpoint for previews/playback and can transcribe audio when configured.

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `BRIDGE_TOKEN` | ✅ always | — | API key; set Vercel `WA_GATEWAY_API_KEY` to the same value. |
| `BRIDGE_WEBHOOK_SECRET` | optional | `BRIDGE_TOKEN` | Legacy `/accounts` webhook fallback only; `/instances` generates isolated secrets. |
| `APP_WEBHOOK_URL` | ✅ always | — | Where events are POSTed, e.g. `https://clickdzmax.vercel.app/api/whatsapp/bridge`. |
| `KV_REST_API_URL` | ✅ when `AUTH_STORE=redis` | — | Upstash Redis REST base URL. |
| `KV_REST_API_TOKEN` | ✅ when `AUTH_STORE=redis` | — | Upstash Redis REST token. |
| `AUTH_STORE` | optional | `redis` if `KV_REST_API_*` set, else `disk` | `redis` (prod) or `disk` (local dev). |
| `AUTH_STATE_PREFIX` | optional | `wa:bridge:auth` | Redis key namespace for auth state. |
| `PORT` | optional | `8080` | App Platform injects `$PORT`; the server reads it. |
| `LOG_LEVEL` | optional | `info` | `info` (prod) / `debug` (dev). Message bodies never logged at info. |
| `SEND_THROTTLE_MS` | optional | `0` | Per-account outbound pacing (ms) for anti-ban. `0` = off. |
| `AUTH_DISK_DIR` | optional | `./auth_state` | Disk-store root (only when `AUTH_STORE=disk`). |
| `MEDIA_DIR` | optional | `./media` | Rich-media byte store; use `/var/lib/wa-bridge/media` on a Droplet. |
| `MAX_MEDIA_BYTES` | optional | `10485760` | Per-message media persistence limit. |
| `MEDIA_RETENTION_DAYS` | optional | `30` | Deletes expired stored media during periodic cleanup. |
| `ADMIN_API_KEY` | optional | — | Enables admin diagnostics and `POST /admin/tenants`; normally set app `WA_GATEWAY_API_KEY=BRIDGE_TOKEN` instead. |

The process **fails fast** with a clear message if a required variable is missing.
**Zero secrets live in this repo** — it is public so DigitalOcean can clone it
anonymously; all config is env-only.

---

## Local development

```bash
npm install
BRIDGE_TOKEN=dev-token \
BRIDGE_WEBHOOK_SECRET=dev-secret \
APP_WEBHOOK_URL=https://example.com/api/whatsapp/bridge \
AUTH_STORE=disk \
npm start
# → GET http://localhost:8080/health  →  {"ok":true,"accounts":0,"uptime":...}
```

Then `POST /instances {name,webhookUrl}` with `x-api-key: dev-token`, poll
`/instances/:id/qr`, render `/instances/:id/qr.png`, and scan it with a
**secondary** WhatsApp number.

---

## Deployment

### Primary — DigitalOcean App Platform (public git source)

App Platform has **no persistent disk** (filesystem wiped every deploy), so
`AUTH_STORE=redis` is mandatory here. The public repo is cloned anonymously — no
GitHub OAuth/App install required.

- **Raw REST:** `POST https://api.digitalocean.com/v2/apps` with
  `Authorization: Bearer $DIGITALOCEAN_ACCESS_TOKEN` and the body in
  [`deploy/do-app.json`](deploy/do-app.json) (fill the `<FILL:SECRET>` env values first).
- **doctl:** `doctl apps create --spec deploy/app.yaml`.
- Read back `GET /v2/apps/{id}` for `default_ingress` (public URL) and `phase`
  (`ACTIVE`). **Update = `PUT /v2/apps/{id}`** with the same spec (rebuilds from the
  latest branch HEAD; `deploy_on_push` is unavailable on the anonymous git source).
- `instance_count` **MUST stay 1** (single-instance invariant). Size **up** for more
  sessions: `apps-s-1vcpu-0.5gb` ≈ 2–4 sessions; `apps-s-1vcpu-1gb` for 5+.
- Region `fra` or `ams` (lowest latency to Algeria among App-Platform regions).

### Fallback — DigitalOcean Droplet (cloud-init)

Fully unattended VM provisioning when App Platform's buildpack fights a bare Node
service. Uses [`deploy/cloud-init.sh`](deploy/cloud-init.sh) as `user_data`: installs
Node 22, clones the public repo, writes `/etc/wa-bridge.env`, runs a `systemd` unit
with `Restart=always`, and adds a 30-min `git pull && restart` update cron.

```bash
python3 digitalocean.py droplets create \
  --name clickdz-wa-bridge --region fra1 --size s-1vcpu-1gb \
  --image ubuntu-24-04-x64 --tags wa-bridge \
  --user-data "$(cat deploy/cloud-init.sh)"
```

Attach a Reserved IP, point a DNS hostname at it, and fill the
`<FILL:BRIDGE_DOMAIN>` plus secret placeholders before creating. The script puts
Caddy in front of the private Node port, obtains HTTPS automatically, and
firewalls public port 8080. Set Vercel `WA_GATEWAY_URL` to that HTTPS hostname;
never send the API key to a plaintext public origin.

> Railway is intentionally not supported here: its git-source deploys require an
> interactive GitHub-App install that can't be performed from an HTTPS-only sandbox.

---

## App-side integration contract

Set these on the Vercel project, then redeploy:

- `WA_GATEWAY_URL=https://<bridge-origin>`
- `WA_GATEWAY_API_KEY=<the bridge BRIDGE_TOKEN>`
- `APP_BASE_URL=https://clickdzmax.vercel.app`

Do not set the retired `WA_BRIDGE_*` variables. Instance creation returns the
per-instance secret that the app persists server-side and uses to verify the raw
body signature on `/api/whatsapp/bridge`.

## Notes / limitations

- Real WhatsApp pairing requires a live QR scan and cannot be validated in CI; the
  socket/auth/reconnect logic is implemented per the Baileys v7 API. `/health` and
  auth gating are the parts covered by the local boot test.
- Baileys v7 is currently published as `7.0.0-rc14` (its `latest` dist-tag); the
  version is pinned in `package.json` for reproducible public deploys.
