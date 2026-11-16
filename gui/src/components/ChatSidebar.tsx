import { Info, Plus, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import logoInverse from '@brand/logo/logo-inverse.svg';
import logoPrimary from '@brand/logo/logo-primary.svg';
import { createChat } from '../lib/chat';
import { useChatListView } from '../lib/chat-store';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import type { Route } from '../types';
import { AppButton, AppEmptyState, AppIconButton } from '../ui/astryx';

/**
 * Chat sidebar (Muse). The chat LIST lives here; the center chat view is
 * Claude's ChatPage. The list is read from the single ChatStore (no local
 * polling) so the sidebar and the chat page share one fetch cadence.
 */
export function ChatSidebar({ route }: { route: Route }) {
  const { chats, error, loading, refresh } = useChatListView();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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

  const selectedId = route.name === 'chat' ? route.id : null;

  return (
    <aside className="chat-sidebar" aria-label="群聊列表">
      <div className="chat-sidebar__brand">
        <img className="logo logo--light" src={logoPrimary} alt="Agent Workbench" />
        <img className="logo logo--dark" src={logoInverse} alt="Agent Workbench" />
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
          <AppButton
            label="＋ 新建群聊"
            tone="primary"
            icon={<Plus size={15} />}
            className="btn-block"
            onClick={() => setShowForm(true)}
          />
        )}
      </div>

      <div className="chat-list" role="list" aria-label="群聊">
        {loading && chats.length === 0 ? (
          <p className="chat-list__note">正在读取群聊…</p>
        ) : error != null && chats.length === 0 ? (
          <div className="chat-list__error">
            <p className="chat-list__note">{error}</p>
            <AppButton
              label="重试"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={() => void refresh()}
            />
          </div>
        ) : chats.length === 0 ? (
          <AppEmptyState
            title="还没有群聊"
            description="点击「＋ 新建群聊」创建第一个任务群聊。"
          />
        ) : (
          chats.map((chat) => (
            <button
              key={chat.chat_id}
              type="button"
              role="listitem"
              className={`chat-item${selectedId === chat.chat_id ? ' is-selected' : ''}`}
              aria-current={selectedId === chat.chat_id ? 'true' : undefined}
              onClick={() => navigate(`/chats/${chat.chat_id}`)}
            >
              <span className="chat-item__top">
                <span className="chat-item__name">
                  {chat.needs_muse && (
                    <span className="chat-item__dot" aria-label="等 Muse 回复" />
                  )}
                  {chat.name}
                </span>
                <span className="chat-item__time">
                  {chat.last_message_at != null ? formatRelative(chat.last_message_at) : ''}
                </span>
              </span>
              <span className="chat-item__preview">
                {chat.last_message_preview ?? '还没有消息'}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="chat-sidebar__footer">
        <AppIconButton
          label="设置"
          title="设置"
          icon={<SettingsIcon size={16} />}
          onClick={() => navigate('/settings')}
        />
        <AppIconButton
          label="关于"
          title="关于"
          icon={<Info size={16} />}
          onClick={() => navigate('/about')}
        />
      </div>
    </aside>
  );
}