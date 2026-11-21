import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { UpdateChannel, UpdateState } from './update';

/**
 * Preload is the only place that touches dropped/pasted `File` objects: it maps
 * a real filesystem drop to an opaque path, asks the main process to register
 * it, and hands the renderer a draft id. Clipboard-only content (no path) is
 * forwarded as bytes with a size cap. The renderer never receives a host path
 * and never imports `fs`.
 *
 * Wire types live in `src/types.ts`; the electron tsconfig keeps its rootDir at
 * `electron/`, so the few shapes used here are mirrored locally on purpose.
 */
const MAX_BUFFER_INTAKE_BYTES = 16 * 1_024 * 1_024;

type IntakeSource = 'drop' | 'paste';

interface ChatUploadDraft {
  draftId: string;
  name: string;
  size: number;
  mime: string;
  ext: string;
  kind: string;
  source: IntakeSource;
}

interface ChatUploadProgress {
  uploadId: string;
  draftId: string;
  fileId: string | null;
  name: string;
  size: number;
  uploaded: number;
  percent: number;
  phase: string;
  error?: string;
}

interface ChatMessageQuery {
  chatId: string;
  limit?: number;
  before?: string;
  afterSeq?: number;
}

interface SendChatMessageInput {
  chatId: string;
  from?: 'user' | 'muse';
  to?: string;
  summary: string;
  files?: string[];
  mentions?: string[];
  replyTo?: string;
  clientMsgId?: string;
  question?: string;
  taskId?: string;
}

interface ChatFileQuery {
  chatId: string;
  fileId: string;
  offset?: number;
  limit?: number;
  mode?: 'text' | 'base64';
}

interface IntakeResult {
  ok: boolean;
  data?: { drafts: ChatUploadDraft[] };
  error?: string;
}

/**
 * Wire shapes mirrored from `src/types.ts` (this tsconfig keeps its rootDir at
 * `electron/`, so cross-importing the renderer types is not possible).
 */
interface EngineEvent {
  id?: string | null;
  seq: number;
  chat_id: string | null;
  kind: string;
  from: string | null;
  agent_id: string | null;
  message_id: string | null;
  message_seq: number | null;
  mentions: string[];
  created_at: number;
}

interface EngineEventsStatus {
  state: 'off' | 'connecting' | 'connected';
  degraded: boolean;
  lastSeq: number;
  lastEventAt: string | null;
  error: string | null;
}

async function registerChatFiles(files: File[], source: IntakeSource): Promise<IntakeResult> {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    return { ok: false, error: '没有可上传的文件。' };
  }
  const paths: string[] = [];
  const items: Array<{ name: string; mime: string; data: Uint8Array }> = [];
  const rejected: string[] = [];

  for (const file of list) {
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      path = '';
    }
    if (path.length > 0) {
      paths.push(path);
      continue;
    }
    if (file.size > MAX_BUFFER_INTAKE_BYTES) {
      rejected.push(`${file.name || '剪贴板内容'} 超过 16MB，无法通过剪贴板上传。`);
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    items.push({ name: file.name || 'pasted-file', mime: file.type || '', data });
  }

  const drafts: ChatUploadDraft[] = [];
  if (paths.length > 0) {
    const result = (await ipcRenderer.invoke('chat:register-dropped', {
      paths,
      source,
    })) as IntakeResult;
    if (!result.ok) {
      return result;
    }
    drafts.push(...(result.data?.drafts ?? []));
  }
  if (items.length > 0) {
    const result = (await ipcRenderer.invoke('chat:register-buffers', {
      items,
      source,
    })) as IntakeResult;
    if (!result.ok) {
      return result;
    }
    drafts.push(...(result.data?.drafts ?? []));
  }
  if (drafts.length === 0) {
    return { ok: false, error: rejected[0] ?? '没有可上传的文件。' };
  }
  return { ok: true, data: { drafts } };
}

