import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// Bare node:http server — minimal deps, exact endpoints per spec.

const MAX_BODY_BYTES = 1_000_000; // 1 MB cap on request bodies

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Constant-time bearer token comparison. Returns true only on exact match.
function tokenOk(headerValue, expected) {
  if (typeof headerValue !== 'string') return false;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; guard with a length compare that
  // still runs a comparison to avoid trivial early-exit timing signal.
  if (provided.length !== want.length) {
    // Compare want against itself to burn ~equivalent time, then fail.
    timingSafeEqual(want, want);
    return false;
  }
  return timingSafeEqual(provided, want);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ config, manager, logger, startTime }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method || 'GET';

      // --- GET /health : no auth ---
      if (method === 'GET' && path === '/health') {
        return send(res, 200, {
          ok: true,
          accounts: manager.count(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        });
      }

      // --- everything below requires Bearer BRIDGE_TOKEN ---
      if (!tokenOk(req.headers['authorization'], config.bridgeToken)) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }

      // GET /accounts
      if (method === 'GET' && path === '/accounts') {
        return send(res, 200, manager.list());
      }

      // POST /accounts  {id,label}
      if (method === 'POST' && path === '/accounts') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
        if (!body.id || typeof body.id !== 'string') {
          return send(res, 400, { ok: false, error: 'id (string) is required' });
        }
        const view = await manager.create({ id: body.id, label: body.label });
        return send(res, 200, view);
      }

      // /accounts/:id and sub-resources
      const acctMatch = path.match(/^\/accounts\/([^/]+)(?:\/(qr|send))?$/);
      if (acctMatch) {
        const id = decodeURIComponent(acctMatch[1]);
        const sub = acctMatch[2];

        // DELETE /accounts/:id
        if (method === 'DELETE' && !sub) {
          const out = await manager.remove(id);
          return send(res, 200, out);
        }

        // GET /accounts/:id/qr
        if (method === 'GET' && sub === 'qr') {
          const out = manager.getQr(id);
          if (out === null) return send(res, 404, { ok: false, error: 'account not found' });
          return send(res, 200, out);
        }

        // POST /accounts/:id/send  {to,text}
        if (method === 'POST' && sub === 'send') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
          const out = await manager.send(id, { to: body.to, text: body.text });
          if (out.ok) return send(res, 200, { ok: true, mid: out.mid });
          return send(res, out.code || 400, { ok: false, error: out.error });
        }
      }

      return send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      logger.error({ err: err.message }, 'unhandled request error');
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  });

  return server;
}
