import { loadConfig } from './src/config.mjs';
import { makeLogger } from './src/logger.mjs';
import { makeRedis } from './src/redis.mjs';
import { makeWebhookDispatcher } from './src/webhook.mjs';
import { makeManager } from './src/manager.mjs';
import { makeRegistry } from './src/registry.mjs';
import { createServer } from './src/server.mjs';

// --- Fail fast on bad/missing config ---
let config;
try {
  config = loadConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[wa-bridge] FATAL: ${err.message}`);
  process.exit(1);
}

const logger = makeLogger(config.logLevel);
const startTime = Date.now();

logger.info(
  { authStore: config.authStore, port: config.port, appWebhook: !!config.appWebhookUrl },
  'starting wa-bridge'
);

// Redis client is only constructed when the redis auth store is active.
const redis =
  config.authStore === 'redis'
    ? makeRedis({ url: config.kvRestUrl, token: config.kvRestToken })
    : null;

const dispatcher = makeWebhookDispatcher({ logger });

const registry = makeRegistry({ config, redis, logger });
const manager = makeManager({ config, redis, registry, logger, dispatcher });

// Restore and boot every previously-created instance before accepting traffic.
// A registry failure is fatal: serving an empty healthy process would silently
// strand paired numbers until an operator recreated them.
try {
  await manager.restore();
} catch (err) {
  logger.fatal({ err: err.message }, 'instance registry restore failed');
  process.exit(1);
}

const server = createServer({ config, manager, logger, startTime });

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'wa-bridge listening');
});

// --- Never crash the process on stray errors from sockets/webhooks ---
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason?.message || String(reason) }, 'unhandledRejection (ignored)');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message }, 'uncaughtException (ignored)');
});

// --- Graceful shutdown ---
async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  try {
    await manager.shutdown();
  } catch (err) {
    logger.warn({ err: err.message }, 'manager shutdown error');
  }
  server.close(() => process.exit(0));
  // Hard-exit backstop.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
