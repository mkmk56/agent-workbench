import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, makeServices, uploadBuffer } from './helpers.js';

test('archive hides a chat from the default list but keeps messages and files', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const active = chats.create({ name: 'Active' });
    const archived = chats.create({ name: 'Archived' });
    const sent = chats.send({
      chat_id: archived.chat_id, from: 'user', to: 'muse', body: 'keep me'
    });
    const meta = uploadBuffer(files, archived.chat_id, 'keep.txt', Buffer.from('attachment'));
    chats.send({
      chat_id: archived.chat_id, from: 'user', to: 'muse', body: 'with file', files: [meta.file_id]
    });

    const result = chats.archive({ chat_id: archived.chat_id, archived: true });
    assert.equal(result.status, 'archived');

    const defaultList = chats.list().chats.map((chat) => chat.chat_id);
    assert.deepEqual(defaultList, [active.chat_id]);

    const withArchived = chats.list({ include_archived: true }).chats;
    assert.equal(withArchived.length, 2);
    assert.equal(withArchived[0].chat_id, active.chat_id, 'active chats come first');
    assert.equal(withArchived[1].chat_id, archived.chat_id);
    assert.equal(withArchived[1].status, 'archived');

    const archivedOnly = chats.list({ status: 'archived' }).chats;
    assert.deepEqual(archivedOnly.map((chat) => chat.chat_id), [archived.chat_id]);

    // Archiving is not deletion: the message, the file and the epoch survive.
    assert.equal(store.getMessage(sent.message_id).body, 'keep me');
    assert.equal(store.listChatMessages({ chatId: archived.chat_id }).length, 2);
    assert.equal(store.listChatFiles(archived.chat_id).length, 1);
    assert.equal(files.readFile({
      chat_id: archived.chat_id, file_id: meta.file_id, actor: { master: true }
    }).text, 'attachment');
    assert.ok(store.chatEpoch(archived.chat_id) >= 2);

    const restored = chats.archive({ chat_id: archived.chat_id, archived: false });
    assert.equal(restored.status, 'active');
    assert.equal(chats.list().chats.length, 2);
  } finally {
    store.close();
  }
});

test('an agent token still only sees chats it participates in when archived chats are included', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir);
  try {
    const joined = chats.create({ name: 'Joined' });
    const other = chats.create({ name: 'Other' });
    store.upsertChatParticipant({
      chat_id: joined.chat_id, participant_id: 'claude', kind: 'agent', role: 'claude'
    });
    chats.archive({ chat_id: joined.chat_id, archived: true });
    chats.archive({ chat_id: other.chat_id, archived: true });
    const visible = chats.list({
      include_archived: true,
      chat_ids: store.listParticipantChatIds('claude')
    }).chats.map((chat) => chat.chat_id);
    assert.deepEqual(visible, [joined.chat_id]);
  } finally {
    store.close();
  }
});