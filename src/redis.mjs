// Minimal Upstash Redis REST client using fetch — same protocol the app's
// lib/redis.ts speaks (KV_REST_API_URL + KV_REST_API_TOKEN). No extra deps.
//
// Upstash REST accepts commands as JSON arrays:
//   single:   POST {base}            body: ["SET","key","val"]
//   pipeline: POST {base}/pipeline    body: [["GET","a"],["GET","b"]]
// and returns { result } or [{ result }, ...] respectively.

export function makeRedis({ url, token }) {
  const base = url.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  async function command(args) {
    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Redis command failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json && json.error) throw new Error(`Redis error: ${json.error}`);
    return json.result;
  }

  async function pipeline(commands) {
    if (!commands.length) return [];
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      headers,
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Redis pipeline failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // json is an array of { result } | { error }
    return json.map((entry) => {
      if (entry && entry.error) throw new Error(`Redis pipeline error: ${entry.error}`);
      return entry ? entry.result : null;
    });
  }

  return {
    async get(key) {
      return command(['GET', key]);
    },
    async set(key, value) {
      return command(['SET', key, value]);
    },
    async del(...keys) {
      if (!keys.length) return 0;
      return command(['DEL', ...keys]);
    },
    // Batched GET for many keys. Returns array aligned to input order.
    async mget(keys) {
      if (!keys.length) return [];
      return command(['MGET', ...keys]);
    },
    // Batched SET/DEL for a map of {key: value|null}. null => DEL.
    async msetOrDel(entries) {
      const cmds = [];
      for (const [key, value] of entries) {
        cmds.push(value === null || value === undefined ? ['DEL', key] : ['SET', key, value]);
      }
      return pipeline(cmds);
    },
    // SCAN all keys matching a pattern (for "forget auth state" on delete).
    async scanAll(pattern, count = 200) {
      let cursor = '0';
      const found = [];
      do {
        const [next, batch] = await command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count)]);
        cursor = next;
        if (Array.isArray(batch)) found.push(...batch);
      } while (cursor !== '0');
      return found;
    },
    // Delete everything matching a pattern. Returns count deleted.
    async delByPattern(pattern) {
      const keys = await this.scanAll(pattern);
      if (!keys.length) return 0;
      // DEL in chunks to keep request bodies reasonable.
      let total = 0;
      for (let i = 0; i < keys.length; i += 256) {
        total += (await this.del(...keys.slice(i, i + 256))) || 0;
      }
      return total;
    },
    pipeline,
    command,
  };
}
