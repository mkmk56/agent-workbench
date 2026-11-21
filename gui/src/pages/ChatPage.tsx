import {
  CircleAlert,
  MessagesSquare,
  Plus,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentMentionMenu } from '../components/AgentMentionMenu';
import { ChatHeader } from '../components/ChatHeader';
import { ChatMembersDrawer } from '../components/ChatMembersDrawer';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { TaskInspector } from '../components/TaskInspector';
import { WakeBanner } from '../components/WakeBanner';
import {
  useChatListView,
  useChatMessagesView,
  useChatStatusView,
  useChatStore,
  useMarkChatRead,
} from '../lib/chat-store';
import {
  chatMembersOnce,
  createChat,
  recallChatMessage,
  type ChatMessage,
} from '../lib/chat';
import {
  readHideSystemMessages,
  writeHideSystemMessages,
  type PanelStorage,
} from '../lib/chat-panels';
import { invalidateChatFileIndex, useChatFileIndex } from '../lib/chat-file-index';
import { mergeMessageFiles } from '../lib/chat-files';
import type { MentionRequest, MenuPoint } from '../lib/mention-menu';
import { navigate } from '../lib/router';
import type { ChatAgentId, ChatMember } from '../types';
import '../styles/chat.css';
import '../styles/chat-phase4.css';

