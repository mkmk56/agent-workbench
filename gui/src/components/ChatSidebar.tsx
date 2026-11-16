import { Archive, ArchiveRestore, ChevronDown, Plus, RefreshCw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import { archiveChat, createChat, listChatsOnce, unarchiveChat } from '../lib/chat';
import { useChatListView } from '../lib/chat-store';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import type { ChatSummary, Route } from '../types';
import { AppButton, AppEmptyState } from '../ui/astryx';

const MARKS: Record<string, string> = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

type ListFilter = 'all' | 'unread' | 'archived';

const FILTER_LABELS: Record<ListFilter, string> = {
  all: '全部会话',
  unread: '有未读',
  archived: '已归档',
};

/**
 * Session list (Muse, group-chat upgrade). The list comes from the single
 * ChatStore (no local polling); unread counts are the engine's server-side
 * `chat.unread` (last_read_seq based), not a local estimate. The store does
 * not fetch archived chats, so the 已归档 filter loads them once directly.
 * Header is the "全部会话" filter dropdown; each card shows the name,
 * member avatars, last-message preview, time and unread count. New sessions
 * start from the "+ 新建会话" text link at the foot of the list.
 */
export function ChatSidebar({ route }: { route: Route }) {
  const { chats, loading, error, refresh: refreshStore } = useChatListView();
  const [archivedChats, setArchivedChats] = useState<ChatSummary[]>([]);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const selectedId = route.name === 'chat' ? route.id : null;

  const refresh = useCallback(async () => {
    if (filter === 'archived') {
      setArchivedLoading(true);
      setArchivedError(null);
      const result = await listChatsOnce(true);
      setArchivedLoading(false);
      if (result.ok) {
        setArchivedChats(result.data.filter((chat) => chat.status === 'archived'));
      } else {
        setArchivedError(result.error);
      }
      return;
    }
    await refreshStore();
  }, [filter, refreshStore]);

  useEffect(() => {
    if (filter === 'archived') {
      void refresh();
    }
  }, [filter, refresh]);

  const submitCreate = async () => {
    setCreating(true);
    setFormError(null);
    const result = await createChat(name.trim().length > 0 ? name.trim() : undefined);
    setCreating(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setName('');
    setShowForm(false);
    await refresh();
    navigate(`/chats/${result.data.chat_id}`);
  };

  const setArchived = async (chatId: string, archived: boolean) => {
    setActing(chatId);
    try {
      const result = archived ? await archiveChat(chatId) : await unarchiveChat(chatId);
      if (result.ok) {
        await refresh();
      } else {
        setArchivedError(result.error);
      }
    } catch {
      setArchivedError(archived ? '归档群聊失败。' : '恢复群聊失败。');
    } finally {
      setActing(null);
    }
  };

  const listError = filter === 'archived' ? archivedError : error;
  const listLoading = filter === 'archived' ? archivedLoading : loading;
  const sourceChats = filter === 'archived' ? archivedChats : chats;
  const visible = sourceChats.filter((chat) => {
    if (filter === 'archived') {
      return true;
    }
    if (chat.status === 'archived') {
      return false;
    }
    if (filter === 'unread') {
      return (chat.unread ?? 0) > 0;
    }
    return true;
  });

  const renderItem = (chat: ChatSummary) => {
    const isArchived = chat.status === 'archived';
    const unreadCount = chat.unread ?? 0;
    const members = Object.keys(chat.agents ?? {});
    return (
      <div
        key={chat.chat_id}
        className={`chat-item-wrap${selectedId === chat.chat_id ? ' is-selected' : ''}`}
      >
        <button
          type="button"
          className={`chat-item${selectedId === chat.chat_id ? ' is-selected' : ''}`}
          aria-current={selectedId === chat.chat_id ? 'true' : undefined}
          onClick={() => navigate(`/chats/${chat.chat_id}`)}
        >
          <span className="chat-item__top">
            <span className="chat-item__avatars" aria-hidden="true">
              {members.map((agent) => (
                <span key={agent} className={`chat-item__avatar chat-item__avatar--${agent}`}>
                  {MARKS[agent] != null ? <img src={MARKS[agent]} alt="" draggable={false} /> : agent.slice(0, 1)}
                </span>
              ))}
              <span className="chat-item__avatar chat-item__avatar--user">
                <UserRound size={14} strokeWidth={2} />
              </span>
            </span>
            <span className="chat-item__name">
              {chat.needs_muse && (
                <span className="chat-item__dot" aria-label="等 Muse 回复" />
              )}
              {chat.name}
            </span>
            <span className="chat-item__time">
              {chat.last_message_at != null ? formatRelative(chat.last_message_at) : ''}
            </span>
            {unreadCount > 0 && selectedId !== chat.chat_id && (
              <span className="chat-item__unread" aria-label={`${unreadCount} 条未读消息`}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </span>
          <span className="chat-item__preview">
            {chat.last_message_preview ?? '还没有消息'}
          </span>
        </button>
        <button
          type="button"
          className="chat-item__archive"
          title={isArchived ? '恢复群聊' : '归档群聊'}
          aria-label={isArchived ? `恢复群聊 ${chat.name}` : `归档群聊 ${chat.name}`}
          disabled={acting === chat.chat_id}
          onClick={() => void setArchived(chat.chat_id, !isArchived)}
        >
          {isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
      </div>
    );
  };

  return (
    <aside className="chat-sidebar" aria-label="群聊列表">
      <div className="chat-sidebar__head">
        <button
          type="button"
          className="chat-sidebar__filter"
          aria-label="筛选会话列表"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen(!filterOpen)}
        >
          {FILTER_LABELS[filter]}
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        {filterOpen && (
          <ul className="chat-sidebar__filter-menu" role="menu">
            {(Object.keys(FILTER_LABELS) as ListFilter[]).map((key) => (
              <li key={key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={filter === key ? 'is-active' : undefined}
                  onClick={() => {
                    setFilter(key);
                    setFilterOpen(false);
                  }}
                >
                  {FILTER_LABELS[key]}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="chat-list" role="list" aria-label="群聊">
        {listLoading && sourceChats.length === 0 ? (
          <p className="chat-list__note">正在读取群聊…</p>
        ) : listError != null && sourceChats.length === 0 ? (
          <div className="chat-list__error">
            <p className="chat-list__note">{listError}</p>
            <AppButton
              label="重试"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={() => void refresh()}
            />
          </div>
        ) : sourceChats.length === 0 ? (
          <AppEmptyState
            title="还没有群聊"
            description="点击「新建会话」创建第一个任务群聊。"
          />
        ) : visible.length === 0 ? (
          <p className="chat-list__note">
            {filter === 'unread' ? '没有未读会话。' : '这里还没有会话。'}
          </p>
        ) : (
          visible.map(renderItem)
        )}
      </div>

      <div className="chat-sidebar__new">
        {showForm ? (
          <div className="chat-new-form">
            <input
              className="input"
              type="text"
              value={name}
              maxLength={100}
              placeholder="群聊名称（可留空，稍后命名）"
              aria-label="群聊名称"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void submitCreate();
                }
                if (event.key === 'Escape') {
                  setShowForm(false);
                  setName('');
                  setFormError(null);
                }
              }}
            />
            <div className="chat-new-form__actions">
              <AppButton
                label={creating ? '创建中…' : '创建'}
                tone="primary"
                size="sm"
                isLoading={creating}
                isDisabled={creating}
                onClick={() => void submitCreate()}
              />
              <AppButton
                label="取消"
                size="sm"
                isDisabled={creating}
                onClick={() => {
                  setShowForm(false);
                  setName('');
                  setFormError(null);
                }}
              />
            </div>
            {formError != null && <p className="field__hint field__hint--error">{formError}</p>}
          </div>
        ) : (
          <button
            type="button"
            className="chat-sidebar__new-session"
            onClick={() => setShowForm(true)}
          >
            <Plus size={15} aria-hidden="true" />
            新建会话
          </button>
        )}
      </div>
    </aside>
  );
}
