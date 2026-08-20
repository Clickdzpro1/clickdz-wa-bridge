import {
  initAuthCreds,
  BufferJSON,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

// Builds a persistent AuthenticationState for a single account.
//
// Two backends:
//   - redis: custom SignalKeyStore + creds persistence over Upstash REST,
//     namespaced per accountId, serialized with BufferJSON so Buffers survive
//     JSON round-trips. Required on App Platform (no disk).
//   - disk:  Baileys' useMultiFileAuthState under authDiskDir/<accountId> for
//     local dev only.
//
// Returns: { state, saveCreds, wipe }

function keyName(prefix, accountId, type, id) {
  // Match the reference impl's fixFileName sanitization to keep ids Redis-safe.
  const safe = (s) => String(s).replace(/\//g, '__').replace(/:/g, '-');
  return `${prefix}:${safe(accountId)}:${type}:${safe(id)}`;
}

async function makeRedisAuthState({ redis, prefix, accountId, logger }) {
  const credsKey = `${prefix}:${String(accountId).replace(/[/:]/g, '_')}:creds`;

  // Load creds (or init fresh).
  let creds;
  try {
    const raw = await redis.get(credsKey);
    creds = raw ? JSON.parse(raw, BufferJSON.reviver) : initAuthCreds();
  } catch (err) {
    logger?.warn({ accountId, err: err.message }, 'failed reading creds, starting fresh');
    creds = initAuthCreds();
  }

  const keys = {
    get: async (type, ids) => {
      const redisKeys = ids.map((id) => keyName(prefix, accountId, type, id));
      const values = await redis.mget(redisKeys);
      const data = {};
      ids.forEach((id, i) => {
        const raw = values[i];
        if (raw === null || raw === undefined) {
          data[id] = undefined;
          return;
        }
        let value = JSON.parse(raw, BufferJSON.reviver);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      });
      return data;
    },
    set: async (data) => {
      const entries = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const rk = keyName(prefix, accountId, category, id);
          entries.push([rk, value ? JSON.stringify(value, BufferJSON.replacer) : null]);
        }
      }
      if (entries.length) await redis.msetOrDel(entries);
    },
    clear: async () => {
      await redis.delByPattern(`${prefix}:${String(accountId).replace(/[/:]/g, '_')}:*`);
    },
  };

  const saveCreds = async () => {
    await redis.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
  };

  const wipe = async () => {
    // Forget everything for this account: creds + all key namespaces.
    await redis.delByPattern(`${prefix}:${String(accountId).replace(/[/:]/g, '_')}:*`);
    await redis.del(credsKey);
  };

  return { state: { creds, keys }, saveCreds, wipe };
}

async function makeDiskAuthState({ dir, accountId, logger }) {
  const folder = join(dir, String(accountId).replace(/[/:]/g, '_'));
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const wipe = async () => {
    await rm(folder, { recursive: true, force: true }).catch((err) =>
      logger?.warn({ accountId, err: err.message }, 'disk wipe failed')
    );
  };
  return { state, saveCreds, wipe };
}

export async function makeAuthState({ config, redis, accountId, logger }) {
  if (config.authStore === 'redis') {
    return makeRedisAuthState({
      redis,
      prefix: config.authStatePrefix,
      accountId,
      logger,
    });
  }
  return makeDiskAuthState({ dir: config.authDiskDir, accountId, logger });
}
