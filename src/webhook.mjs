import { createHmac } from 'node:crypto';

// Dispatches signed events to the app webhook (APP_WEBHOOK_URL).
//
// Signature scheme (MUST match the app-side /api/whatsapp/bridge verifier):
//   header  X-Bridge-Signature-256: sha256=<hex>
//   hex   = HMAC_SHA256(key = BRIDGE_WEBHOOK_SECRET, msg = rawBody)
//   rawBody is the exact JSON string that is sent as the request body.
//
// Retries with exponential backoff on non-2xx / network error, then drops with
// a log. A webhook failure must NEVER crash the socket or the process.

const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000]; // attempts = length + 1

function sign(secret, rawBody) {
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeWebhookDispatcher({ url, secret, logger }) {
  async function post(event) {
    const rawBody = JSON.stringify(event);
    const signature = sign(secret, rawBody);
    const maxAttempts = BACKOFF_MS.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Bridge-Signature-256': signature,
            },
            body: rawBody,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.ok) {
          logger.debug({ type: event.type, accountId: event.accountId }, 'webhook delivered');
          return true;
        }
        // Non-2xx: retry (app dedups by mid, so retries are safe).
        logger.warn(
          { type: event.type, accountId: event.accountId, status: res.status, attempt },
          'webhook non-2xx, will retry'
        );
      } catch (err) {
        logger.warn(
          { type: event.type, accountId: event.accountId, err: err.message, attempt },
          'webhook error, will retry'
        );
      }

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }

    logger.error(
      { type: event.type, accountId: event.accountId },
      'webhook permanently failed after retries, dropping event'
    );
    return false;
  }

  // Fire-and-forget wrapper: schedules delivery without blocking the caller and
  // guarantees no unhandled rejection ever escapes.
  function dispatch(event) {
    post(event).catch((err) => logger.error({ err: err.message }, 'webhook dispatch crashed'));
  }

  return { dispatch, post, sign };
}
