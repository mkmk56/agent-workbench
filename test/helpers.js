import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { MessageService } from '../src/messages.js';
import { ChatService } from '../src/chats.js';
import { FileService } from '../src/files.js';
import { deriveAgentTokens, deriveHumanToken, deriveMuseToken } from '../src/auth.js';

export const TEST_MASTER_TOKEN = 'test-master-token-0123456789abcdef0123456789';

// Legacy master (one version): a human principal that may post only as user.
export const authMaster = {
  role: 'master', master: true, participant: 'user', principal_id: 'user', token_kind: 'master',
  can_post_as: ['user'], can_dispatch: false, can_operate: true, deprecated: true
};
export const authHuman = {
  role: 'human', master: false, participant: 'user', principal_id: 'user', token_kind: 'human',
  can_post_as: ['user'], can_dispatch: false, can_operate: false, deprecated: false
};
export const authMuse = {
  role: 'muse', master: false, participant: 'muse', principal_id: 'muse', token_kind: 'muse',
  can_post_as: ['muse'], can_dispatch: true, can_operate: false, deprecated: false
};
export const authClaude = {
  role: 'agent', master: false, participant: 'claude', principal_id: 'claude', token_kind: 'agent',
  can_post_as: ['claude'], can_dispatch: false, can_operate: false, deprecated: true
};
export const authDsh = {
  role: 'agent', master: false, participant: 'dsh', principal_id: 'dsh', token_kind: 'agent',
  can_post_as: ['dsh'], can_dispatch: false, can_operate: false, deprecated: true
};

export function tempDir(prefix = 'agent-workbench-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeConfig(dir, overrides = {}) {
  return {
    dataDir: dir,
    dbPath: join(dir, 'workbench.db'),
    root: process.cwd(),
    chatFilesDir: join(dir, 'chat-files'),
    token: TEST_MASTER_TOKEN,
    humanToken: deriveHumanToken(TEST_MASTER_TOKEN),
    museToken: deriveMuseToken(TEST_MASTER_TOKEN),
    agentTokens: deriveAgentTokens(TEST_MASTER_TOKEN),
    legacyMasterEnabled: true,
    legacyAgentTokensEnabled: true,
    humanCanOperate: false,
    museRequireHeartbeat: false,
    museLeaseTtlMs: 300000,
    agentTokenTtlMs: 2 * 60 * 60 * 1000,
    executorWorkspace: dir,
    credentialDir: join(dir, 'credentials'),
    taskConfigDir: join(dir, 'task-configs'),
    mcpUrl: 'http://127.0.0.1:1/mcp',
    agentMessageLimit: 10,
    agentSummaryMaxTokens: 500,
    agentAutoDeliver: false,
    agentApprovalGate: false,
    approvalTimeoutMs: 2000,
    chatContextTokenBudget: 6000,
    chatContextMessageLimit: 30,
    chatEpochAgentBudget: 20,
    chatMaxDepth: 16,
    chatBodyMaxChars: 100000,
    chatMaxFileBytes: 20 * 1024 * 1024,
    chatUploadChunkBytes: 1024 * 1024,
    chatReadMaxBytes: 200000,
    chatTerminalStatusTtlMs: 60000,
    chatZipMaxFiles: 200,
    chatZipMaxDepth: 5,
    chatZipMaxTotalBytes: 50 * 1024 * 1024,
    chatZipMaxEntryBytes: 10 * 1024 * 1024,
    executorVision: { claude: true, dsh: false },
    ...overrides
  };
}

export class StubScheduler {
  constructor() {
    this.calls = [];
    this.messages = null;
    this.approvals = null;
  }

  createTask(input) {
    this.calls.push(input);
    return {
      task_id: `task-${this.calls.length}`,
      session_id: `session-${this.calls.length}`,
      status: 'PENDING'
    };
  }

  statusPayload(task) {
    return { task_id: task.id, agent: task.agent, state: task.state };
  }
}

// Compatibility alias used by the message-flow tests.
export class FakeScheduler extends StubScheduler {
  get created() {
    return this.calls;
  }
}

export function seedChat(store, { id = randomUUID(), name = 'test chat', epoch = 0 } = {}) {
  const now = new Date().toISOString();
  store.insertChat({ chat_id: id, name, created_at: now, updated_at: now, status: 'active', epoch });
  store.upsertChatParticipant({
    chat_id: id, participant_id: 'user', kind: 'human', role: 'user', display_name: 'User'
  });
  store.upsertChatParticipant({
    chat_id: id, participant_id: 'muse', kind: 'orchestrator', role: 'muse', display_name: 'Muse'
  });
  return id;
}

export function makeServices(dir, { config: configOverrides = {}, scheduler = new StubScheduler() } = {}) {
  const config = makeConfig(dir, configOverrides);
  const store = new Store(join(dir, 'workbench.db'), dir);
  const files = new FileService({ store, config });
  const messages = new MessageService({ store, scheduler, config, files });
  const chats = new ChatService({ store, messages, config });
  return { config, store, files, messages, chats, scheduler };
}

export function seedTask(store, {
  id = randomUUID(), agent, chatId = null, cwd = process.cwd(), state = 'COMPLETED', updatedAt = null
}) {
  const now = updatedAt || new Date().toISOString();
  const processState = state === 'COMPLETED'
    ? 'exited_success'
    : state === 'FAILED'
      ? 'exited_failure'
      : state === 'CANCELLED'
        ? 'cancelled'
        : 'created';
  store.insertTask({
    id,
    session_id: `session-${id}`,
    agent,
    cwd,
    prompt: `seed task ${id}`,
    state,
    process_state: processState,
    turn_state: 'idle',
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    timeout_ms: 600000,
    stale_after_ms: 600000,
    resume: 0
  });
  store.setTaskThread(id, id);
  if (chatId) {
    store.linkChatTask(chatId, id);
    store.upsertChatParticipant({
      chat_id: chatId, participant_id: agent, kind: 'agent', role: agent, display_name: agent
    });
  }
  return store.getTask(id);
}

// Minimal stored-ZIP writer (method 0). Our reader does not verify CRC, so a
// zero CRC is sufficient for fixture data.
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function uploadBuffer(files, chatId, name, buffer, { uploader = 'user', mime } = {}) {
  const init = files.initUpload({ chat_id: chatId, name, size: buffer.length, mime, uploader });
  const chunkSize = 700 * 1024;
  let index = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    files.appendChunk({
      upload_id: init.upload_id,
      index,
      data: buffer.subarray(offset, offset + chunkSize).toString('base64'),
      uploader
    });
    index += 1;
  }
  return files.completeUpload({ upload_id: init.upload_id, uploader });
}