import { MoreHorizontal, Pencil, Search, Settings as SettingsIcon, Users, X } from 'lucide-react';
import { useState } from 'react';
import {
  normalizeAgentState,
  renameChat,
  type ChatStatus,
  type ChatSummary,
} from '../lib/chat';
import type { ChatAgentId } from '../types';
import { navigate } from '../lib/router';
import { AgentPresence, AgentPresenceList } from './AgentPresence';

const OFFLINE_STATES = new Set(['failed', 'stale', 'unknown']);

const AGENT_NAMES: Record<ChatAgentId, string> = {
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

/**
 * Chat header, target-design layout: top line with the online count, search
 * and settings on the right; title row with rename + members + more; compact
 * member row underneath. The "4 人" button opens the real per-member states;
 * the "..." menu holds archive / restore; the search icon opens an inline
 * message search that filters the stream below.
 */
export function ChatHeader({
  chatId,
  chat,
  status,
  statusLoading,
  statusError,
  searchQuery,
  searchMatchCount,
  onSearchChange,
  onRenamed,
}: {
  chatId: string;
  chat: ChatSummary | null;
  status: ChatStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  searchQuery: string;
  searchMatchCount: number;
  onSearchChange: (value: string) => void;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const name = chat?.name ?? `群聊 #${chatId.slice(0, 8)}`;

  // Online count from real derived states: the user is viewing this chat,
  // and an agent counts as online unless its last known state is a failure
  // (failed / stale / unknown). No invented presence.
  const agentStates = (Object.keys(AGENT_NAMES) as ChatAgentId[]).map((id) => {
    if (id === 'muse') {
      return status?.muse?.state ?? (chat?.needs_muse === true ? 'waiting' : 'idle');
    }
    return status?.[id]?.state ?? normalizeAgentState(chat?.agents?.[id]);
  });
  const onlineCount =
    1 + agentStates.filter((state) => !OFFLINE_STATES.has(state)).length;
  const onlineTitle = [
    '你',
    ...(Object.keys(AGENT_NAMES) as ChatAgentId[]).filter(
      (_id, index) => !OFFLINE_STATES.has(agentStates[index]),
    ).map((id) => AGENT_NAMES[id]),
  ].join('、');

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

  const setArchived = async () => {
    if (chat == null || window.workbench == null) {
      return;
    }
    setArchiving(true);
    try {
      const result =
        chat.status === 'archived'
          ? await window.workbench.unarchiveChat(chatId)
          : await window.workbench.archiveChat(chatId);
      if (!result.ok) {
        setRenameError(result.error);
        return;
      }
      onRenamed();
    } catch {
      setRenameError('操作失败。');
    } finally {
      setArchiving(false);
      setShowMenu(false);
    }
  };

  const closePopovers = () => {
    setShowMembers(false);
    setShowMenu(false);
  };

  return (
    <header className="chat-header">
      {(showMembers || showMenu) && (
        <div
          className="chat-header__scrim"
          aria-hidden="true"
          onClick={closePopovers}
        />
      )}

      <div className="chat-header__topline">
        <span className="chat-header__online" title={`在线：${onlineTitle}`}>
          <span className="chat-header__online-dot" aria-hidden="true" />
          在线 · {onlineCount} 人参与
        </span>
        <button
          type="button"
          className="chat-header__topline-btn"
          title="搜索消息"
          aria-label="搜索消息"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-header__topline-btn"
          title="设置"
          aria-label="设置"
          onClick={() => navigate('/settings')}
        >
          <SettingsIcon size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="chat-header__row">
        <div className="chat-header__main">
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
            <div className="chat-header__title-row">
              <h1 className="chat-header__title">{name}</h1>
              {chat?.status === 'archived' && <span className="chat-header__flag">已归档</span>}
              <button
                type="button"
                className="chat-header__topline-btn"
                title="重命名群聊"
                aria-label="重命名群聊"
                disabled={chat == null}
                onClick={startEditing}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <div className="chat-header__row-actions">
          <div className="chat-header__popover-wrap">
            <button
              type="button"
              className="chat-header__members-btn"
              aria-label="查看成员状态"
              aria-expanded={showMembers}
              onClick={() => {
                setShowMenu(false);
                setShowMembers(!showMembers);
              }}
            >
              <Users size={14} aria-hidden="true" />
              4 人
            </button>
            {showMembers && (
              <div className="chat-header__popover">
                <AgentPresenceList
                  status={status}
                  fallback={chat?.agents}
                  needsMuse={chat?.needs_muse ?? false}
                  loading={statusLoading}
                />
              </div>
            )}
          </div>
          <div className="chat-header__popover-wrap">
            <button
              type="button"
              className="chat-header__more-btn"
              aria-label="更多操作"
              aria-expanded={showMenu}
              onClick={() => {
                setShowMembers(false);
                setShowMenu(!showMenu);
              }}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            {showMenu && (
              <ul className="chat-header__menu">
                <li>
                  <button
                    type="button"
                    disabled={chat == null || archiving}
                    onClick={() => void setArchived()}
                  >
                    {chat?.status === 'archived' ? '恢复群聊' : '归档群聊'}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      startEditing();
                    }}
                  >
                    重命名群聊
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>
      </div>

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
      {renameError != null && !editing && (
        <p className="chat-header__warn" role="alert">
          {renameError}
        </p>
      )}

      {searchOpen && (
        <div className="chat-header__search">
          <Search size={14} aria-hidden="true" />
          <label className="sr-only" htmlFor="chat-header-search">
            搜索本群聊消息
          </label>
          <input
            id="chat-header-search"
            type="text"
            value={searchQuery}
            placeholder="搜索本群聊消息…"
            autoFocus
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {searchQuery.trim().length > 0 && (
            <span className="chat-header__search-count">{searchMatchCount} 条匹配</span>
          )}
          <button
            type="button"
            className="chat-header__search-clear"
            onClick={() => {
              onSearchChange('');
              setSearchOpen(false);
            }}
          >
            清除
          </button>
        </div>
      )}
    </header>
  );
}
