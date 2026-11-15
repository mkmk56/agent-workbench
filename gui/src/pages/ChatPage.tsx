import { CircleAlert, MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ChatHeader } from '../components/ChatHeader';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { createChat, useChatList, useChatMessages, useChatStatus } from '../lib/chat';
import { navigate } from '../lib/router';
import '../styles/chat.css';

function parseChatIdFromHash(): string | null {
  const path = window.location.hash.replace(/^#/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'chats' && parts.length >= 2) {
    return decodeURIComponent(parts[1]);
  }
  return null;
}

/**
 * One group chat: header, message stream and composer. The shell mounts this
 * page with the active chat id; the hash fallback keeps the page usable on its
 * own while the router is being wired.
 */
export function ChatPage({ chatId }: { chatId?: string | null }) {
  const [hashChatId, setHashChatId] = useState<string | null>(parseChatIdFromHash);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => setHashChatId(parseChatIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const activeId = chatId !== undefined ? (chatId ?? null) : hashChatId;
  const chatsState = useChatList(5_000);
  const {
    messages,
    error: messagesError,
    loading: messagesLoading,
    refresh: refreshMessages,
  } = useChatMessages(activeId, 3_000);
  const {
    status,
    error: statusError,
    loading: statusLoading,
    refresh: refreshStatus,
  } = useChatStatus(activeId, 5_000);
  const { refresh: refreshChats, chats } = chatsState;

  const chat = activeId != null ? (chats.find((item) => item.chat_id === activeId) ?? null) : null;

  const onSent = useCallback(async () => {
    await Promise.all([refreshMessages(), refreshStatus(), refreshChats()]);
  }, [refreshChats, refreshMessages, refreshStatus]);

  const createNewChat = async () => {
    setCreating(true);
    setCreateError(null);
    const result = await createChat();
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    await refreshChats();
    navigate(`/chats/${encodeURIComponent(result.data.chat_id)}`);
  };

  if (activeId == null) {
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
            {creating ? '正在创建…' : '新建群聊'}
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
        chatId={activeId}
        chat={chat}
        status={status}
        statusLoading={statusLoading}
        statusError={statusError}
        onRenamed={() => void refreshChats()}
      />
      <MessageList
        chatId={activeId}
        messages={messages}
        loading={messagesLoading}
        error={messagesError}
        onRetry={() => void refreshMessages()}
      />
      <Composer chatId={activeId} onSent={onSent} />
    </section>
  );
}