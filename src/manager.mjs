import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { makeAuthState } from './authState.mjs';

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;
const S_WHATSAPP_NET = '@s.whatsapp.net';

function digitsFromJid(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function jidFromDigits(to) {
  return `${String(to).replace(/[^0-9]/g, '')}${S_WHATSAPP_NET}`;
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

function unwrapMessage(message) {
  let content = message;
  for (let i = 0; i < 4 && content; i += 1) {
    if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else if (content.documentWithCaptionMessage?.message)
      content = content.documentWithCaptionMessage.message;
    else break;
  }
  return content;
}

function extractContent(message) {
  const content = unwrapMessage(message);
  const type = getContentType(content);
  if (!type) return { text: '', media: null };
  if (type === 'conversation') return { text: content.conversation || '', media: null };
  if (type === 'extendedTextMessage') {
    return { text: content.extendedTextMessage?.text || '', media: null };
  }
  const mapping = {
    imageMessage: ['image', content.imageMessage],
    videoMessage: ['video', content.videoMessage],
    audioMessage: ['audio', content.audioMessage],
    documentMessage: ['document', content.documentMessage],
    stickerMessage: ['sticker', content.stickerMessage],
  };
  const mapped = mapping[type];
  if (!mapped) return { text: '', media: null };
  const [kind, node] = mapped;
  const caption = node?.caption || '';
  return {
    text: caption,
    media: {
      type: kind,
      mimeType: node?.mimetype || undefined,
      fileName: node?.fileName || undefined,
      caption: caption || undefined,
      voice: kind === 'audio' ? Boolean(node?.ptt) : undefined,
    },
  };
}

export function makeManager({ config, redis, registry, logger, dispatcher }) {
  const sessions = new Map();
  let cleanupTimer = null;

  function publicView(session) {
    return {
      id: session.id,
      label: session.label,
      status: session.status,
      connected: session.status === 'connected',
      ...(session.phone ? { phone: session.phone } : {}),
      ...(session.connectedAt ? { connectedAt: session.connectedAt } : {}),
    };
  }

  const registryView = (session) => ({
    id: session.id,
    label: session.label,
    webhookUrl: session.webhookUrl,
    webhookSecret: session.webhookSecret,
  });

  async function persistRegistry() {
    await registry.save([...sessions.values()].filter((s) => !s.deleted).map(registryView));
  }

  function emit(session, event, data) {
    dispatcher.dispatch({
      url: session.webhookUrl,
      secret: session.webhookSecret,
      event,
      instanceId: session.id,
      data,
    });
  }

  function setStatus(session, status) {
    if (session.status === status) return false;
    session.status = status;
    logger.info({ instanceId: session.id, status }, 'instance status change');
    return true;
  }

  async function persistMedia(instanceId, messageId, bytes, metadata) {
    if (!messageId || !Buffer.isBuffer(bytes) || bytes.length === 0) return false;
    if (bytes.length > config.maxMediaBytes) {
      logger.warn({ instanceId, messageId, bytes: bytes.length }, 'media exceeds storage limit');
      return false;
    }
    const dir = join(config.mediaDir, safeSegment(instanceId));
    const stem = safeSegment(messageId);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(join(dir, `${stem}.bin`), bytes, { mode: 0o600 }),
      writeFile(join(dir, `${stem}.json`), JSON.stringify(metadata), { mode: 0o600 }),
    ]);
    return true;
  }

  async function cleanupExpiredMedia() {
    const cutoff = Date.now() - config.mediaRetentionDays * 24 * 60 * 60 * 1000;
    const instanceDirs = await readdir(config.mediaDir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const instanceDir of instanceDirs) {
      if (!instanceDir.isDirectory()) continue;
      const dir = join(config.mediaDir, instanceDir.name);
      const files = await readdir(dir).catch(() => []);
      for (const file of files) {
        const path = join(dir, file);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
      }
    }
  }

  async function getMedia(instanceId, messageId) {
    if (!sessions.has(instanceId)) return null;
    const dir = join(config.mediaDir, safeSegment(instanceId));
    const stem = safeSegment(messageId);
    try {
      const [body, rawMetadata] = await Promise.all([
        readFile(join(dir, `${stem}.bin`)),
        readFile(join(dir, `${stem}.json`), 'utf8'),
      ]);
      const metadata = JSON.parse(rawMetadata);
      return {
        body,
        mimeType: metadata.mimeType || 'application/octet-stream',
        fileName: metadata.fileName,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn({ instanceId, messageId, err: err.message }, 'media read failed');
      }
      return null;
    }
  }

  async function startSocket(session) {
    const auth = await makeAuthState({ config, redis, accountId: session.id, logger });
    session.auth = auth;
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }
    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
      },
      version,
      logger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30_000,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    session.sock = sock;
    sock.ev.on('creds.update', () => {
      auth.saveCreds().catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'saveCreds failed')
      );
    });
    sock.ev.on('connection.update', (update) => {
      handleConnectionUpdate(session, update).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'connection handler crashed')
      );
    });
    sock.ev.on('messages.upsert', (event) => {
      handleMessagesUpsert(session, event).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'message handler crashed')
      );
    });
  }

  async function handleConnectionUpdate(session, update) {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      session.qrRaw = qr;
      try {
        session.qrPng = await QRCode.toBuffer(qr, { type: 'png', margin: 2, width: 512 });
      } catch (err) {
        session.qrPng = null;
        logger.warn({ instanceId: session.id, err: err.message }, 'QR render failed');
      }
      setStatus(session, 'pairing');
      emit(session, 'qr', { qr });
    }
    if (connection === 'open') {
      session.qrRaw = null;
      session.qrPng = null;
      session.reconnectAttempts = 0;
      session.connectedAt = new Date().toISOString();
      const meId = session.sock?.user?.id || session.auth?.state?.creds?.me?.id;
      session.phone = digitsFromJid(meId);
      setStatus(session, 'connected');
      emit(session, 'instance.ready', {
        phoneNumber: session.phone ? `+${session.phone}` : null,
      });
    }
    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.output?.payload?.statusCode;
      logger.info({ instanceId: session.id, statusCode }, 'connection closed');
      if (session.deleted) return;
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        session.qrRaw = null;
        session.qrPng = null;
        session.phone = undefined;
        session.connectedAt = undefined;
        try {
          await session.auth?.wipe();
        } catch (err) {
          logger.warn({ instanceId: session.id, err: err.message }, 'auth wipe failed on logout');
        }
        setStatus(session, 'logged_out');
        emit(session, 'instance.logged_out', {});
        return;
      }
      setStatus(session, 'disconnected');
      emit(session, 'connection.update', {
        connection: 'disconnected',
        reason: String(statusCode || 'unknown'),
      });
      scheduleReconnect(session);
    }
  }

  function scheduleReconnect(session) {
    if (session.deleted || session.reconnectTimer) return;
    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
    const jitter = Math.floor(Math.random() * 1_000);
    const delay =
      Math.min(BASE_BACKOFF_MS * 2 ** (session.reconnectAttempts - 1), MAX_BACKOFF_MS) + jitter;
    logger.info(
      { instanceId: session.id, attempt: session.reconnectAttempts, delay },
      'scheduling reconnect'
    );
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (session.deleted) return;
      startSocket(session).catch((err) => {
        logger.error({ instanceId: session.id, err: err.message }, 'reconnect failed');
        scheduleReconnect(session);
      });
    }, delay);
  }

  async function handleMessagesUpsert(session, event) {
    if (event.type !== 'notify') return;
    for (const msg of event.messages || []) {
      try {
        if (!msg.message) continue;
        const remoteJid = msg.key?.remoteJid || '';
        if (!remoteJid.endsWith(S_WHATSAPP_NET)) continue;
        const { text, media } = extractContent(msg.message);
        if (!text && !media) continue;
        const messageId = msg.key?.id || '';
        if (media && messageId) {
          try {
            const bytes = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger, reuploadRequest: session.sock?.updateMediaMessage }
            );
            await persistMedia(session.id, messageId, bytes, media);
          } catch (err) {
            logger.warn(
              { instanceId: session.id, messageId, err: err.message },
              'media download failed; metadata will still be relayed'
            );
          }
        }
        const timestampSeconds =
          typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || Math.floor(Date.now() / 1000);
        const data = {
          id: messageId,
          chatJid: remoteJid,
          chatPhone: digitsFromJid(remoteJid),
          sender: msg.key?.participant || remoteJid,
          senderPhone: digitsFromJid(msg.key?.participant || remoteJid),
          pushName: msg.pushName || null,
          text,
          timestamp: new Date(timestampSeconds * 1000).toISOString(),
          isGroup: false,
          hasMedia: Boolean(media),
          fromMe: Boolean(msg.key?.fromMe),
          ...(media ? { media } : {}),
        };
        emit(session, msg.key?.fromMe ? 'message.sent' : 'message', data);
        logger.debug({ instanceId: session.id, messageId }, 'message relayed');
      } catch (err) {
        logger.error({ instanceId: session.id, err: err.message }, 'failed handling message');
      }
    }
  }

  const list = () => [...sessions.values()].map(publicView);
  const get = (id) => (sessions.has(id) ? publicView(sessions.get(id)) : null);
  const count = () => sessions.size;
  const connectedCount = () =>
    [...sessions.values()].filter((session) => session.status === 'connected').length;

  async function create({ id, label, webhookUrl, webhookSecret }, options = {}) {
    if (!id || typeof id !== 'string') throw new Error('id is required');
    const existing = sessions.get(id);
    if (existing) {
      if (label) existing.label = String(label).slice(0, 80);
      if (webhookUrl) existing.webhookUrl = webhookUrl;
      if (webhookSecret) existing.webhookSecret = webhookSecret;
      if (options.persist !== false) await persistRegistry();
      return publicView(existing);
    }
    const session = {
      id,
      label: String(label || id).slice(0, 80),
      webhookUrl: webhookUrl || config.appWebhookUrl,
      webhookSecret: webhookSecret || config.bridgeWebhookSecret,
      status: 'pairing',
      phone: undefined,
      connectedAt: undefined,
      qrRaw: null,
      qrPng: null,
      sock: null,
      auth: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      deleted: false,
      lastSendAt: 0,
    };
    sessions.set(id, session);
    if (options.persist !== false) await persistRegistry();
    logger.info({ instanceId: id }, 'instance created, booting socket');
    startSocket(session).catch((err) => {
      logger.error({ instanceId: id, err: err.message }, 'initial socket boot failed');
      setStatus(session, 'disconnected');
      emit(session, 'connection.update', { connection: 'disconnected', reason: 'boot_failed' });
      scheduleReconnect(session);
    });
    return publicView(session);
  }

  async function restore() {
    await cleanupExpiredMedia().catch((err) =>
      logger.warn({ err: err.message }, 'media retention cleanup failed')
    );
    cleanupTimer = setInterval(() => {
      cleanupExpiredMedia().catch((err) =>
        logger.warn({ err: err.message }, 'media retention cleanup failed')
      );
    }, 6 * 60 * 60 * 1000);
    cleanupTimer.unref();
    const stored = await registry.load();
    for (const item of stored) {
      await create(
        {
          id: item.id,
          label: item.label,
          webhookUrl: item.webhookUrl || config.appWebhookUrl,
          webhookSecret: item.webhookSecret || config.bridgeWebhookSecret,
        },
        { persist: false }
      );
    }
    logger.info({ instances: stored.length }, 'instance registry restored');
  }

  async function remove(id) {
    const session = sessions.get(id);
    if (!session) return { ok: true };
    session.deleted = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    try {
      await session.sock?.logout();
    } catch (err) {
      logger.warn({ instanceId: id, err: err.message }, 'logout failed during delete');
    }
    try {
      session.sock?.end?.(undefined);
    } catch {
      // ignored
    }
    try {
      await session.auth?.wipe();
    } catch (err) {
      logger.warn({ instanceId: id, err: err.message }, 'auth wipe failed during delete');
    }
    emit(session, 'instance.logged_out', {});
    sessions.delete(id);
    await persistRegistry();
    logger.info({ instanceId: id }, 'instance deleted and auth state forgotten');
    return { ok: true };
  }

  function getQr(id) {
    const session = sessions.get(id);
    if (!session) return null;
    return {
      qr: session.status === 'pairing' ? session.qrRaw : null,
      status: session.status,
      connected: session.status === 'connected',
    };
  }

  function getQrPng(id) {
    const session = sessions.get(id);
    if (!session) return { status: 404, body: null };
    if (session.status !== 'pairing' || !session.qrPng) return { status: 202, body: null };
    return { status: 200, body: session.qrPng };
  }

  async function send(id, { to, text }) {
    const session = sessions.get(id);
    if (!session) return { ok: false, error: 'instance_not_found', code: 404 };
    if (session.status !== 'connected' || !session.sock) {
      return { ok: false, error: 'instance_not_connected', code: 409 };
    }
    if (!to || !String(to).replace(/[^0-9]/g, '')) {
      return { ok: false, error: 'invalid_recipient', code: 400 };
    }
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'text_required', code: 400 };
    }
    if (config.sendThrottleMs > 0) {
      const wait = session.lastSendAt + config.sendThrottleMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      const jid = jidNormalizedUser(jidFromDigits(to));
      const sent = await session.sock.sendMessage(jid, { text: text.slice(0, 4000) });
      session.lastSendAt = Date.now();
      return { ok: true, messageId: sent?.key?.id };
    } catch (err) {
      logger.error({ instanceId: id, err: err.message }, 'send failed');
      return { ok: false, error: 'send_failed', code: 502 };
    }
  }

  async function shutdown() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const session of sessions.values()) {
      session.deleted = true;
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      try {
        session.sock?.end?.(undefined);
      } catch {
        // ignored
      }
    }
  }

  return {
    list,
    get,
    count,
    connectedCount,
    create,
    restore,
    remove,
    getQr,
    getQrPng,
    getMedia,
    send,
    shutdown,
  };
}
