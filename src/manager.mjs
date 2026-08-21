import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isHostedLidUser,
  isLidUser,
  isPnUser,
  normalizeMessageContent,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { makeAuthState } from './authState.mjs';

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;
const HISTORY_LIMIT = 2_000;
const CHAT_LIMIT = 1_000;
const LOGOUT_TIMEOUT_MS = 3_000;
const S_WHATSAPP_NET = '@s.whatsapp.net';
const BACKFILL_CHAT_LIMIT = 40;
const BACKFILL_DEFAULT_COUNT = 50;

function isIndividualJid(jid) {
  return Boolean(
    typeof jid === 'string' &&
      (isPnUser(jid) || isLidUser(jid) || isHostedLidUser(jid) || jid.endsWith(S_WHATSAPP_NET))
  );
}

function toFiniteNumber(value) {
  const raw = typeof value === 'number' ? value : Number(value?.low ?? value?.toNumber?.() ?? value);
  return Number.isFinite(raw) ? raw : null;
}

function messageKeyForHistory(msg) {
  if (!msg?.key?.id || !msg.key.remoteJid) return null;
  return {
    id: msg.key.id,
    remoteJid: msg.key.remoteJid,
    fromMe: Boolean(msg.key.fromMe),
    ...(msg.key.participant ? { participant: msg.key.participant } : {}),
  };
}

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

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapMessage(message) {
  let content = normalizeMessageContent(message) || message;
  for (let i = 0; i < 4 && content; i += 1) {
    if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else if (content.documentWithCaptionMessage?.message)
      content = content.documentWithCaptionMessage.message;
    else break;
    content = normalizeMessageContent(content) || content;
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
  if (type === 'buttonsResponseMessage') {
    return {
      text:
        content.buttonsResponseMessage?.selectedDisplayText ||
        content.buttonsResponseMessage?.selectedButtonId ||
        '',
      media: null,
    };
  }
  if (type === 'listResponseMessage') {
    return {
      text:
        content.listResponseMessage?.title ||
        content.listResponseMessage?.singleSelectReply?.selectedRowId ||
        '',
      media: null,
    };
  }
  if (type === 'templateButtonReplyMessage') {
    return {
      text:
        content.templateButtonReplyMessage?.selectedDisplayText ||
        content.templateButtonReplyMessage?.selectedId ||
        '',
      media: null,
    };
  }
  if (type === 'interactiveResponseMessage') {
    return {
      text:
        content.interactiveResponseMessage?.body?.text ||
        content.interactiveResponseMessage?.nativeFlowResponseMessage?.name ||
        '',
      media: null,
    };
  }
  if (type === 'locationMessage') return { text: '[location]', media: null };
  if (type === 'contactMessage') return { text: '[contact]', media: null };
  if (type === 'contactsArrayMessage') return { text: '[contacts]', media: null };
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

  function rememberJidMapping(session, lid, pn) {
    if (!session || !lid || !pn || !isLidUser(lid) || !isPnUser(pn)) return;
    session.jidMap ||= new Map();
    session.jidMap.set(lid, pn);
  }

  function rememberMappingsFromHistory(session, event) {
    for (const item of event?.lidPnMappings || []) {
      rememberJidMapping(session, item?.lid, item?.pn);
    }
    for (const item of [...(event?.contacts || []), ...(event?.chats || [])]) {
      rememberJidMapping(session, item?.id || item?.lidJid || item?.accountLid, item?.pnJid || item?.phoneNumber);
      rememberJidMapping(session, item?.lidJid || item?.accountLid, item?.id || item?.pnJid || item?.phoneNumber);
    }
  }

  function resolveChatJid(session, jid) {
    if (!jid || typeof jid !== 'string') return '';
    if (isPnUser(jid) || jid.endsWith(S_WHATSAPP_NET)) return jid;
    return session?.jidMap?.get(jid) || jid;
  }

  function phoneFromChatJid(session, jid) {
    const resolved = resolveChatJid(session, jid);
    return digitsFromJid(resolved) || digitsFromJid(jid);
  }

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

  function historyKey(instanceId) {
    return `${config.authStatePrefix}:history:${instanceId}`;
  }

  function historyDiskPath(instanceId) {
    return join(config.authDiskDir, 'history', `${safeSegment(instanceId)}.json`);
  }

  function chatsKey(instanceId) {
    return `${config.authStatePrefix}:chats:${instanceId}`;
  }

  function chatsDiskPath(instanceId) {
    return join(config.authDiskDir, 'chats', `${safeSegment(instanceId)}.json`);
  }

  async function readHistory(instanceId) {
    try {
      const raw =
        config.authStore === 'redis'
          ? await redis.get(historyKey(instanceId))
          : await readFile(historyDiskPath(instanceId), 'utf8').catch((err) => {
              if (err.code === 'ENOENT') return null;
              throw err;
            });
      if (!raw) return [];
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
    } catch (err) {
      logger.warn({ instanceId, err: err.message }, 'history read failed');
      return [];
    }
  }

  async function writeHistory(instanceId, messages) {
    const body = JSON.stringify(messages.slice(-HISTORY_LIMIT));
    if (config.authStore === 'redis') {
      await redis.set(historyKey(instanceId), body);
      return;
    }
    await mkdir(join(config.authDiskDir, 'history'), { recursive: true });
    await writeFile(historyDiskPath(instanceId), body, { mode: 0o600 });
  }

  async function readChats(instanceId) {
    try {
      const raw =
        config.authStore === 'redis'
          ? await redis.get(chatsKey(instanceId))
          : await readFile(chatsDiskPath(instanceId), 'utf8').catch((err) => {
              if (err.code === 'ENOENT') return null;
              throw err;
            });
      if (!raw) return [];
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
    } catch (err) {
      logger.warn({ instanceId, err: err.message }, 'chat roster read failed');
      return [];
    }
  }

  async function writeChats(instanceId, chats) {
    const body = JSON.stringify(chats.slice(0, CHAT_LIMIT));
    if (config.authStore === 'redis') {
      await redis.set(chatsKey(instanceId), body);
      return;
    }
    await mkdir(join(config.authDiskDir, 'chats'), { recursive: true });
    await writeFile(chatsDiskPath(instanceId), body, { mode: 0o600 });
  }

  function timestampFromAny(value) {
    const raw =
      typeof value === 'number'
        ? value
        : Number(value?.low ?? value?.toNumber?.() ?? value) || Math.floor(Date.now() / 1000);
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
  }

  function chatRecordFromWa(session, chat) {
    const id = chat?.id || chat?.jid || chat?.remoteJid || '';
    rememberJidMapping(session, chat?.lidJid || chat?.accountLid || id, chat?.pnJid || chat?.phoneNumber);
    if (!isIndividualJid(id)) return null;
    const resolvedId = resolveChatJid(session, id);
    const phone = phoneFromChatJid(session, id);
    if (!phone) return null;
    const latestWrapped = Array.isArray(chat.messages) ? chat.messages.at(-1) : null;
    const latestMessage = latestWrapped?.message || latestWrapped;
    const latestContent = latestMessage?.message ? extractContent(latestMessage.message) : null;
    const latestTimestamp = toFiniteNumber(latestMessage?.messageTimestamp);
    const latestText =
      latestContent?.text ||
      (latestContent?.media ? `[${latestContent.media.type || 'media'}]` : '');
    return {
      id: resolvedId,
      chatId: resolvedId,
      chatJid: resolvedId,
      ...(resolvedId !== id ? { sourceChatJid: id } : {}),
      chatPhone: phone,
      phone,
      name: chat.name || chat.notify || chat.verifiedName || phone,
      lastMessageAt: timestampFromAny(
        latestMessage?.messageTimestamp ??
          chat.lastMessageRecvTimestamp ??
          chat.conversationTimestamp ??
          chat.timestamp
      ),
      lastText: latestText,
      ...(messageKeyForHistory(latestMessage) ? { latestMessageKey: messageKeyForHistory(latestMessage) } : {}),
      ...(latestTimestamp ? { latestMessageTimestamp: latestTimestamp } : {}),
      messages: [],
    };
  }

  async function mergeChats(session, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const current = session.chats || (await readChats(session.id));
    const byPhone = new Map(current.map((item) => [item.phone, item]));
    let changed = 0;
    let latestImported = 0;
    for (const row of rows) {
      const next = chatRecordFromWa(session, row);
      if (!next) continue;
      const existing = byPhone.get(next.phone);
      byPhone.set(next.phone, {
        ...existing,
        ...next,
        name: next.name || existing?.name || next.phone,
        lastMessageAt: existing?.lastMessageAt && existing.lastMessageAt > next.lastMessageAt
          ? existing.lastMessageAt
          : next.lastMessageAt,
      });
      const latestWrapped = Array.isArray(row.messages) ? row.messages.at(-1) : null;
      const latestMessage = latestWrapped?.message || latestWrapped;
      if (latestMessage?.key && latestMessage?.message) {
        const data = await dataFromMessage(session, latestMessage, {
          downloadMedia: false,
          pushName: next.name,
        });
        if (data && (await appendHistory(session, data))) latestImported += 1;
      }
      changed += 1;
    }
    const sorted = [...byPhone.values()]
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, CHAT_LIMIT);
    session.chats = sorted;
    await writeChats(session.id, sorted);
    if (latestImported > 0) {
      logger.info({ instanceId: session.id, imported: latestImported }, 'latest chat messages cached');
    }
    return changed;
  }

  async function mergeContacts(session, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const current = session.chats || (await readChats(session.id));
    const byPhone = new Map(current.map((item) => [item.phone, item]));
    let changed = 0;
    for (const row of rows) {
      const id = row?.id || row?.jid || row?.remoteJid || '';
      rememberJidMapping(session, row?.lidJid || row?.accountLid || id, row?.pnJid || row?.phoneNumber);
      if (!isIndividualJid(id)) continue;
      const resolvedId = resolveChatJid(session, id);
      const phone = phoneFromChatJid(session, id);
      if (!phone) continue;
      const name = String(row.name || row.notify || row.verifiedName || '').trim();
      if (!name) continue;
      const existing = byPhone.get(phone);
      if (!existing) {
        byPhone.set(phone, {
          id: resolvedId,
          chatId: resolvedId,
          chatJid: resolvedId,
          ...(resolvedId !== id ? { sourceChatJid: id } : {}),
          chatPhone: phone,
          phone,
          name,
          lastMessageAt: new Date(0).toISOString(),
          lastText: '',
          messages: [],
        });
        changed += 1;
        continue;
      }
      if (existing.name !== name) {
        byPhone.set(phone, { ...existing, name });
        changed += 1;
      }
    }
    if (changed === 0) return 0;
    const sorted = [...byPhone.values()]
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, CHAT_LIMIT);
    session.chats = sorted;
    await writeChats(session.id, sorted);
    return changed;
  }

  function historyDedupKey(message) {
    return message.id
      ? `id:${message.id}`
      : `fallback:${message.chatJid}:${message.fromMe ? 'out' : 'in'}:${message.timestamp}:${message.text}`;
  }

  async function appendHistory(session, message) {
    const current = session.history || (await readHistory(session.id));
    const key = historyDedupKey(message);
    if (current.some((item) => historyDedupKey(item) === key)) {
      session.history = current;
      return false;
    }
    const next = [...current, message]
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .slice(-HISTORY_LIMIT);
    session.history = next;
    await writeHistory(session.id, next);
    return true;
  }

  function timestampFromMessage(msg) {
    const raw = msg.messageTimestamp;
    const seconds =
      typeof raw === 'number' ? raw : Number(raw?.low ?? raw) || Math.floor(Date.now() / 1000);
    const millis = seconds < 10_000_000_000 ? seconds * 1000 : seconds;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
  }

  async function dataFromMessage(session, msg, options = {}) {
    if (!msg.message) return null;
    const remoteJid = msg.key?.remoteJid || '';
    if (!isIndividualJid(remoteJid)) return null;
    const resolvedJid = resolveChatJid(session, remoteJid);
    const chatPhone = phoneFromChatJid(session, remoteJid);
    if (!chatPhone) return null;
    const { text, media } = extractContent(msg.message);
    if (!text && !media) return null;
    const messageId = msg.key?.id || '';
    if (options.downloadMedia !== false && media && messageId) {
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
    const pushName = msg.pushName || options.pushName || null;
    return {
      id: messageId,
      chatJid: resolvedJid,
      ...(resolvedJid !== remoteJid ? { sourceChatJid: remoteJid } : {}),
      chatPhone,
      sender: msg.key?.participant || remoteJid,
      senderPhone: digitsFromJid(msg.key?.participant || remoteJid),
      pushName,
      text,
      body: text,
      message: text,
      timestamp: timestampFromMessage(msg),
      isGroup: false,
      hasMedia: Boolean(media),
      fromMe: Boolean(msg.key?.fromMe),
      ...(messageKeyForHistory(msg) ? { sourceMessageKey: messageKeyForHistory(msg) } : {}),
      ...(toFiniteNumber(msg.messageTimestamp) ? { sourceMessageTimestamp: toFiniteNumber(msg.messageTimestamp) } : {}),
      ...(media ? { media } : {}),
    };
  }

  function contactNamesFromHistory(session, event) {
    const names = new Map();
    for (const item of [...(event.contacts || []), ...(event.chats || [])]) {
      const id = item?.id;
      if (typeof id !== 'string') continue;
      const name = item.name || item.notify || item.verifiedName;
      if (typeof name === 'string' && name.trim()) {
        const cleaned = name.trim();
        names.set(id, cleaned);
        const resolved = resolveChatJid(session, id);
        if (resolved) names.set(resolved, cleaned);
      }
    }
    return names;
  }

  function historyMessagesFromEvent(event) {
    const messages = Array.isArray(event?.messages) ? [...event.messages] : [];
    for (const chat of event?.chats || []) {
      const wrapped = Array.isArray(chat?.messages) ? chat.messages : [];
      for (const item of wrapped) {
        const message = item?.message || item;
        if (message?.key && message?.message) messages.push(message);
      }
    }
    return messages;
  }

  async function handleHistorySet(session, event) {
    rememberMappingsFromHistory(session, event || {});
    const names = contactNamesFromHistory(session, event || {});
    const chatCount = await mergeChats(session, event?.chats || []);
    let imported = 0;
    const historyMessages = historyMessagesFromEvent(event);
    for (const msg of historyMessages) {
      try {
        const remoteJid = msg.key?.remoteJid || '';
        const data = await dataFromMessage(session, msg, {
          downloadMedia: false,
          pushName: names.get(remoteJid) || names.get(resolveChatJid(session, remoteJid)),
        });
        if (data && (await appendHistory(session, data))) imported += 1;
      } catch (err) {
        logger.warn({ instanceId: session.id, err: err.message }, 'history message import failed');
      }
    }
    logger.info(
      {
        instanceId: session.id,
        imported,
        chats: chatCount,
        received: historyMessages.length,
        progress: event?.progress,
        isLatest: event?.isLatest,
      },
      'messaging history cached'
    );
  }

  async function listMessages(id, limit = HISTORY_LIMIT) {
    const session = sessions.get(id);
    if (!session) return null;
    const history = session.history || (await readHistory(id));
    session.history = history;
    return history.slice(-Math.min(Math.max(limit, 1), HISTORY_LIMIT));
  }

  async function listChats(id, { includeMessages = false, limit = 500 } = {}) {
    const history = await listMessages(id, HISTORY_LIMIT);
    if (!history) return null;
    const storedChats = sessions.get(id)?.chats || (await readChats(id));
    if (sessions.get(id)) sessions.get(id).chats = storedChats;
    const chats = new Map(storedChats.map((chat) => [chat.phone, { ...chat, messages: [] }]));
    for (const message of history) {
      const phone = message.chatPhone || digitsFromJid(message.chatJid);
      if (!phone) continue;
      const existing =
        chats.get(phone) ||
        {
          id: message.chatJid,
          chatId: message.chatJid,
          chatJid: message.chatJid,
          chatPhone: phone,
          phone,
          name: message.pushName || phone,
          lastMessageAt: message.timestamp,
          lastText: message.text || '',
          messages: [],
        };
      if (message.pushName) existing.name = message.pushName;
      existing.lastMessageAt = message.timestamp;
      existing.lastText =
        message.text || (message.hasMedia ? `[${message.media?.type || 'media'}]` : existing.lastText);
      if (includeMessages) existing.messages.push(message);
      chats.set(phone, existing);
    }
    return [...chats.values()]
      .map((chat) => ({
        ...chat,
        messages: includeMessages ? chat.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : undefined,
      }))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, Math.min(Math.max(limit, 1), 1_000));
  }

  async function runHistoryBackfill(session, id, candidates, perChat) {
    let requested = 0;
    let failed = 0;
    try {
      for (const chat of candidates) {
        try {
          await session.sock.fetchMessageHistory(perChat, chat.latestMessageKey, chat.latestMessageTimestamp);
          requested += 1;
          await sleep(250);
        } catch (err) {
          failed += 1;
          logger.warn(
            { instanceId: id, chatJid: chat.chatJid, err: err.message },
            'on-demand history request failed'
          );
        }
      }
      logger.info({ instanceId: id, requested, failed }, 'on-demand history finished');
    } finally {
      session.historySyncRunning = false;
    }
  }

  async function requestHistorySync(id, { count = BACKFILL_DEFAULT_COUNT } = {}) {
    const session = sessions.get(id);
    if (!session) return { ok: false, error: 'instance_not_found', code: 404 };
    if (session.status !== 'connected' || !session.sock?.fetchMessageHistory) {
      return { ok: false, error: 'instance_not_connected', code: 409 };
    }

    const perChat = Math.min(Math.max(Number(count) || BACKFILL_DEFAULT_COUNT, 1), 100);
    const storedChats = session.chats || (await readChats(id));
    session.chats = storedChats;
    const candidates = [...storedChats]
      .filter((chat) => chat?.latestMessageKey?.id && chat?.latestMessageTimestamp)
      .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)))
      .slice(0, BACKFILL_CHAT_LIMIT);

    let skipped = Math.max(storedChats.length - candidates.length, 0);
    if (candidates.length === 0) {
      logger.info({ instanceId: id, skipped }, 'on-demand history skipped: no message keys');
      return { ok: true, queued: false, requested: 0, skipped, failed: 0 };
    }
    if (session.historySyncRunning) {
      logger.info({ instanceId: id, candidates: candidates.length, skipped }, 'on-demand history already running');
      return { ok: true, queued: true, requested: 0, candidates: candidates.length, skipped, failed: 0 };
    }
    session.historySyncRunning = true;
    setTimeout(() => {
      runHistoryBackfill(session, id, candidates, perChat).catch((err) => {
        session.historySyncRunning = false;
        logger.error({ instanceId: id, err: err.message }, 'on-demand history worker crashed');
      });
    }, 0).unref();
    logger.info({ instanceId: id, candidates: candidates.length, skipped }, 'on-demand history queued');
    return { ok: true, queued: true, requested: 0, candidates: candidates.length, skipped, failed: 0 };
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
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30_000,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
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
    sock.ev.on('messaging-history.set', (event) => {
      handleHistorySet(session, event).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'history handler crashed')
      );
    });
    sock.ev.on('messaging-history.status', (event) => {
      logger.info({ instanceId: session.id, ...event }, 'messaging history status');
    });
    sock.ev.on('chats.upsert', (chats) => {
      mergeChats(session, chats).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'chat upsert handler crashed')
      );
    });
    sock.ev.on('chats.update', (chats) => {
      mergeChats(session, chats).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'chat update handler crashed')
      );
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      mergeContacts(session, contacts).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'contact upsert handler crashed')
      );
    });
    sock.ev.on('contacts.update', (contacts) => {
      mergeContacts(session, contacts).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'contact update handler crashed')
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
    const live = event.type === 'notify';
    for (const msg of event.messages || []) {
      try {
        const data = await dataFromMessage(session, msg);
        if (!data) continue;
        await appendHistory(session, data);
        if (live) emit(session, msg.key?.fromMe ? 'message.sent' : 'message', data);
        logger.debug({ instanceId: session.id, messageId: data.id }, 'message relayed');
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
      history: null,
      chats: null,
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
      await withTimeout(session.sock?.logout?.() ?? Promise.resolve(), LOGOUT_TIMEOUT_MS);
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
      const body = text.slice(0, 4000);
      const sent = await session.sock.sendMessage(jid, { text: body });
      session.lastSendAt = Date.now();
      await appendHistory(session, {
        id: sent?.key?.id || '',
        chatJid: jid,
        chatPhone: digitsFromJid(jid),
        sender: jid,
        senderPhone: digitsFromJid(jid),
        pushName: null,
        text: body,
        body,
        message: body,
        timestamp: new Date().toISOString(),
        isGroup: false,
        hasMedia: false,
        fromMe: true,
      });
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
    listMessages,
    listChats,
    requestHistorySync,
    send,
    shutdown,
  };
}
