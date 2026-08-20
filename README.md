# ClickDZ WhatsApp QR Bridge

Multi-account WhatsApp **QR-paired** (WhatsApp-Web-style) bridge for the ClickDZ
copilot. It runs a [Baileys](https://github.com/WhiskeySockets/Baileys) v7 socket
per linked number, exposes a small Bearer-authenticated HTTP admin API, and pushes
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
- **Auth state:** custom `SignalKeyStore` + creds persistence over Upstash REST,
  namespaced per `accountId`, serialized with Baileys' `BufferJSON`. Disk fallback
  (`useMultiFileAuthState`) for local dev via `AUTH_STORE=disk`.
- **Inbound:** `messages.upsert` (notify, non-fromMe, 1:1 text/caption) → signed
  POST to the app. **Outbound (app→WhatsApp):** direct authenticated POST to
  `/accounts/:id/send`.
- **Single-instance invariant:** exactly one process; Baileys holds one live
  WebSocket per account. **Never scale out** (duplicate sockets → double sends /
  ban risk). Scale up instead.

---

## HTTP API

`GET /health` — **no auth.** `{ ok: true, accounts: <n>, uptime: <seconds> }`.

All other endpoints require `Authorization: Bearer $BRIDGE_TOKEN`
(constant-time compare; `401` otherwise):

| Method & path | Body | Returns |
|---|---|---|
| `GET /accounts` | — | `[{id,label,status,phone?,connectedAt?}]` |
| `POST /accounts` | `{id,label}` | `{id,label,status:"pairing"}` (idempotent on `id`; boots a socket) |
| `DELETE /accounts/:id` | — | `{ok:true}` (logout + forget auth state) |
| `GET /accounts/:id/qr` | — | `{qr:<dataUrl>\|null, status}` (`qr` non-null only while `status==="pairing"`) |
| `POST /accounts/:id/send` | `{to,text}` | `{ok:true,mid}` \| `{ok:false,error}` |

`status ∈ pairing | connected | disconnected | logged_out`.
Pairing flow: `POST /accounts {id,label}` → poll `GET /accounts/:id/qr` → render the
returned data-URL → scan with the phone → `status` flips to `connected` and the QR clears.

### Outbound events → app webhook

The bridge POSTs to `APP_WEBHOOK_URL` with header
`X-Bridge-Signature-256: sha256=<hex>` where
`hex = HMAC_SHA256(key=BRIDGE_WEBHOOK_SECRET, msg=rawBody)` (rawBody = the exact
JSON string sent). Delivery retries with exponential backoff (1s, 2s, 4s, 8s, 30s)
then drops-with-log; a webhook failure never crashes the socket.

```jsonc
// inbound message
{ "type":"message.in", "accountId":"<id>", "mid":"<wa msg id>",
  "from":"<digits>", "name":"<pushName?>", "text":"<body>", "timestamp":"<ISO>" }

// account lifecycle
{ "type":"account.status", "accountId":"<id>",
  "status":"pairing"|"connected"|"disconnected"|"logged_out", "phone":"<digits?>" }
```

Non-text messages relay as a placeholder (`[image]`, `[document]`, …) matching the
Cloud webhook convention. Media relay is out of scope for v1.

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `BRIDGE_TOKEN` | ✅ always | — | Bearer token for the admin API. |
| `BRIDGE_WEBHOOK_SECRET` | ✅ always | — | HMAC key for `X-Bridge-Signature-256`. Must equal the app's `WA_BRIDGE_WEBHOOK_SECRET`. |
| `APP_WEBHOOK_URL` | ✅ always | — | Where events are POSTed, e.g. `https://clickdzmax.vercel.app/api/whatsapp/bridge`. |
| `KV_REST_API_URL` | ✅ when `AUTH_STORE=redis` | — | Upstash Redis REST base URL. |
| `KV_REST_API_TOKEN` | ✅ when `AUTH_STORE=redis` | — | Upstash Redis REST token. |
| `AUTH_STORE` | optional | `redis` if `KV_REST_API_*` set, else `disk` | `redis` (prod) or `disk` (local dev). |
| `AUTH_STATE_PREFIX` | optional | `wa:bridge:auth` | Redis key namespace for auth state. |
| `PORT` | optional | `8080` | App Platform injects `$PORT`; the server reads it. |
| `LOG_LEVEL` | optional | `info` | `info` (prod) / `debug` (dev). Message bodies never logged at info. |
| `SEND_THROTTLE_MS` | optional | `0` | Per-account outbound pacing (ms) for anti-ban. `0` = off. |
| `AUTH_DISK_DIR` | optional | `./auth_state` | Disk-store root (only when `AUTH_STORE=disk`). |

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

Then `POST /accounts {id,label}` with the Bearer token, poll `/accounts/:id/qr`,
and scan the data-URL with a **secondary** WhatsApp number.

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

Fill the `<FILL:...>` secrets in the script before creating; secrets are embedded at
create time and live only on the droplet + in DO, never in git. Reach the bridge at
`http://<droplet-ip>:8080` with the Bearer token.

> Railway is intentionally not supported here: its git-source deploys require an
> interactive GitHub-App install that can't be performed from an HTTPS-only sandbox.

---

## App-side integration contract

The app must set `WA_BRIDGE_URL` (this bridge's base URL), `WA_BRIDGE_TOKEN`
(= `BRIDGE_TOKEN`), and `WA_BRIDGE_WEBHOOK_SECRET` (= `BRIDGE_WEBHOOK_SECRET`), and
expose `POST /api/whatsapp/bridge` which:

1. reads the raw body and verifies `X-Bridge-Signature-256` with
   `createHmac("sha256", WA_BRIDGE_WEBHOOK_SECRET) + timingSafeEqual` (`401` on
   mismatch),
2. dedups `message.in` by `mid`, appends the message, and mirrors an escalation,
3. updates the account registry on `account.status`,
4. returns `{ok:true}` fast and never throws.

Console sends route by account mode: `cloud` → Graph API; `qr` → `POST
{WA_BRIDGE_URL}/accounts/:id/send` with the Bearer token.

## Notes / limitations

- Real WhatsApp pairing requires a live QR scan and cannot be validated in CI; the
  socket/auth/reconnect logic is implemented per the Baileys v7 API. `/health` and
  auth gating are the parts covered by the local boot test.
- Baileys v7 is currently published as `7.0.0-rc14` (its `latest` dist-tag); the
  version is pinned in `package.json` for reproducible public deploys.
