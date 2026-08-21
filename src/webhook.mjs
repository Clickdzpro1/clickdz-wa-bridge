import { createHmac } from 'node:crypto';

// Dispatches signed per-instance envelopes to the app webhook.
//
// Signature scheme (MUST match the app-side /api/whatsapp/bridge verifier):
//   headers X-WA-Event, X-WA-Instance, X-WA-Signature
//   signature = hex(HMAC_SHA256(instance webhookSecret, rawBody))
//   rawBody is the exact JSON string that is sent as the request body.
//
// Retries with exponential backoff on non-2xx / network error, then drops with
// a log. A webhook failure must NEVER crash the socket or the process.

const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000]; // attempts = length + 1

function sign(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeWebhookDispatcher({ logger }) {
  async function post({ url, secret, event, instanceId, data }) {
    if (!url || !secret || !instanceId) {
      logger.error({ event, instanceId }, 'webhook target is incomplete');
      return false;
    }
    const envelope = {
      event,
      instanceId,
      timestamp: new Date().toISOString(),
      data,
    };
    const rawBody = JSON.stringify(envelope);
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
              'X-WA-Event': event,
              'X-WA-Instance': instanceId,
              'X-WA-Signature': signature,
            },
            body: rawBody,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.ok) {
          logger.debug({ event, instanceId }, 'webhook delivered');
          return true;
        }
        // Non-2xx: retry (app dedups by mid, so retries are safe).
        logger.warn(
          { event, instanceId, status: res.status, attempt },
          'webhook non-2xx, will retry'
        );
      } catch (err) {
        logger.warn(
          { event, instanceId, err: err.message, attempt },
          'webhook error, will retry'
        );
      }

      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }

    logger.error(
      { event, instanceId },
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