const workbench = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  setToken: (token: string) => ipcRenderer.invoke('credentials:set-token', token),
  clearToken: () => ipcRenderer.invoke('credentials:clear-token'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  startEngine: () => ipcRenderer.invoke('engine:start'),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  getAgentInfo: () => ipcRenderer.invoke('engine:agent-info'),
  listTasks: (limit?: number) => ipcRenderer.invoke('engine:task-list', limit),
  listMessages: (input?: { limit?: number; taskId?: string }) =>
    ipcRenderer.invoke('engine:message-list', input),
  listChats: (options?: { includeArchived?: boolean }) =>
    ipcRenderer.invoke('engine:chat-list', options ?? {}),
  createChat: (
    name?: string,
    options?: { visibility?: string; category?: string | null },
  ) =>
    ipcRenderer.invoke('engine:chat-create', {
      ...(name == null ? {} : { name }),
      ...(options?.visibility == null ? {} : { visibility: options.visibility }),
      ...(options?.category === undefined ? {} : { category: options.category }),
    }),
  renameChat: (chatId: string, name: string) =>
    ipcRenderer.invoke('engine:chat-rename', { chatId, name }),
  listChatMessages: (input: ChatMessageQuery) =>
    ipcRenderer.invoke('engine:chat-messages', input),
  sendChatMessage: (input: SendChatMessageInput) =>
    ipcRenderer.invoke('engine:chat-send', input),
  chatStatus: (chatId: string) => ipcRenderer.invoke('engine:chat-status', chatId),
  chatParticipants: (chatId: string) =>
    ipcRenderer.invoke('engine:chat-participants', chatId),
  chatMarkRead: (input: {
    chatId: string;
    participantId?: string;
    upToSeq?: number;
    messageId?: string;
  }) => ipcRenderer.invoke('engine:chat-mark-read', input),
  chatInbox: (input?: { agentId?: string; chatId?: string }) =>
    ipcRenderer.invoke('engine:chat-inbox', input ?? {}),
  agentProfile: (input?: { agentId?: string; profile?: string }) =>
    ipcRenderer.invoke('engine:agent-profile', input ?? {}),
  wakeStatus: (input?: { agentId?: string; chatId?: string }) =>
    ipcRenderer.invoke('engine:wake-status', input ?? {}),
  listenerStatus: (input?: { agentId?: string }) =>
    ipcRenderer.invoke('engine:listener-status', input ?? {}),
  wakeEnable: (input: { agentId: string; chatId: string }) =>
    ipcRenderer.invoke('engine:wake-enable', input),
  wakeDisable: (input: { agentId: string; chatId: string }) =>
    ipcRenderer.invoke('engine:wake-disable', input),
  chatMembers: (chatId: string) => ipcRenderer.invoke('engine:chat-members', chatId),
  chatAddMember: (input: { chatId: string; agentId: string }) =>
    ipcRenderer.invoke('engine:chat-add-member', input),
  chatRemoveMember: (input: { chatId: string; agentId: string }) =>
    ipcRenderer.invoke('engine:chat-remove-member', input),
  chatUpdateSettings: (input: {
    chatId: string;
    description?: string;
    announcement?: string;
  }) => ipcRenderer.invoke('engine:chat-update-settings', input),
  chatRecall: (input: { chatId: string; messageId: string }) =>
    ipcRenderer.invoke('engine:chat-recall', input),
  chatDeleteFile: (input: { chatId: string; fileId: string }) =>
    ipcRenderer.invoke('engine:chat-delete-file', input),
  agentPairingCode: (input?: { ttlHours?: number; maxAgents?: number }) =>
    ipcRenderer.invoke('engine:agent-pairing-code', input ?? {}),
  agentPair: (input: {
    code: string;
    name: string;
    platform?: string;
    profile?: string;
    reclaim?: boolean;
    chatIds?: string[];
  }) => ipcRenderer.invoke('engine:agent-pair', input),
  agentRevokeToken: (input?: { agentId?: string }) =>
    ipcRenderer.invoke('engine:agent-revoke', input ?? {}),
  // ---- REA Phase 5 community surface (docs/rea/PHASE5_DESIGN.md §3.2) ----
  chatSetVisibility: (input: { chatId: string; visibility: string }) =>
    ipcRenderer.invoke('engine:chat-set-visibility', input),
  chatSetCategory: (input: { chatId: string; category: string | null }) =>
    ipcRenderer.invoke('engine:chat-set-category', input),
  groupInviteCreate: (input: { chatId: string; ttlHours?: number; maxUses?: number }) =>
    ipcRenderer.invoke('engine:group-invite-create', input),
  groupInviteRevoke: (input: { inviteId: string }) =>
    ipcRenderer.invoke('engine:group-invite-revoke', input),
  groupInviteList: (input?: { chatId?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('engine:group-invite-list', input ?? {}),
  chatJoinApprove: (input: { requestId: string }) =>
    ipcRenderer.invoke('engine:chat-join-approve', input),
  chatJoinDecline: (input: { requestId: string; reason?: string }) =>
    ipcRenderer.invoke('engine:chat-join-decline', input),
  chatJoinList: (input?: {
    chatId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => ipcRenderer.invoke('engine:chat-join-list', input ?? {}),
  chatJoinNotices: (input?: {
    chatId?: string;
    read?: boolean;
    limit?: number;
    offset?: number;
    markRead?: 'one' | 'all';
    noticeId?: string;
  }) => ipcRenderer.invoke('engine:chat-join-notices', input ?? {}),
  listPublicChats: (input?: {
    category?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) => ipcRenderer.invoke('engine:list-public-chats', input ?? {}),
  listAgentsDirectory: (input?: { limit?: number; offset?: number; status?: string }) =>
    ipcRenderer.invoke('engine:list-agents-directory', input ?? {}),
  chatSetRole: (input: { chatId: string; agentId: string; role: 'admin' | 'member' }) =>
    ipcRenderer.invoke('engine:chat-set-role', input),
  getEventsStatus: () => ipcRenderer.invoke('engine:events-status'),
  onEngineEvent: (callback: (event: EngineEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: EngineEvent) =>
      callback(payload);
    ipcRenderer.on('engine:event', listener);
    return () => {
      ipcRenderer.removeListener('engine:event', listener);
    };
  },
  onEventsStatus: (callback: (status: EngineEventsStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: EngineEventsStatus) =>
      callback(payload);
    ipcRenderer.on('engine:events-status', listener);
    return () => {
      ipcRenderer.removeListener('engine:events-status', listener);
    };
  },
  pickChatFiles: () => ipcRenderer.invoke('chat:pick-files'),
  registerChatFiles: (files: File[], source?: IntakeSource) =>
    registerChatFiles(files, source ?? 'drop'),
  uploadChatFiles: (input: { chatId: string; uploadId: string; draftIds: string[] }) =>
    ipcRenderer.invoke('engine:chat-upload', input),
  discardChatDrafts: (draftIds: string[]) =>
    ipcRenderer.invoke('chat:draft-discard', draftIds),
  readChatFile: (input: ChatFileQuery) => ipcRenderer.invoke('engine:chat-file-read', input),
  listChatFiles: (input: { chatId: string; limit?: number }) =>
    ipcRenderer.invoke('engine:chat-files', input),
  previewChatFile: (chatId: string, fileId: string) =>
    ipcRenderer.invoke('engine:chat-file-preview', { chatId, fileId }),
  downloadChatFile: (chatId: string, fileId: string) =>
    ipcRenderer.invoke('engine:chat-file-download', { chatId, fileId }),
  openChatFile: (input: { chatId: string; fileId: string; action?: 'open' | 'reveal' }) =>
    ipcRenderer.invoke('engine:chat-file-open', input),
  saveChatFile: (input: { chatId: string; fileId: string }) =>
    ipcRenderer.invoke('engine:chat-file-save', input),
  onChatUploadProgress: (callback: (progress: ChatUploadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ChatUploadProgress) =>
      callback(progress);
    ipcRenderer.on('chat:upload-progress', listener);
    return () => {
      ipcRenderer.removeListener('chat:upload-progress', listener);
    };
  },
  getTaskStatus: (taskId: string) => ipcRenderer.invoke('engine:task-status', taskId),
  getTaskLogs: (input: { taskId: string; cursor?: number; limit?: number }) =>
    ipcRenderer.invoke('engine:task-logs', input),
  startTask: (input: {
    agent: 'claude' | 'dsh';
    prompt: string;
    cwd?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke('engine:task-start', input),
  sendTask: (taskId: string, prompt: string) =>
    ipcRenderer.invoke('engine:task-send', taskId, prompt),
  cancelTask: (taskId: string) => ipcRenderer.invoke('engine:task-cancel', taskId),
  getHudConfig: () => ipcRenderer.invoke('hud:get-config'),
  setHudConfig: (patch: { paperPlanes?: boolean; contextWindowTokens?: number }) =>
    ipcRenderer.invoke('hud:set-config', patch),
  respondApproval: (input: {
    taskId?: string;
    approvalId?: string;
    decision: 'once' | 'session' | 'deny';
    reason?: string;
  }) => ipcRenderer.invoke('engine:respond-approval', input),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  installUpdate: () =>
    ipcRenderer.invoke('update:install') as Promise<{ ok: boolean; error?: string }>,
  setUpdateChannel: (channel: UpdateChannel): Promise<UpdateState> =>
    ipcRenderer.invoke('update:set-channel', channel),
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => {
      ipcRenderer.removeListener('update:state', listener);
    };
  },
};

contextBridge.exposeInMainWorld('workbench', workbench);
