import { Pencil, X } from 'lucide-react';
import { useState } from 'react';
import {
  renameChat,
  type ChatStatus,
  type ChatSummary,
} from '../lib/chat';
import { formatRelative } from '../lib/labels';
import { AgentPresence } from './AgentPresence';

/**
 * Chat header: name, real participant presence and the chat settings entry
 * (rename — the only chat mutation the engine exposes in v1).
 */
export function ChatHeader({
  chatId,
  chat,
  status,
  statusLoading,
  statusError,
  onRenamed,
}: {
  chatId: string;
  chat: ChatSummary | null;
  status: ChatStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const name = chat?.name ?? `群聊 #${chatId.slice(0, 8)}`;
  const meta =
    chat?.last_message_at != null
      ? `最后消息 · ${formatRelative(chat.last_message_at)}`
      : chat != null
        ? '尚无消息'
        : '正在读取群聊…';

  const startEditing = () => {
    setDraft(chat?.name ?? '');
    setRenameError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setRenameError(null);
  };

  const submitRename = async () => {
    const next = draft.trim();
    if (next.length === 0) {
      setRenameError('群聊名不能为空。');
      return;
    }
    if (chat != null && next === chat.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setRenameError(null);
    const result = await renameChat(chatId, next);
    setSaving(false);
    if (result.ok) {
      setEditing(false);
      onRenamed();
    } else {
      setRenameError(result.error);
    }
  };

  return (
    <header className="chat-header">
      <div className="chat-header__main">
        <div className="chat-header__title-row">
          <h1 className="chat-header__title">{name}</h1>
          {chat?.status === 'archived' && <span className="chat-header__flag">已归档</span>}
        </div>
        <p className="chat-header__meta">{meta}</p>
        <AgentPresence
          status={status}
          fallback={chat?.agents}
          needsMuse={chat?.needs_muse ?? false}
          loading={statusLoading}
        />
        {statusError != null && (
          <p className="chat-header__warn" role="status">
            Agent 状态读取失败：{statusError}
          </p>
        )}
      </div>

      <div className="chat-header__actions">
        {editing ? (
          <form
            className="chat-header__rename"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <input
              className="chat-header__rename-input"
              aria-label="群聊名称"
              value={draft}
              maxLength={80}
              autoFocus
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="取消重命名"
              disabled={saving}
              onClick={cancelEditing}
            >
              <X size={14} aria-hidden="true" />
            </button>
            {renameError != null && (
              <p className="chat-header__rename-error" role="alert">
                {renameError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            title="群聊设置"
            disabled={chat == null}
            onClick={startEditing}
          >
            <Pencil size={14} aria-hidden="true" />
            重命名
          </button>
        )}
      </div>
    </header>
  );
}