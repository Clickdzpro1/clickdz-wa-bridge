import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  getContentType,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { makeAuthState } from './authState.mjs';

// Multi-account Baileys manager.
//   sessions: Map<accountId, session>
//   session = { id, label, status, phone, qrDataUrl, sock, auth, ...internals }
//
// status ∈ 'pairing' | 'connected' | 'disconnected' | 'logged_out'

const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 2000;
const S_WHATSAPP_NET = '@s.whatsapp.net';

// Placeholder text for non-text messages, matching the Cloud webhook convention.
const MEDIA_PLACEHOLDER = {
  imageMessage: '[image]',
  videoMessage: '[video]',
  audioMessage: '[audio]',
  documentMessage: '[document]',
  documentWithCaptionMessage: '[document]',
  stickerMessage: '[sticker]',
  contactMessage: '[contact]',
  contactsArrayMessage: '[contacts]',
  locationMessage: '[location]',
  liveLocationMessage: '[location]',
  pollCreationMessage: '[poll]',
  pollCreationMessageV3: '[poll]',
  reactionMessage: '[reaction]',
};

function digitsFromJid(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function jidFromDigits(to) {
  const digits = String(to).replace(/[^0-9]/g, '');
  return `${digits}${S_WHATSAPP_NET}`;
}

// Extract displayable text from a WhatsApp message content object.
// Returns null if the message carries no user-facing content we relay.
function extractText(message) {
  if (!message) return null;
  let content = message;
  // Unwrap common envelopes.
  if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage?.message)
    content = content.documentWithCaptionMessage.message;

  const type = getContentType(content);
  if (!type) return null;

  if (type === 'conversation') return content.conversation || '';
  if (type === 'extendedTextMessage') return content.extendedTextMessage?.text || '';
  // Media with caption → prefer caption, else the type placeholder.
  const cap =
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption;
  if (cap) return cap;
  return MEDIA_PLACEHOLDER[type] || `[${type.replace(/Message$/, '').toLowerCase()}]`;
}

