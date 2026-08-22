import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JidIdentityDirectory,
  collectCachedLids,
  normalizeCachedChats,
  normalizeCachedHistory,
  rememberCachedIdentities,
} from '../src/identity.mjs';

test('normalizes device JIDs and persists LID-to-phone aliases', () => {
  const directory = new JidIdentityDirectory();
  assert.equal(directory.remember('777000:12@lid', '213555123456:12@s.whatsapp.net'), true);
  assert.equal(directory.resolve('777000@lid'), '213555123456@s.whatsapp.net');
  assert.equal(directory.phone('777000:4@lid'), '213555123456');

  const restored = new JidIdentityDirectory(JSON.parse(JSON.stringify(directory)));
  assert.equal(restored.phone('777000@hosted.lid'), '213555123456');
});

test('never exposes an unmapped LID as a phone number', () => {
  const directory = new JidIdentityDirectory();
  assert.equal(directory.resolve('987654321@lid'), '987654321@lid');
  assert.equal(directory.phone('987654321@lid'), '');
  const normalized = normalizeCachedChats(directory, [
    {
      id: '987654321@lid',
      chatJid: '987654321@lid',
      phone: '987654321',
      name: '987654321',
    },
  ]);
  assert.equal(normalized.chats[0].phone, '');
  assert.equal(normalized.chats[0].name, '');
});

test('learns aliases from history contacts and realtime message alt JIDs', () => {
  const directory = new JidIdentityDirectory();
  assert.equal(
    directory.rememberRecord({
      id: '111222@lid',
      lid: '111222@lid',
      phoneNumber: '213600000001@s.whatsapp.net',
    }),
    true
  );
  assert.equal(
    directory.rememberMessage({
      key: {
        remoteJid: '333444@lid',
        remoteJidAlt: '213600000002:7@s.whatsapp.net',
      },
    }),
    true
  );
  assert.equal(directory.phone('111222@lid'), '213600000001');
  assert.equal(directory.phone('333444@lid'), '213600000002');
});

test('rewrites and deduplicates cached chats without changing message IDs', () => {
  const directory = new JidIdentityDirectory({
    mappings: [{ lid: '555666@lid', pn: '213700000003@s.whatsapp.net' }],
  });
  const history = normalizeCachedHistory(directory, [
    {
      id: 'message-1',
      chatJid: '555666@lid',
      chatPhone: '555666',
      sender: '555666@lid',
      senderPhone: '555666',
      text: 'hello',
    },
  ]);
  assert.equal(history.changed, true);
  assert.equal(history.messages[0].id, 'message-1');
  assert.equal(history.messages[0].chatJid, '213700000003@s.whatsapp.net');
  assert.equal(history.messages[0].chatPhone, '213700000003');
  assert.equal(history.messages[0].sourceChatJid, '555666@lid');

  const chats = normalizeCachedChats(directory, [
    {
      id: '555666@lid',
      chatJid: '555666@lid',
      phone: '555666',
      name: '555666',
      lastMessageAt: '2026-08-20T00:00:00.000Z',
      lastText: 'old',
    },
    {
      id: '213700000003@s.whatsapp.net',
      chatJid: '213700000003@s.whatsapp.net',
      phone: '213700000003',
      name: 'Customer',
      lastMessageAt: '2026-08-21T00:00:00.000Z',
      lastText: 'new',
    },
  ]);
  assert.equal(chats.chats.length, 1);
  assert.equal(chats.chats[0].phone, '213700000003');
  assert.equal(chats.chats[0].name, 'Customer');
  assert.equal(chats.chats[0].lastText, 'new');
});

test('collects unresolved cached LIDs for Baileys reverse lookup', () => {
  assert.deepEqual(
    collectCachedLids(
      [{ chatJid: '101010@lid' }],
      [{ sourceChatJid: '202020@lid', sender: '303030@lid' }]
    ).sort(),
    ['101010@lid', '202020@lid', '303030@lid']
  );
});

test('seeds aliases from previously normalized cache rows', () => {
  const directory = new JidIdentityDirectory();
  const history = [
    {
      sourceChatJid: '404040@lid',
      chatJid: '213700000004@s.whatsapp.net',
      sourceSenderJid: '404040@lid',
      sender: '213700000004@s.whatsapp.net',
    },
  ];
  assert.equal(rememberCachedIdentities(directory, [], history), true);
  assert.equal(directory.phone('404040@lid'), '213700000004');
  const normalized = normalizeCachedHistory(directory, history);
  assert.equal(normalized.messages[0].chatJid, '213700000004@s.whatsapp.net');
});
