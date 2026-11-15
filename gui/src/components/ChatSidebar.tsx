import { Info, Plus, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import logoInverse from '@brand/logo/logo-inverse.svg';
import logoPrimary from '@brand/logo/logo-primary.svg';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import type { ChatSummary, Route } from '../types';
import { AppButton, AppEmptyState, AppIconButton } from '../ui/astryx';

/**
 * Chat sidebar (Muse). The chat LIST lives here; the center chat view is
 * Claude's ChatPage. Lists real chats from the engine (listChats); no mock data.
 */
export function ChatSidebar({ route }: { route: Route }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError('主进程未连接（浏览器预览）。');
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await window.workbench.listChats();
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setChats(result.data.chats);
      setError(null);
    } catch {
      if (alive.current) {
        setError('读取群聊列表失败。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const createChat = async () => {
    if (!window.workbench) {
      setFormError('主进程未连接（浏览器预览）。');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const result = await window.workbench.createChat(
        name.trim().length > 0 ? name.trim() : undefined,
      );
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setName('');
      setShowForm(false);
      await refresh();
      navigate(`/chats/${result.data.chat_id}`);
    } catch {
      setFormError('创建群聊失败。');
    } finally {
      setCreating(false);
    }
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
                  void createChat();
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
                onClick={() => void createChat()}
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