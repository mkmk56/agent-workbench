import { MessagesSquare, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  createChat,
  normalizeAgentState,
  useChatList,
  type ChatSummary,
} from '../lib/chat';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';

function previewText(chat: ChatSummary): string {
  const preview = chat.last_message_preview?.trim();
  return preview != null && preview.length > 0 ? preview : '还没有消息';
}

function activityLabel(chat: ChatSummary): { label: string; tone: 'waiting' | 'working' } | null {
  if (chat.needs_muse) {
    return { label: '等 Muse 回复', tone: 'waiting' };
  }
  const states = [chat.agents.claude, chat.agents.dsh].map(normalizeAgentState);
  if (states.includes('working')) {
    return { label: 'Agent 执行中', tone: 'working' };
  }
  if (states.includes('queued') || states.includes('starting')) {
    return { label: 'Agent 排队中', tone: 'working' };
  }
  return null;
}

/**
 * Chat list for the shell's left column. New chats are created through the
 * engine (`create_chat`) and opened only after the engine confirms the chat.
 */
export function ChatList({
  activeId = null,
  onSelect,
}: {
  activeId?: string | null;
  onSelect?: (chatId: string) => void;
}) {
  const { chats, error, loading, refresh } = useChatList();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const select = (chatId: string) => {
    if (onSelect != null) {
      onSelect(chatId);
      return;
    }
    navigate(`/chats/${chatId}`);
  };

  const handleCreate = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    const result = await createChat();
    setCreating(false);
    if (result.ok) {
      await refresh();
      select(result.data.chat_id);
    } else {
      setCreateError(result.error);
    }
  };

  return (
    <section className="chat-list" aria-label="群聊列表">
      <div className="chat-list__head">
        <button
          type="button"
          className="btn btn-primary btn-sm chat-list__new"
          disabled={creating}
          onClick={() => void handleCreate()}
        >
          <Plus size={14} aria-hidden="true" />
          {creating ? '正在创建…' : '新建群聊'}
        </button>
      </div>

      {createError != null && (
        <div className="chat-list__error" role="alert">
          <span>创建失败：{createError}</span>
          <button type="button" className="chat-list__retry" onClick={() => void handleCreate()}>
            重试
          </button>
        </div>
      )}

      {loading && chats.length === 0 && (
        <p className="chat-list__status" role="status">
          正在读取群聊…
        </p>
      )}

      {error != null && chats.length === 0 && (
        <div className="chat-list__error" role="status">
          <span>群聊列表读取失败：{error}</span>
          <button type="button" className="chat-list__retry" onClick={() => void refresh()}>
            <RefreshCw size={12} aria-hidden="true" />
            重试
          </button>
        </div>
      )}

      {!loading && error == null && chats.length === 0 && (
        <div className="chat-list__empty">
          <MessagesSquare size={24} strokeWidth={1.6} aria-hidden="true" />
          <p>还没有群聊。新建一个群聊开始协作。</p>
        </div>
      )}

      <ul className="chat-list__items">
        {chats.map((chat) => {
          const activity = activityLabel(chat);
          return (
            <li key={chat.chat_id}>
              <a
                className={`chat-list__item${chat.chat_id === activeId ? ' is-active' : ''}`}
                href={`#/chats/${encodeURIComponent(chat.chat_id)}`}
                aria-current={chat.chat_id === activeId ? 'page' : undefined}
                onClick={(event) => {
                  if (onSelect != null) {
                    event.preventDefault();
                    onSelect(chat.chat_id);
                  }
                }}
              >
                <span className="chat-list__row">
                  <span className="chat-list__name">{chat.name}</span>
                  {chat.last_message_at != null && (
                    <time className="chat-list__time" dateTime={chat.last_message_at}>
                      {formatRelative(chat.last_message_at)}
                    </time>
                  )}
                </span>
                <span className="chat-list__preview">{previewText(chat)}</span>
                {activity != null && (
                  <span className={`chat-list__activity chat-list__activity--${activity.tone}`}>
                    <span className="chat-list__dot" aria-hidden="true" />
                    {activity.label}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>

      {error != null && chats.length > 0 && (
        <p className="chat-list__stale" role="status">
          列表刷新失败：{error}
        </p>
      )}
    </section>
  );
}