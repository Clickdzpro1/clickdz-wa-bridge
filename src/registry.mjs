import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Small durable registry that tells the process which persisted Baileys auth
// states to boot after a restart. Auth credentials alone are not discoverable
// safely from Redis, so persisting the account roster is essential.

export function makeRegistry({ config, redis, logger }) {
  const redisKey = `${config.authStatePrefix}:instances`;
  const diskPath = join(config.authDiskDir, 'instances.json');

  async function load() {
    try {
      const raw =
        config.authStore === 'redis'
          ? await redis.get(redisKey)
          : await readFile(diskPath, 'utf8').catch((err) => {
              if (err.code === 'ENOENT') return null;
              throw err;
            });
      if (!raw) return [];
      const value = JSON.parse(raw);
      return Array.isArray(value)
        ? value.filter((item) => item && typeof item.id === 'string')
        : [];
    } catch (err) {
      logger.error({ err: err.message }, 'instance registry load failed');
      throw err;
    }
  }

  async function save(instances) {
    const body = JSON.stringify(instances);
    if (config.authStore === 'redis') {
      await redis.set(redisKey, body);
      return;
    }
    await mkdir(dirname(diskPath), { recursive: true });
    const temp = `${diskPath}.${process.pid}.tmp`;
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, diskPath);
  }

  return { load, save };
}