function panelStorage(): PanelStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const SENDER_NAMES: Record<string, string> = {
  user: '你',
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

/**
 * One group chat: header, message stream and composer. The shell router mounts
 * this page with the active chat id; all content comes from the single
 * ChatStore (one scheduler, incremental seq cursor). With no chat selected it
 * shows the central empty state.
 *
 * Phase 4 owns the chat-level surfaces here: the task inspector drawer, the
 * members drawer, the wake banner and the per-chat system-message filter.
 */
export function ChatPage({ chatId }: { chatId: string | null }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Muse: right-clicking an agent avatar in the stream opens the one-item
  // "@ this agent" menu. Picking it hands the composer a request to insert
  // `@handle ` at the caret — the composer stays the only owner of the draft.
  const [avatarMenu, setAvatarMenu] = useState<{
    agent: ChatAgentId;
    point: MenuPoint;
    seq: number;
  } | null>(null);
  const [mentionRequest, setMentionRequest] = useState<MentionRequest | null>(null);
  const requestSeq = useRef(0);
  const { setActiveChat, refreshActive, fetchChats, markRecalled } = useChatStore();

  // Phase 4 [A]: which task the inspector shows (null = closed).
  const [inspectorTaskId, setInspectorTaskId] = useState<string | null>(null);
  // Phase 4 [C]: the members drawer, fed by the engine's canonical rows.
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<ChatMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  // Phase 4 [B]: hide system messages (preference in localStorage).
  const [hideSystem, setHideSystem] = useState(() =>
    readHideSystemMessages(panelStorage()),
  );
  // Phase 4 [H]: the message the next send replies to.
  const [replyTo, setReplyTo] = useState<{
    messageId: string;
    from: string;
    summary: string;
  } | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);

  // Drop a pending mention request during render (not in an effect): the
  // composer is remounted per chat, so an effect-time reset would let the new
  // composer replay the previous chat's pick before the reset landed.
  if (mentionRequest != null && mentionRequest.chatId !== chatId) {
    setMentionRequest(null);
  }

  // Anything anchored to a message of the previous chat must not survive a switch.
  useEffect(() => {
    setAvatarMenu(null);
    setInspectorTaskId(null);
    setMembersOpen(false);
    setReplyTo(null);
    setRecallError(null);
  }, [chatId]);

  const openAvatarMenu = useCallback((agent: ChatAgentId, point: MenuPoint) => {
    requestSeq.current += 1;
    setAvatarMenu({ agent, point, seq: requestSeq.current });
  }, []);

  const closeAvatarMenu = useCallback(() => setAvatarMenu(null), []);

  const pickAvatarMention = useCallback(() => {
    if (avatarMenu == null || chatId == null) {
      return;
    }
    requestSeq.current += 1;
    setMentionRequest({ chatId, agent: avatarMenu.agent, seq: requestSeq.current });
    setAvatarMenu(null);
  }, [avatarMenu, chatId]);

  useEffect(() => {
    setActiveChat(chatId);
    return () => setActiveChat(null);
  }, [chatId, setActiveChat]);

  useEffect(() => {
    setSearchQuery('');
  }, [chatId]);

  useEffect(() => {
    writeHideSystemMessages(panelStorage(), hideSystem);
  }, [hideSystem]);

  const { chats } = useChatListView();
  const {
    messages,
    error: messagesError,
    loading: messagesLoading,
    hasMore,
    loadingEarlier,
    refresh: refreshMessages,
    loadEarlier,
  } = useChatMessagesView(chatId);
  const { status, error: statusError, loading: statusLoading } = useChatStatusView(chatId);

  const loadMembers = useCallback(async () => {
    if (chatId == null) {
      setMembers(null);
      return;
    }
    setMembersLoading(true);
    const result = await chatMembersOnce(chatId);
    setMembersLoading(false);
    if (!result.ok) {
      setMembersError(result.error);
      return;
    }
    setMembersError(null);
    setMembers(result.data);
  }, [chatId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  // P0-5 scheme B: merge the chat's attachment list into the message objects so
  // every attachment row can show a real name, size and parse status. The index
  // is cached per chat and invalidated after a send/upload.
  const fileIndex = useChatFileIndex(chatId);
  const mergedMessages = useMemo(
    () => mergeMessageFiles(messages, fileIndex.files),
    [messages, fileIndex.files],
  );

  const newestSeq = mergedMessages.reduce((max, message) => Math.max(max, message.seq), 0);
  useMarkChatRead(chatId, newestSeq);

  const chat = useMemo(
    () => chats.find((item) => item.chat_id === chatId) ?? null,
    [chats, chatId],
  );

  const onSent = useCallback(async () => {
    if (chatId != null) {
      invalidateChatFileIndex(chatId);
    }
    await refreshActive();
  }, [chatId, refreshActive]);

  const handleRecall = useCallback(
    async (message: ChatMessage) => {
      if (chatId == null) {
        return;
      }
      setRecallError(null);
      const result = await recallChatMessage({ chatId, messageId: message.message_id });
      if (!result.ok) {
        setRecallError(result.error);
        return;
      }
      // In place: the engine already replaced the body, and the incremental
      // cursor would never refetch this row on its own.
      markRecalled(chatId, message.message_id);
      await refreshMessages();
    },
    [chatId, markRecalled, refreshMessages],
  );

  // Only the author or the chat owner may recall; the GUI shows the action for
  // the user's own messages and lets the engine reject anything else.
  const canRecall = useCallback((message: ChatMessage) => message.from === 'user', []);

  const startReply = useCallback((message: ChatMessage) => {
    setReplyTo({
      messageId: message.message_id,
      from: SENDER_NAMES[message.from] ?? message.from,
      summary: message.summary,
    });
  }, []);

  const openTask = useCallback((taskId: string) => {
    setInspectorTaskId(taskId);
  }, []);

  if (chatId == null) {
    return (
      <section className="chat-page chat-page--welcome">
        <div className="chat-empty">
          <span className="chat-empty__icon" aria-hidden="true">
            <MessagesSquare size={40} strokeWidth={1.4} />
          </span>
          <h2 className="chat-empty__title">群聊</h2>
          <p className="chat-empty__desc">
            从左侧选择一个群聊，或新建一个。Muse 会读消息、拆任务并分配给 Claude 与 dsh。
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={creating}
            onClick={() => {
              setCreating(true);
              setCreateError(null);
              void createChat()
                .then(async (result) => {
                  setCreating(false);
                  if (!result.ok) {
                    setCreateError(result.error);
                    return;
                  }
                  await fetchChats();
                  navigate(`/chats/${encodeURIComponent(result.data.chat_id)}`);
                })
                .catch(() => {
                  setCreating(false);
                  setCreateError('新建群聊失败。');
                });
            }}
          >
            <Plus size={15} aria-hidden="true" />
            {creating ? '正在新建…' : '新建群聊'}
          </button>
          {createError != null && (
            <p className="chat-inline-error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              {createError}
            </p>
          )}
        </div>
        <div className="chat-page__list">
          {chats.map((item) => (
            <button
              key={item.chat_id}
              type="button"
              className="chat-page__list-row"
              onClick={() => navigate(`/chats/${encodeURIComponent(item.chat_id)}`)}
            >
              <span className="chat-page__list-name">{item.name}</span>
              <span className="chat-page__list-preview">{item.last_message_preview ?? '—'}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="chat-page chat-page--chat">
      <ChatHeader
        chatId={chatId}
        chat={chat}
        status={status}
        statusLoading={statusLoading}
        statusError={statusError}
        searchQuery={searchQuery}
        searchMatchCount={
          searchQuery.trim().length === 0
            ? 0
            : mergedMessages.filter((message) =>
                message.summary
                  .toLowerCase()
                  .includes(searchQuery.trim().toLowerCase()),
              ).length
        }
        members={members}
        hideSystem={hideSystem}
        onToggleHideSystem={setHideSystem}
        onOpenMembers={() => setMembersOpen(true)}
        onSearchChange={setSearchQuery}
        onRenamed={() => {
          void fetchChats();
          void loadMembers();
        }}
      />
      <WakeBanner chatId={chatId} />
      {recallError != null && (
        <p className="chat-inline-error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          撤回失败：{recallError}
        </p>
      )}
      <MessageList
        chatId={chatId}
        messages={mergedMessages}
        status={status}
        loading={messagesLoading}
        error={messagesError}
        searchQuery={searchQuery}
        hideSystem={hideSystem}
        hasMore={hasMore}
        loadingEarlier={loadingEarlier}
        onRetry={() => void refreshMessages()}
        onLoadEarlier={() => void loadEarlier()}
        onMentionAgent={openAvatarMenu}
        onReply={startReply}
        onOpenTask={openTask}
        onRecall={(message) => void handleRecall(message)}
        canRecall={canRecall}
      />
      {avatarMenu != null && (
        <AgentMentionMenu
          key={avatarMenu.seq}
          agent={avatarMenu.agent}
          point={avatarMenu.point}
          onPick={pickAvatarMention}
          onClose={closeAvatarMenu}
        />
      )}
      {/*
        key={chatId}: switching chats remounts the composer so the draft and the
        queue are re-read from that chat's own storage instead of one chat's
        queue being written under another chat's key.
      */}
      <Composer
        key={chatId}
        chatId={chatId}
        status={status}
        onSent={onSent}
        mentionRequest={mentionRequest}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      {inspectorTaskId != null && (
        <TaskInspector
          key={inspectorTaskId}
          taskId={inspectorTaskId}
          onClose={() => setInspectorTaskId(null)}
        />
      )}
      {membersOpen && (
        <ChatMembersDrawer
          chatId={chatId}
          members={members ?? []}
          loading={membersLoading}
          error={membersError}
          onRefresh={() => void loadMembers()}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </section>
  );
}