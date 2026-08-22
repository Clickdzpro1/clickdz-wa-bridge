import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  normalizeMessageContent,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import QRCode from 'qrcode';
import { makeAuthState } from './authState.mjs';
import {
  JidIdentityDirectory,
  collectCachedLids,
  isLidIdentityJid,
  normalizeCachedChats,
  normalizeCachedHistory,
  normalizeIdentityJid,
  rememberCachedIdentities,
} from './identity.mjs';

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;
const HISTORY_LIMIT = 10_000;
const CHAT_LIMIT = 1_000;
const LOGOUT_TIMEOUT_MS = 3_000;
const S_WHATSAPP_NET = '@s.whatsapp.net';
const BACKFILL_CHAT_LIMIT = 40;
const BACKFILL_DEFAULT_COUNT = 50;

function isIndividualJid(jid) {
  return Boolean(
    typeof jid === 'string' &&
      (isPnUser(jid) ||
        isHostedPnUser(jid) ||
        isLidUser(jid) ||
        isHostedLidUser(jid) ||
        jid.endsWith(S_WHATSAPP_NET))
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
    ...(msg.key.remoteJidAlt ? { remoteJidAlt: msg.key.remoteJidAlt } : {}),
    ...(msg.key.participantAlt ? { participantAlt: msg.key.participantAlt } : {}),
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
    if (!session?.identities) return false;
    const changed = session.identities.remember(lid, pn);
    if (changed) session.identityDirty = true;
    return changed;
  }

  function rememberMappingsFromHistory(session, event) {
    let changed = false;
    for (const item of event?.lidPnMappings || []) {
      changed = rememberJidMapping(session, item?.lid, item?.pn) || changed;
    }
    for (const item of [...(event?.contacts || []), ...(event?.chats || [])]) {
      const learned = session.identities.rememberRecord(item);
      changed = learned || changed;
      if (learned) session.identityDirty = true;
    }
    for (const message of historyMessagesFromEvent(event)) {
      const learned = session.identities.rememberMessage(message);
      changed = learned || changed;
      if (learned) session.identityDirty = true;
    }
    return changed;
  }

  function resolveChatJid(session, jid) {
    return session?.identities?.resolve(jid) || normalizeIdentityJid(jid);
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

  function queueHistoryAvailable(session, data) {
    const current = session.historyWebhookStats || {
      received: 0,
      imported: 0,
      chats: 0,
      progress: undefined,
      isLatest: false,
    };
    session.historyWebhookStats = {
      received: current.received + Number(data.received || 0),
      imported: current.imported + Number(data.imported || 0),
      chats: current.chats + Number(data.chats || 0),
      progress: data.progress ?? current.progress,
      isLatest: Boolean(current.isLatest || data.isLatest),
    };
    if (session.historyWebhookTimer) return;
    session.historyWebhookTimer = setTimeout(() => {
      session.historyWebhookTimer = null;
      const payload = session.historyWebhookStats;
      session.historyWebhookStats = null;
      if (!session.deleted && payload) emit(session, 'history.available', payload);
    }, 4_000);
    session.historyWebhookTimer.unref();
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

  function identitiesKey(instanceId) {
    return `${config.authStatePrefix}:identities:${instanceId}`;
  }

  function identitiesDiskPath(instanceId) {
    return join(config.authDiskDir, 'identities', `${safeSegment(instanceId)}.json`);
  }

  async function readIdentities(instanceId) {
    try {
      const raw =
        config.authStore === 'redis'
          ? await redis.get(identitiesKey(instanceId))
          : await readFile(identitiesDiskPath(instanceId), 'utf8').catch((err) => {
              if (err.code === 'ENOENT') return null;
              throw err;
            });
      return new JidIdentityDirectory(raw ? JSON.parse(raw) : undefined);
    } catch (err) {
      logger.warn({ instanceId, err: err.message }, 'identity map read failed');
      return new JidIdentityDirectory();
    }
  }

  async function writeIdentities(instanceId, directory) {
    const body = JSON.stringify(directory.toJSON());
    if (config.authStore === 'redis') {
      await redis.set(identitiesKey(instanceId), body);
      return;
    }
    await mkdir(join(config.authDiskDir, 'identities'), { recursive: true });
    await atomicWrite(identitiesDiskPath(instanceId), body);
  }

  async function deleteIdentities(instanceId) {
    if (config.authStore === 'redis') {
      await redis.del(identitiesKey(instanceId));
      return;
    }
    await rm(identitiesDiskPath(instanceId), { force: true });
  }

  async function flushIdentities(session) {
    if (!session?.identityDirty) return;
    const revision = session.identities.revision;
    const snapshot = new JidIdentityDirectory(session.identities.toJSON());
    const previous = session.identityWrite || Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => writeIdentities(session.id, snapshot));
    session.identityWrite = pending;
    await pending;
    if (session.identities.revision === revision) {
      session.identityDirty = false;
      return;
    }
    await flushIdentities(session);
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
      let value;
      try {
        value = JSON.parse(raw);
      } catch (parseError) {
        value = JSON.parse(jsonrepair(raw));
        logger.warn({ instanceId, err: parseError.message }, 'repaired truncated history cache');
        if (Array.isArray(value)) await writeHistory(instanceId, value);
      }
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
    await atomicWrite(historyDiskPath(instanceId), body);
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
      let value;
      try {
        value = JSON.parse(raw);
      } catch (parseError) {
        value = JSON.parse(jsonrepair(raw));
        logger.warn({ instanceId, err: parseError.message }, 'repaired truncated chat cache');
        if (Array.isArray(value)) await writeChats(instanceId, value);
      }
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
    await atomicWrite(chatsDiskPath(instanceId), body);
  }

  async function atomicWrite(path, body) {
    const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async function reconcileIdentityCaches(session) {
    const [history, chats] = await Promise.all([
      session.history || readHistory(session.id),
      session.chats || readChats(session.id),
    ]);
    if (rememberCachedIdentities(session.identities, chats, history)) {
      session.identityDirty = true;
    }
    const normalizedHistory = normalizeCachedHistory(session.identities, history);
    const normalizedChats = normalizeCachedChats(session.identities, chats);
    session.history = normalizedHistory.messages;
    session.chats = normalizedChats.chats;
    await Promise.all([
      normalizedHistory.changed ? writeHistory(session.id, normalizedHistory.messages) : undefined,
      normalizedChats.changed ? writeChats(session.id, normalizedChats.chats) : undefined,
      flushIdentities(session),
    ]);
    return normalizedHistory.changed || normalizedChats.changed;
  }

  async function ensureJidIdentity(session, jid, alternateJid) {
    if (!session?.identities) return { jid: normalizeIdentityJid(jid), phone: '' };
    if (session.identities.remember(jid, alternateJid)) session.identityDirty = true;
    let resolved = session.identities.resolve(jid);
    let phone = session.identities.phone(jid);
    const normalized = normalizeIdentityJid(jid);
    if (!phone && isLidIdentityJid(normalized)) {
      try {
        const pn = await session.sock?.signalRepository?.lidMapping?.getPNForLID(normalized);
        if (pn && rememberJidMapping(session, normalized, pn)) {
          resolved = session.identities.resolve(normalized);
          phone = session.identities.phone(normalized);
        }
      } catch (err) {
        logger.debug({ instanceId: session.id, err: err.message }, 'LID reverse lookup missed');
      }
    }
    return { jid: resolved, phone };
  }

  async function hydrateIdentityMappings(session) {
    if (!session?.sock?.signalRepository?.lidMapping) return 0;
    const [history, chats] = await Promise.all([
      session.history || readHistory(session.id),
      session.chats || readChats(session.id),
    ]);
    session.history = history;
    session.chats = chats;
    if (rememberCachedIdentities(session.identities, chats, history)) {
      session.identityDirty = true;
      await flushIdentities(session);
    }
    const lids = collectCachedLids(chats, history).filter((jid) => !session.identities.has(jid));
    let learned = 0;
    for (let index = 0; index < lids.length; index += 200) {
      const pairs = await session.sock.signalRepository.lidMapping.getPNsForLIDs(
        lids.slice(index, index + 200)
      );
      for (const pair of pairs || []) {
        if (rememberJidMapping(session, pair?.lid, pair?.pn)) learned += 1;
      }
    }
    if (learned > 0) {
      await flushIdentities(session);
      await reconcileIdentityCaches(session);
      logger.info({ instanceId: session.id, learned }, 'persisted LID identities hydrated');
    }
    return learned;
  }

  async function archivedInstanceIds() {
    const ids = new Set();
    if (config.authStore === 'redis') {
      const prefixes = [
        `${config.authStatePrefix}:history:`,
        `${config.authStatePrefix}:chats:`,
      ];
      for (const prefix of prefixes) {
        const keys = await redis.scanAll(`${prefix}*`);
        for (const key of keys) {
          const id = key.slice(prefix.length);
          if (id) ids.add(id);
        }
      }
    } else {
      for (const kind of ['history', 'chats']) {
        const files = await readdir(join(config.authDiskDir, kind)).catch((err) => {
          if (err.code === 'ENOENT') return [];
          throw err;
        });
        for (const file of files) {
          if (file.endsWith('.json')) ids.add(file.slice(0, -5));
        }
      }
    }
    return ids;
  }

  async function listArchives() {
    const ids = await archivedInstanceIds();
    const archives = [];
    for (const id of ids) {
      if (sessions.has(id)) continue;
      const [history, chats] = await Promise.all([readHistory(id), readChats(id)]);
      archives.push({ id, chats: chats.length, messages: history.length });
    }
    return archives.sort((a, b) => b.messages - a.messages || b.chats - a.chats);
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

  async function chatRecordFromWa(session, chat) {
    const id = chat?.id || chat?.jid || chat?.remoteJid || '';
    if (session.identities.rememberRecord(chat)) session.identityDirty = true;
    if (!isIndividualJid(id)) return null;
    const identity = await ensureJidIdentity(
      session,
      id,
      chat?.pnJid || chat?.phoneNumber || chat?.lidJid || chat?.accountLid
    );
    const resolvedId = identity.jid;
    const phone = identity.phone;
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
      const next = await chatRecordFromWa(session, row);
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
    await Promise.all([writeChats(session.id, sorted), flushIdentities(session)]);
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
      if (session.identities.rememberRecord(row)) session.identityDirty = true;
      if (!isIndividualJid(id)) continue;
      const identity = await ensureJidIdentity(
        session,
        id,
        row?.pnJid || row?.phoneNumber || row?.lid || row?.lidJid || row?.accountLid
      );
      const resolvedId = identity.jid;
      const phone = identity.phone;
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
    if (changed === 0) {
      await flushIdentities(session);
      return 0;
    }
    const sorted = [...byPhone.values()]
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, CHAT_LIMIT);
    session.chats = sorted;
    await Promise.all([writeChats(session.id, sorted), flushIdentities(session)]);
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
    if (session.identities.rememberMessage(msg)) session.identityDirty = true;
    const chatIdentity = await ensureJidIdentity(session, remoteJid, msg.key?.remoteJidAlt);
    const resolvedJid = chatIdentity.jid;
    const chatPhone = chatIdentity.phone;
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
    const rawSender = msg.key?.participant || remoteJid;
    const alternateSender = msg.key?.participantAlt || msg.key?.remoteJidAlt;
    const senderIdentity = await ensureJidIdentity(session, rawSender, alternateSender);
    return {
      id: messageId,
      chatJid: resolvedJid,
      ...(resolvedJid !== remoteJid ? { sourceChatJid: remoteJid } : {}),
      chatPhone,
      sender: senderIdentity.jid,
      ...(senderIdentity.jid !== rawSender ? { sourceSenderJid: rawSender } : {}),
      senderPhone: senderIdentity.phone,
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
    await flushIdentities(session);
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
    await flushIdentities(session);
    await reconcileIdentityCaches(session);
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
    if (historyMessages.length > 0 || chatCount > 0) {
      queueHistoryAvailable(session, {
        received: historyMessages.length,
        imported,
        chats: chatCount,
        progress: event?.progress,
        isLatest: event?.isLatest,
      });
    }
  }

  async function listMessages(id, limit = HISTORY_LIMIT) {
    const session = sessions.get(id);
    if (!session && !(await archivedInstanceIds()).has(id)) return null;
    const history = session?.history || (await readHistory(id));
    const directory = session?.identities || (await readIdentities(id));
    if (rememberCachedIdentities(directory, [], history)) {
      if (session) {
        session.identityDirty = true;
        await flushIdentities(session);
      } else {
        await writeIdentities(id, directory);
      }
    }
    const normalized = normalizeCachedHistory(directory, history);
    if (session) session.history = normalized.messages;
    if (normalized.changed) await writeHistory(id, normalized.messages);
    return normalized.messages.slice(-Math.min(Math.max(limit, 1), HISTORY_LIMIT));
  }

  function historyCursorKey(message) {
    return `${String(message.timestamp || '')}\u0000${historyDedupKey(message)}`;
  }

  function encodeHistoryCursor(key) {
    return Buffer.from(key, 'utf8').toString('base64url');
  }

  function decodeHistoryCursor(value) {
    if (!value) return null;
    try {
      const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
      return decoded.includes('\u0000') ? decoded : null;
    } catch {
      return null;
    }
  }

  async function listHistoryPage(id, { cursor, limit = 150 } = {}) {
    const history = await listMessages(id, HISTORY_LIMIT);
    if (!history) return null;
    const before = decodeHistoryCursor(cursor);
    const eligible = history
      .filter((message) => !before || historyCursorKey(message) < before)
      .sort((a, b) => historyCursorKey(b).localeCompare(historyCursorKey(a)));
    const pageSize = Math.min(Math.max(Number(limit) || 150, 1), 300);
    const messages = eligible.slice(0, pageSize);
    const hasMore = eligible.length > messages.length;
    return {
      messages,
      nextCursor: hasMore && messages.length > 0
        ? encodeHistoryCursor(historyCursorKey(messages.at(-1)))
        : null,
      hasMore,
      total: history.length,
    };
  }

  async function listChats(id, { includeMessages = false, limit = 500 } = {}) {
    const history = await listMessages(id, HISTORY_LIMIT);
    if (!history) return null;
    const session = sessions.get(id);
    const directory = session?.identities || (await readIdentities(id));
    const storedChats = session?.chats || (await readChats(id));
    if (rememberCachedIdentities(directory, storedChats, history)) {
      if (session) {
        session.identityDirty = true;
        await flushIdentities(session);
      } else {
        await writeIdentities(id, directory);
      }
    }
    const normalizedChats = normalizeCachedChats(directory, storedChats);
    if (session) session.chats = normalizedChats.chats;
    if (normalizedChats.changed) await writeChats(id, normalizedChats.chats);
    const chats = new Map(
      normalizedChats.chats
        .filter((chat) => chat.phone)
        .map((chat) => [chat.phone, { ...chat, messages: [] }])
    );
    for (const message of history) {
      const phone =
        message.chatPhone || directory.phone(message.sourceChatJid || message.chatJid);
      if (!phone) continue;
      const chatJid = directory.resolve(message.sourceChatJid || message.chatJid);
      const existing =
        chats.get(phone) ||
        {
          id: chatJid,
          chatId: chatJid,
          chatJid,
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
      .filter((chat) =>
        Boolean(
          chat.lastText ||
          chat.latestMessageKey?.id ||
          (chat.messages && chat.messages.length > 0) ||
          (chat.lastMessageAt && chat.lastMessageAt > new Date(0).toISOString())
        )
      )
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

  async function handleLidMappingUpdate(session, mapping) {
    if (!rememberJidMapping(session, mapping?.lid, mapping?.pn)) return;
    await flushIdentities(session);
    await reconcileIdentityCaches(session);
  }

  function scheduleIdentityHydration(session) {
    if (session.deleted || session.identityHydration) return;
    session.identityHydration = hydrateIdentityMappings(session)
      .catch((err) =>
        logger.warn({ instanceId: session.id, err: err.message }, 'identity hydration failed')
      )
      .finally(() => {
        session.identityHydration = null;
      });
  }

  async function startSocket(session) {
    const auth = await makeAuthState({ config, redis, accountId: session.id, logger });
    session.auth = auth;
    if (session.identities.rememberRecord(auth.state.creds.me)) session.identityDirty = true;
    await flushIdentities(session);
    const isNewPairing = !auth.state.creds.registered;
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
      // New registrations require the stable Chrome identity or WhatsApp closes
      // before emitting a QR. Once paired, reconnect as Desktop so WhatsApp
      // supplies the larger companion-device history payload.
      browser: isNewPairing ? Browsers.macOS('Chrome') : Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30_000,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      getMessage: async () => undefined,
    });
    session.socketMode = isNewPairing ? 'pairing' : 'history';
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
    sock.ev.on('lid-mapping.update', (mapping) => {
      handleLidMappingUpdate(session, mapping).catch((err) =>
        logger.error({ instanceId: session.id, err: err.message }, 'LID mapping handler crashed')
      );
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
    scheduleIdentityHydration(session);
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
      if (session.identities.rememberRecord(session.sock?.user || session.auth?.state?.creds?.me)) {
        session.identityDirty = true;
        await flushIdentities(session);
      }
      session.phone = digitsFromJid(meId);
      setStatus(session, 'connected');
      emit(session, 'instance.ready', {
        phoneNumber: session.phone ? `+${session.phone}` : null,
      });
      scheduleIdentityHydration(session);
      if (session.socketMode === 'pairing' && !session.historyReconnectTimer) {
        const pairingSocket = session.sock;
        session.historyReconnectTimer = setTimeout(() => {
          session.historyReconnectTimer = null;
          if (
            session.deleted ||
            session.sock !== pairingSocket ||
            !session.auth?.state?.creds?.registered
          )
            return;
          logger.info({ instanceId: session.id }, 'reconnecting with desktop identity for full history');
          pairingSocket.end(new Error('switch_to_desktop_history'));
        }, 2_000);
      }
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
    const identityRevision = session.identities.revision;
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
    if (session.identityDirty || session.identities.revision !== identityRevision) {
      await flushIdentities(session);
      await reconcileIdentityCaches(session);
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
    const identities = await readIdentities(id);
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
      historyReconnectTimer: null,
      historyWebhookTimer: null,
      historyWebhookStats: null,
      socketMode: 'pairing',
      deleted: false,
      lastSendAt: 0,
      history: null,
      chats: null,
      identities,
      identityDirty: false,
      identityWrite: null,
      identityHydration: null,
    };
    sessions.set(id, session);
    if (options.persist !== false) await persistRegistry();
    await reconcileIdentityCaches(session);
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
    if (session.historyReconnectTimer) clearTimeout(session.historyReconnectTimer);
    if (session.historyWebhookTimer) clearTimeout(session.historyWebhookTimer);
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
    try {
      await deleteIdentities(id);
    } catch (err) {
      logger.warn({ instanceId: id, err: err.message }, 'identity map delete failed');
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
      if (session.historyReconnectTimer) clearTimeout(session.historyReconnectTimer);
      if (session.historyWebhookTimer) clearTimeout(session.historyWebhookTimer);
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
    listHistoryPage,
    listChats,
    requestHistorySync,
    listArchives,
    send,
    shutdown,
  };
}
