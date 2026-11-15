import { CircleAlert, MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ChatHeader } from '../components/ChatHeader';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { createChat, useChatList, useChatMessages, useChatStatus } from '../lib/chat';
import { navigate } from '../lib/router';
import '../styles/chat.css';

/**
 * One group chat: header, message stream and composer. The shell router mounts
 * this page with the active chat id; all content comes from the engine chat
 * tools. With no chat selected it shows the central empty state.
 */
export function ChatPage({ chatId }: { chatId: string | null }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const chatsState = useChatList(5_000);
  const {
    messages,
    error: messagesError,
    loading: messagesLoading,
    refresh: refreshMessages,
  } = useChatMessages(chatId, 3_000);
  const {
    status,
    error: statusError,
    loading: statusLoading,
    refresh: refreshStatus,
  } = useChatStatus(chatId, 5_000);
  const { refresh: refreshChats, chats } = chatsState;

  const chat = chatId != null ? (chats.find((item) => item.chat_id === chatId) ?? null) : null;

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
        chatId={chatId}
        chat={chat}
        status={status}
        statusLoading={statusLoading}
        statusError={statusError}
        onRenamed={() => void refreshChats()}
      />
      <MessageList
        chatId={chatId}
        messages={messages}
        loading={messagesLoading}
        error={messagesError}
        onRetry={() => void refreshMessages()}
      />
      <Composer chatId={chatId} onSent={onSent} />
    </section>
  );
}