// Config loaded strictly from environment. No secrets ever live in the repo.
// Fails fast with a clear message if a required variable is missing.

function req(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    return { name, value: undefined, missing: true };
  }
  return { name, value: v, missing: false };
}

function opt(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : v;
}

// Resolve which auth store to use. Explicit AUTH_STORE wins; otherwise infer
// from presence of the Upstash Redis REST env pair.
function resolveAuthStore() {
  const explicit = (process.env.AUTH_STORE || '').toLowerCase().trim();
  const hasRedis = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  if (explicit === 'redis') return 'redis';
  if (explicit === 'disk') return 'disk';
  if (explicit && explicit !== 'redis' && explicit !== 'disk') {
    throw new Error(`AUTH_STORE must be "redis" or "disk" (got "${explicit}")`);
  }
  return hasRedis ? 'redis' : 'disk';
}

export function loadConfig() {
  const authStore = resolveAuthStore();

  // Always-required.
  const required = [req('BRIDGE_TOKEN'), req('BRIDGE_WEBHOOK_SECRET'), req('APP_WEBHOOK_URL')];

  // Redis store additionally requires the Upstash REST pair.
  if (authStore === 'redis') {
    required.push(req('KV_REST_API_URL'), req('KV_REST_API_TOKEN'));
  }

  const missing = required.filter((r) => r.missing).map((r) => r.name);
  if (missing.length) {
    const hint =
      authStore === 'redis'
        ? ''
        : ' (running with AUTH_STORE=disk; set AUTH_STORE=redis + KV_REST_API_* for production)';
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}${hint}. ` +
        `See README.md for the full env var list.`
    );
  }

  const port = parseInt(opt('PORT', '8080'), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number (got "${process.env.PORT}")`);
  }

  return {
    bridgeToken: process.env.BRIDGE_TOKEN,
    bridgeWebhookSecret: process.env.BRIDGE_WEBHOOK_SECRET,
    appWebhookUrl: process.env.APP_WEBHOOK_URL,
    port,
    authStore, // 'redis' | 'disk'
    kvRestUrl: opt('KV_REST_API_URL', ''),
    kvRestToken: opt('KV_REST_API_TOKEN', ''),
    authStatePrefix: opt('AUTH_STATE_PREFIX', 'wa:bridge:auth'),
    // Local-dev disk store root (only used when authStore === 'disk').
    authDiskDir: opt('AUTH_DISK_DIR', './auth_state'),
    logLevel: opt('LOG_LEVEL', 'info'),
    // Per-account outbound send throttle (anti-ban pacing); ms between sends.
    sendThrottleMs: parseInt(opt('SEND_THROTTLE_MS', '0'), 10) || 0,
  };
}
