import { CircleAlert, MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatHeader } from '../components/ChatHeader';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import {
  useChatListView,
  useChatMessagesView,
  useChatStatusView,
  useChatStore,
  useMarkChatRead,
} from '../lib/chat-store';
import { createChat } from '../lib/chat';
import { invalidateChatFileIndex, useChatFileIndex } from '../lib/chat-file-index';
import { mergeMessageFiles } from '../lib/chat-files';
import { navigate } from '../lib/router';
import '../styles/chat.css';

/**
 * One group chat: header, message stream and composer. The shell router mounts
 * this page with the active chat id; all content comes from the single
 * ChatStore (one scheduler, incremental seq cursor). With no chat selected it
 * shows the central empty state.
 */
export function ChatPage({ chatId }: { chatId: string | null }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { setActiveChat, refreshActive, fetchChats } = useChatStore();

  useEffect(() => {
    setActiveChat(chatId);
    return () => setActiveChat(null);
  }, [chatId, setActiveChat]);

  useEffect(() => {
    setSearchQuery('');
  }, [chatId]);

  const { chats } = useChatListView();
  const {
    messages,
    error: messagesError,
    loading: messagesLoading,
    refresh: refreshMessages,
  } = useChatMessagesView(chatId);
  const { status, error: statusError, loading: statusLoading } = useChatStatusView(chatId);

  // P0-5 scheme B: merge the chat's attachment list into the message objects so
  // every attachment row can show a real name, size and parse status. The index
  // is cached per chat and invalidated after a send/upload.
  const fileIndex = useChatFileIndex(chatId);
  const mergedMessages = useMemo(
    () => mergeMessageFiles(messages, fileIndex.files),
    [messages, fileIndex.files],
  );

  const chat = chatId != null ? (chats.find((item) => item.chat_id === chatId) ?? null) : null;

  // P0-6 / REA Phase 2 §5: pulling messages is "read". The engine advances the
  // cursor on list_chat_messages; this explicit chat_mark_read keeps the chat
  // list's unread badge and the inbox counters in step with what is on screen.
  const newestSeq = messages.reduce((max, message) => Math.max(max, message.seq), 0);
  useMarkChatRead(chatId, newestSeq);

  const needle = searchQuery.trim().toLowerCase();
  const searchMatchCount =
    needle.length === 0
      ? 0
      : messages.filter((message) => message.summary.toLowerCase().includes(needle)).length;

  const onSent = useCallback(async () => {
    // New uploads/sends change the attachment list: drop the cached index so
    // the next render reads the authoritative rows again.
    invalidateChatFileIndex(chatId);
    await refreshActive();
  }, [chatId, refreshActive]);

  const createNewChat = async () => {
    setCreating(true);
    setCreateError(null);
    const result = await createChat();
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    await fetchChats();
    navigate(`/chats/${encodeURIComponent(result.data.chat_id)}`);
  };

  if (chatId == null) {
    return (
      <section className="chat-page chat-page--welcome" aria-label="群聊">
        <div className="chat-empty">
          <span className="chat-empty__icon" aria-hidden="true">
            <MessagesSquare size={32} strokeWidth={1.6} />
          </span>
          <h1 className="chat-empty__title">选择一个群聊</h1>
          <p className="chat-empty__desc">
            每个群聊是一份独立的任务上下文。从左侧选择群聊，或新建一个群聊开始协作。
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void createNewChat()}
            disabled={creating}
          >
            <Plus size={14} aria-hidden="true" />
            {creating ? '正在创建…' : '新建会话'}
          </button>
          {createError != null && (
            <p className="chat-empty__error" role="alert">
              <CircleAlert size={12} aria-hidden="true" />
              创建失败：{createError}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="chat-page" aria-label={chat?.name ?? '群聊'}>
      <ChatHeader
        chatId={chatId}
        chat={chat}
        status={status}
        statusLoading={statusLoading}
        statusError={statusError}
        searchQuery={searchQuery}
        searchMatchCount={searchMatchCount}
        onSearchChange={setSearchQuery}
        onRenamed={() => void fetchChats()}
      />
      <MessageList
        chatId={chatId}
        messages={mergedMessages}
        status={status}
        loading={messagesLoading}
        error={messagesError}
        searchQuery={searchQuery}
        onRetry={() => void refreshMessages()}
      />
      {/*
        key={chatId}: switching chats remounts the composer so the draft and the
        queue are re-read from that chat's own storage instead of one chat's
        queue being written under another chat's key.
      */}
      <Composer key={chatId} chatId={chatId} status={status} onSent={onSent} />
    </section>
  );
}
