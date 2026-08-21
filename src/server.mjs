import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 1_000_000;

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function secretEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

function apiKeyOk(req, expected) {
  const direct = req.headers['x-api-key'];
  if (secretEqual(direct, expected)) return true;
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  return Boolean(match && secretEqual(match[1], expected));
}

function adminKeyOk(req, expected) {
  return Boolean(expected && secretEqual(req.headers['x-admin-key'], expected));
}

function adminInstanceView(instance) {
  return {
    id: instance.id,
    name: instance.label,
    status: instance.status,
    connected: instance.connected,
  };
}

function limitFromUrl(url, fallback) {
  const value = Number(url.searchParams.get('limit'));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function cleanInstanceId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function webhookUrl(value, fallback) {
  const candidate = String(value || fallback || '').trim();
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sendBinary(res, status, body, mimeType, fileName) {
  if (!body) return send(res, status, { ok: false, error: status === 202 ? 'not_ready' : 'not_found' });
  res.writeHead(status, {
    'Content-Type': mimeType,
    'Content-Length': body.length,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    ...(fileName
      ? { 'Content-Disposition': `inline; filename="${String(fileName).replace(/[\r\n"]/g, '')}"` }
      : {}),
  });
  res.end(body);
}

export function createServer({ config, manager, logger, startTime }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method || 'GET';

      if (method === 'GET' && path === '/health') {
        return send(res, 200, {
          ok: true,
          status: 'healthy',
          instances: manager.count(),
          connected: manager.connectedCount(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        });
      }

      if (path.startsWith('/admin/')) {
        if (!adminKeyOk(req, config.adminApiKey)) {
          return send(res, 401, { ok: false, error: 'unauthorized' });
        }
        const instances = manager.list().map(adminInstanceView);
        if (method === 'POST' && path === '/admin/tenants') {
          return send(res, 200, { apiKey: config.bridgeToken });
        }
        if (method === 'GET' && path === '/admin/tenants') {
          return send(res, 200, {
            tenants: [
              {
                id: 'default',
                name: 'clickdzmax',
                status: 'active',
                instanceCount: instances.length,
              },
            ],
          });
        }
        if (method === 'GET' && path === '/admin/instances') {
          return send(res, 200, { instances });
        }
        if (method === 'GET' && path === '/admin/sessions') {
          return send(res, 200, { sessions: instances });
        }
        return send(res, 404, { ok: false, error: 'not_found' });
      }

      if (!apiKeyOk(req, config.bridgeToken)) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (method === 'GET' && (path === '/instances' || path === '/accounts')) {
        return send(res, 200, manager.list());
      }

      if (method === 'GET' && path === '/archives') {
        return send(res, 200, { archives: await manager.listArchives() });
      }

      if (method === 'POST' && path === '/instances') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
        const target = webhookUrl(body.webhookUrl, config.appWebhookUrl);
        if (!target) return send(res, 400, { ok: false, error: 'invalid_webhook_url' });
        const id = randomUUID();
        const secret = randomBytes(32).toString('hex');
        const view = await manager.create({
          id,
          label: String(body.name || 'WhatsApp').trim().slice(0, 80),
          webhookUrl: target,
          webhookSecret: secret,
        });
        return send(res, 201, { ...view, webhookSecret: secret });
      }

      // Backwards-compatible old bridge create endpoint.
      if (method === 'POST' && path === '/accounts') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
        const id = cleanInstanceId(body.id);
        if (!id) return send(res, 400, { ok: false, error: 'invalid_instance_id' });
        const view = await manager.create({ id, label: body.label });
        return send(res, 200, view);
      }

      const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments[0] === 'instances' && segments[1]) {
        const id = cleanInstanceId(segments[1]);
        if (!id) return send(res, 400, { ok: false, error: 'invalid_instance_id' });

        if (method === 'GET' && segments.length === 3 && segments[2] === 'qr') {
          const out = manager.getQr(id);
          return out
            ? send(res, out.qr ? 200 : 202, out)
            : send(res, 404, { ok: false, error: 'instance_not_found' });
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'qr.png') {
          const out = manager.getQrPng(id);
          return out.body
            ? sendBinary(res, 200, out.body, 'image/png')
            : send(res, out.status, { ok: false, error: out.status === 202 ? 'not_ready' : 'instance_not_found' });
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'chats') {
          const chats = await manager.listChats(id, {
            includeMessages: url.searchParams.get('includeMessages') === 'true',
            limit: limitFromUrl(url, 500),
          });
          return chats ? send(res, 200, { chats }) : send(res, 404, { ok: false, error: 'instance_not_found' });
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'messages') {
          const messages = await manager.listMessages(id, limitFromUrl(url, 1000));
          return messages ? send(res, 200, { messages }) : send(res, 404, { ok: false, error: 'instance_not_found' });
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'history') {
          const history = await manager.listMessages(id, limitFromUrl(url, 1000));
          return history ? send(res, 200, { history }) : send(res, 404, { ok: false, error: 'instance_not_found' });
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'sync') {
          let body = {};
          try {
            body = await readJsonBody(req);
          } catch {
            body = {};
          }
          const out = await manager.requestHistorySync(id, { count: Number(body.count) || 50 });
          return out.ok
            ? send(res, 202, out)
            : send(res, out.code || 400, { ok: false, error: out.error });
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'logout') {
          return send(res, 200, await manager.remove(id));
        }
        if (
          method === 'POST' &&
          segments.length === 4 &&
          segments[2] === 'messages' &&
          segments[3] === 'text'
        ) {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
          const out = await manager.send(id, { to: body.to, text: body.text });
          return out.ok
            ? send(res, 200, { ok: true, messageId: out.messageId })
            : send(res, out.code || 400, { ok: false, error: out.error });
        }
        if (
          method === 'GET' &&
          segments.length === 5 &&
          segments[2] === 'messages' &&
          segments[4] === 'media'
        ) {
          const media = await manager.getMedia(id, segments[3]);
          return media
            ? sendBinary(res, 200, media.body, media.mimeType, media.fileName)
            : send(res, 404, { ok: false, error: 'media_not_found' });
        }
      }

      // Backwards-compatible /accounts/:id routes for any old client.
      if (segments[0] === 'accounts' && segments[1]) {
        const id = cleanInstanceId(segments[1]);
        if (!id) return send(res, 400, { ok: false, error: 'invalid_instance_id' });
        if (method === 'DELETE' && segments.length === 2) {
          return send(res, 200, await manager.remove(id));
        }
        if (method === 'GET' && segments[2] === 'qr') {
          const out = manager.getQr(id);
          return out
            ? send(res, 200, out)
            : send(res, 404, { ok: false, error: 'instance_not_found' });
        }
        if (method === 'POST' && segments[2] === 'send') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
          const out = await manager.send(id, { to: body.to, text: body.text });
          return out.ok
            ? send(res, 200, { ok: true, mid: out.messageId })
            : send(res, out.code || 400, { ok: false, error: out.error });
        }
      }

      return send(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      logger.error({ err: err.message }, 'unhandled request error');
      return send(res, 500, { ok: false, error: 'internal_error' });
    }
  });
}