export function makeManager({ config, redis, logger, dispatcher }) {
  const sessions = new Map();

  function publicView(s) {
    return {
      id: s.id,
      label: s.label,
      status: s.status,
      ...(s.phone ? { phone: s.phone } : {}),
      ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}),
    };
  }

  function emitStatus(s) {
    dispatcher.dispatch({
      type: 'account.status',
      accountId: s.id,
      status: s.status,
      ...(s.phone ? { phone: s.phone } : {}),
    });
  }

  function setStatus(s, status, { emit = true } = {}) {
    if (s.status === status) return;
    s.status = status;
    logger.info({ accountId: s.id, status }, 'account status change');
    if (emit) emitStatus(s);
  }

  // Boot (or reboot) the Baileys socket for a session.
  async function startSocket(s) {
    // Build/refresh auth state (creds survive restarts via redis/disk).
    const auth = await makeAuthState({ config, redis, accountId: s.id, logger });
    s.auth = auth;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined; // Baileys falls back to its bundled version.
    }

    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
      },
      version,
      logger,
      browser: Browsers.macOS('Chrome'),
      // Keep the owner's phone receiving its own notifications.
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30000,
      // Do not pull full history; we only relay live inbound.
      syncFullHistory: false,
      // Poll/retry decrypt hook — we do not cache outgoing content for resend.
      getMessage: async () => undefined,
    });
    s.sock = sock;

    sock.ev.on('creds.update', () => {
      auth.saveCreds().catch((err) =>
        logger.error({ accountId: s.id, err: err.message }, 'saveCreds failed')
      );
    });

    sock.ev.on('connection.update', (update) => {
      handleConnectionUpdate(s, update).catch((err) =>
        logger.error({ accountId: s.id, err: err.message }, 'connection.update handler crashed')
      );
    });

    sock.ev.on('messages.upsert', (evt) => {
      handleMessagesUpsert(s, evt).catch((err) =>
        logger.error({ accountId: s.id, err: err.message }, 'messages.upsert handler crashed')
      );
    });
  }

  async function handleConnectionUpdate(s, update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Render QR to a data URL for the /qr endpoint.
      try {
        s.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        logger.warn({ accountId: s.id, err: err.message }, 'QR render failed');
      }
      setStatus(s, 'pairing');
    }

    if (connection === 'open') {
      s.qrDataUrl = null;
      s.reconnectAttempts = 0;
      s.connectedAt = new Date().toISOString();
      const meId = s.sock?.user?.id || s.auth?.state?.creds?.me?.id;
      s.phone = digitsFromJid(meId);
      setStatus(s, 'connected');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.output?.payload?.statusCode;
      logger.info({ accountId: s.id, statusCode }, 'connection closed');

      // If the account was explicitly deleted, stop here.
      if (s.deleted) return;

      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        // 401 loggedOut / 403 forbidden → wipe state, require re-pair. Do NOT reconnect.
        s.qrDataUrl = null;
        s.phone = undefined;
        s.connectedAt = undefined;
        try {
          await s.auth?.wipe();
        } catch (err) {
          logger.warn({ accountId: s.id, err: err.message }, 'auth wipe failed on logout');
        }
        setStatus(s, 'logged_out');
        return;
      }

      // Transient / restart-required codes → reconnect with backoff, reusing state.
      // 515 restartRequired, 428 connectionClosed, 408 timedOut, 440 connectionReplaced,
      // 500 badSession, 503 unavailableService, plus any unknown code default-to-retry.
      setStatus(s, 'disconnected');
      scheduleReconnect(s);
    }
  }

  function scheduleReconnect(s) {
    if (s.deleted) return;
    if (s.reconnectTimer) return; // already scheduled
    s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;
    const jitter = Math.floor(Math.random() * 1000);
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (s.reconnectAttempts - 1), MAX_BACKOFF_MS) + jitter;
    logger.info({ accountId: s.id, attempt: s.reconnectAttempts, delay }, 'scheduling reconnect');
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = null;
      if (s.deleted) return;
      startSocket(s).catch((err) => {
        logger.error({ accountId: s.id, err: err.message }, 'reconnect failed, rescheduling');
        scheduleReconnect(s);
      });
    }, delay);
  }

  async function handleMessagesUpsert(s, evt) {
    // Only live notifications; ignore history 'append'.
    if (evt.type !== 'notify') return;
    for (const msg of evt.messages || []) {
      try {
        if (!msg.message) continue;
        if (msg.key?.fromMe) continue; // never mirror our own sends
        const remoteJid = msg.key?.remoteJid || '';
        // Skip groups/status/broadcast — v1 relays 1:1 user chats only.
        if (!remoteJid.endsWith(S_WHATSAPP_NET)) continue;

        const text = extractText(msg.message);
        if (text === null) continue;

        const from = digitsFromJid(remoteJid);
        const mid = msg.key?.id;
        const tsSeconds =
          typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || Math.floor(Date.now() / 1000);
        const timestamp = new Date(tsSeconds * 1000).toISOString();

        dispatcher.dispatch({
          type: 'message.in',
          accountId: s.id,
          mid,
          from,
          ...(msg.pushName ? { name: msg.pushName } : {}),
          text,
          timestamp,
        });
        // Redacted log — never the body or number at info level.
        logger.debug({ accountId: s.id, mid }, 'inbound relayed');
      } catch (err) {
        logger.error({ accountId: s.id, err: err.message }, 'failed handling inbound message');
      }
    }
  }

  // ---- public API used by the HTTP layer ----

  function list() {
    return [...sessions.values()].map(publicView);
  }

  function get(id) {
    const s = sessions.get(id);
    return s ? publicView(s) : null;
  }

  function count() {
    return sessions.size;
  }

  // Idempotent: creating an existing id returns the current view without reboot.
  async function create({ id, label }) {
    if (!id || typeof id !== 'string') throw new Error('id is required');
    const existing = sessions.get(id);
    if (existing) {
      if (label && label !== existing.label) existing.label = label;
      return publicView(existing);
    }
    const s = {
      id,
      label: label || id,
      status: 'pairing',
      phone: undefined,
      qrDataUrl: null,
      sock: null,
      auth: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      deleted: false,
      lastSendAt: 0,
    };
    sessions.set(id, s);
    logger.info({ accountId: id }, 'account created, booting socket');
    // Boot asynchronously; QR will appear via /qr shortly.
    startSocket(s).catch((err) => {
      logger.error({ accountId: id, err: err.message }, 'initial socket boot failed');
      setStatus(s, 'disconnected');
      scheduleReconnect(s);
    });
    return publicView(s);
  }

  async function remove(id) {
    const s = sessions.get(id);
    if (!s) return { ok: true };
    s.deleted = true;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    // Logout (best-effort) then forget auth state.
    try {
      await s.sock?.logout();
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'logout failed during delete (continuing)');
    }
    try {
      s.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    try {
      await s.auth?.wipe();
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'auth wipe failed during delete');
    }
    sessions.delete(id);
    logger.info({ accountId: id }, 'account deleted and auth state forgotten');
    // Best-effort final status to the app.
    dispatcher.dispatch({ type: 'account.status', accountId: id, status: 'logged_out' });
    return { ok: true };
  }

  function getQr(id) {
    const s = sessions.get(id);
    if (!s) return null; // caller maps to 404
    const qr = s.status === 'pairing' ? s.qrDataUrl || null : null;
    return { qr, status: s.status };
  }

  async function send(id, { to, text }) {
    const s = sessions.get(id);
    if (!s) return { ok: false, error: 'account not found', code: 404 };
    if (s.status !== 'connected' || !s.sock) {
      return { ok: false, error: `account not connected (status=${s.status})`, code: 409 };
    }
    if (!to || !String(to).replace(/[^0-9]/g, '')) {
      return { ok: false, error: 'invalid "to"', code: 400 };
    }
    if (typeof text !== 'string' || !text.length) {
      return { ok: false, error: 'invalid "text"', code: 400 };
    }

    // Optional per-account anti-ban pacing.
    if (config.sendThrottleMs > 0) {
      const wait = s.lastSendAt + config.sendThrottleMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    try {
      const jid = jidNormalizedUser(jidFromDigits(to));
      const sent = await s.sock.sendMessage(jid, { text });
      s.lastSendAt = Date.now();
      const mid = sent?.key?.id;
      logger.debug({ accountId: id, mid }, 'outbound sent');
      return { ok: true, mid };
    } catch (err) {
      logger.error({ accountId: id, err: err.message }, 'send failed');
      return { ok: false, error: err.message || 'send failed', code: 502 };
    }
  }

  async function shutdown() {
    for (const s of sessions.values()) {
      s.deleted = true;
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      try {
        s.sock?.end?.(undefined);
      } catch {
        /* ignore */
      }
    }
  }

  return { list, get, count, create, remove, getQr, send, shutdown };
}
