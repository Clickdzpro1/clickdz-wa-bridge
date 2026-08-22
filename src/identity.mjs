import {
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

const PHONE_SERVER = '@s.whatsapp.net';

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function digits(value) {
  return stringValue(value).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

export function isLidIdentityJid(jid) {
  return isLidUser(jid) || isHostedLidUser(jid);
}

export function isPhoneIdentityJid(jid) {
  return isPnUser(jid) || isHostedPnUser(jid);
}

export function normalizeIdentityJid(jid) {
  const value = stringValue(jid);
  if (!value) return '';
  const normalized = jidNormalizedUser(value);
  return normalized || value;
}

function canonicalPhoneJid(value) {
  const raw = stringValue(value);
  if (!raw) return '';
  if (raw.includes('@') && !isPhoneIdentityJid(raw)) return '';
  const phone = digits(raw);
  return phone ? `${phone}${PHONE_SERVER}` : '';
}

function canonicalLidJid(value) {
  const normalized = normalizeIdentityJid(value);
  return isLidIdentityJid(normalized) ? normalized : '';
}

function mappingPair(first, second) {
  let lid = canonicalLidJid(first);
  let pn = canonicalPhoneJid(second);
  if (!lid || !pn) {
    lid = canonicalLidJid(second);
    pn = canonicalPhoneJid(first);
  }
  return lid && pn ? { lid, pn } : null;
}

function lidSource(row) {
  for (const value of [row?.sourceChatJid, row?.chatJid, row?.chatId, row?.id]) {
    const normalized = normalizeIdentityJid(value);
    if (isLidIdentityJid(normalized)) return normalized;
  }
  return '';
}

function preferredName(next, current, phone) {
  const candidate = stringValue(next);
  if (candidate && candidate !== phone && !/^\+?\d+$/.test(candidate)) return candidate;
  const existing = stringValue(current);
  if (existing && existing !== phone && !/^\+?\d+$/.test(existing)) return existing;
  return phone;
}

export class JidIdentityDirectory {
  constructor(payload) {
    this.byLid = new Map();
    this.byLidUser = new Map();
    this.revision = 0;
    const mappings = Array.isArray(payload?.mappings)
      ? payload.mappings
      : Object.entries(payload?.mappings || {}).map(([lid, pn]) => ({ lid, pn }));
    for (const item of mappings) this.remember(item?.lid, item?.pn);
    this.revision = 0;
  }

  remember(first, second) {
    const pair = mappingPair(first, second);
    if (!pair) return false;
    const current = this.byLid.get(pair.lid);
    if (current === pair.pn) return false;
    this.byLid.set(pair.lid, pair.pn);
    this.byLidUser.set(digits(pair.lid), pair.pn);
    this.revision += 1;
    return true;
  }

  rememberRecord(record) {
    if (!record || typeof record !== 'object') return false;
    const identifiers = [record.id, record.jid, record.remoteJid, record.chatJid];
    const lids = [record.lid, record.lidJid, record.accountLid];
    const phones = [record.phoneNumber, record.pnJid];
    for (const value of identifiers) {
      if (isLidIdentityJid(normalizeIdentityJid(value))) lids.push(value);
      if (isPhoneIdentityJid(normalizeIdentityJid(value))) phones.push(value);
    }
    let changed = false;
    for (const lid of lids) {
      for (const pn of phones) changed = this.remember(lid, pn) || changed;
    }
    return changed;
  }

  rememberMessage(message) {
    const key = message?.key || {};
    let changed = false;
    changed = this.remember(key.remoteJid, key.remoteJidAlt) || changed;
    changed = this.remember(key.participant, key.participantAlt) || changed;
    changed = this.remember(key.remoteJid, key.participantAlt) || changed;
    return changed;
  }

  resolve(jid) {
    const normalized = normalizeIdentityJid(jid);
    if (!normalized) return '';
    if (isPhoneIdentityJid(normalized)) return canonicalPhoneJid(normalized);
    if (!isLidIdentityJid(normalized)) return normalized;
    return this.byLid.get(normalized) || this.byLidUser.get(digits(normalized)) || normalized;
  }

  phone(jid) {
    const resolved = this.resolve(jid);
    return isPhoneIdentityJid(resolved) ? digits(resolved) : '';
  }

  has(jid) {
    return Boolean(this.phone(jid));
  }

  entries() {
    return [...this.byLid.entries()]
      .map(([lid, pn]) => ({ lid, pn }))
      .sort((a, b) => a.lid.localeCompare(b.lid));
  }

  toJSON() {
    return { version: 1, mappings: this.entries() };
  }
}

export function collectCachedLids(chats, history) {
  const lids = new Set();
  for (const row of [...(chats || []), ...(history || [])]) {
    for (const value of [
      row?.sourceChatJid,
      row?.chatJid,
      row?.chatId,
      row?.id,
      row?.sourceSenderJid,
      row?.sender,
    ]) {
      const normalized = normalizeIdentityJid(value);
      if (isLidIdentityJid(normalized)) lids.add(normalized);
    }
  }
  return [...lids];
}

export function rememberCachedIdentities(directory, chats, history) {
  let changed = false;
  for (const row of [...(chats || []), ...(history || [])]) {
    changed =
      directory.remember(row?.sourceChatJid, row?.chatJid || row?.chatId || row?.id) || changed;
    changed = directory.remember(row?.sourceSenderJid, row?.sender) || changed;
  }
  return changed;
}

export function normalizeCachedHistory(directory, history) {
  let changed = false;
  const messages = (history || []).map((message) => {
    const sourceChat = lidSource(message);
    const chatJid = directory.resolve(sourceChat || message.chatJid);
    const chatPhone = directory.phone(sourceChat || message.chatJid);
    const sourceSender = isLidIdentityJid(normalizeIdentityJid(message.sourceSenderJid))
      ? normalizeIdentityJid(message.sourceSenderJid)
      : isLidIdentityJid(normalizeIdentityJid(message.sender))
        ? normalizeIdentityJid(message.sender)
        : '';
    const sender = directory.resolve(sourceSender || message.sender);
    const senderPhone = directory.phone(sourceSender || message.sender);
    const next = {
      ...message,
      ...(sourceChat ? { sourceChatJid: sourceChat } : {}),
      ...(chatJid ? { chatJid } : {}),
      chatPhone,
      ...(sourceSender ? { sourceSenderJid: sourceSender } : {}),
      ...(sender ? { sender } : {}),
      senderPhone,
    };
    if (
      next.chatJid !== message.chatJid ||
      next.chatPhone !== message.chatPhone ||
      next.sender !== message.sender ||
      next.senderPhone !== message.senderPhone ||
      next.sourceChatJid !== message.sourceChatJid ||
      next.sourceSenderJid !== message.sourceSenderJid
    ) {
      changed = true;
    }
    return next;
  });
  return { changed, messages };
}

export function normalizeCachedChats(directory, chats) {
  let changed = false;
  const byIdentity = new Map();
  for (const chat of chats || []) {
    const sourceChat = lidSource(chat);
    const chatJid = directory.resolve(sourceChat || chat.chatJid || chat.id);
    const phone = directory.phone(sourceChat || chat.chatJid || chat.id);
    const key = phone || chatJid || sourceChat;
    if (!key) continue;
    const next = {
      ...chat,
      id: chatJid,
      chatId: chatJid,
      chatJid,
      ...(sourceChat ? { sourceChatJid: sourceChat } : {}),
      chatPhone: phone,
      phone,
      name: preferredName(chat.name, undefined, phone),
    };
    const current = byIdentity.get(key);
    if (current) {
      changed = true;
      byIdentity.set(key, {
        ...current,
        ...next,
        name: preferredName(next.name, current.name, phone),
        lastMessageAt:
          String(current.lastMessageAt || '') > String(next.lastMessageAt || '')
            ? current.lastMessageAt
            : next.lastMessageAt,
        lastText:
          String(current.lastMessageAt || '') > String(next.lastMessageAt || '')
            ? current.lastText
            : next.lastText,
      });
    } else {
      byIdentity.set(key, next);
    }
    if (
      next.id !== chat.id ||
      next.chatId !== chat.chatId ||
      next.chatJid !== chat.chatJid ||
      next.chatPhone !== chat.chatPhone ||
      next.phone !== chat.phone ||
      next.name !== chat.name ||
      next.sourceChatJid !== chat.sourceChatJid
    ) {
      changed = true;
    }
  }
  return { changed, chats: [...byIdentity.values()] };
}
