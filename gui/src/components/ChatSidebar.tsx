import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  UserRound,
} from '../ui/icons';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import { archiveChat, createChat, listChatsOnce, unarchiveChat } from '../lib/chat';
import {
  CHAT_SIDEBAR_DEFAULT_WIDTH,
  CHAT_SIDEBAR_MAX_WIDTH,
  CHAT_SIDEBAR_MIN_WIDTH,
  applyViewportWidth,
  chatSidebarColumnWidth,
  dragChatSidebarWidth,
  initialChatSidebarLayout,
  nudgeChatSidebarWidth,
  readChatSidebarLayout,
  writeChatSidebarLayout,
  type ChatSidebarLayout,
  type ChatSidebarStorage,
} from '../lib/chat-sidebar-layout';
import { useChatListView } from '../lib/chat-store';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import type { ChatSummary, Route } from '../types';
import { AppButton, AppEmptyState } from '../ui/astryx';
import { SidebarStatusStrip } from './SidebarStatusStrip';

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
 *
 * The column is freely resizable (drag the 8px separator, ←/→ ±16px, Home or
 * double-click = 336px) and collapsible (12px strip). Width and collapsed
 * state are a view-layer preference in localStorage — never ChatStore, the
 * engine or the database. ≤1180px defaults to 280px, ≤1080px auto-collapses.
 */

/** localStorage, or null when the context forbids it. */
function sidebarStorage(): ChatSidebarStorage | null {
  try {
    return window.localStorage;
  } catch {
    // Restricted contexts: the layout still works, it just cannot persist.
    return null;
  }
}

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

  // --- Width / collapse (task §4) ------------------------------------
  const bootRef = useRef<{ layout: ChatSidebarLayout; autoCollapsed: boolean } | null>(null);
  if (bootRef.current == null) {
    bootRef.current = initialChatSidebarLayout(
      window.innerWidth,
      readChatSidebarLayout(sidebarStorage()),
    );
  }
  const boot = bootRef.current;
  const [layout, setLayout] = useState<ChatSidebarLayout>(boot.layout);
  const layoutRef = useRef<ChatSidebarLayout>(boot.layout);
  const autoCollapsedRef = useRef<boolean>(boot.autoCollapsed);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  const applyLayout = useCallback((next: ChatSidebarLayout, persist: boolean) => {
    layoutRef.current = next;
    setLayout(next);
    if (persist) {
      // Only user actions are written: the ≤1080px auto-collapse is derived
      // from the window size and must not overwrite the user's preference.
      writeChatSidebarLayout(sidebarStorage(), next);
    }
  }, []);

  // The grid reads --chat-sidebar-width, so the column has one source of truth.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-sidebar-width', `${chatSidebarColumnWidth(layout)}px`);
    return () => {
      root.style.removeProperty('--chat-sidebar-width');
      // A drag that ends because the component unmounted must not leave the
      // whole document stuck in "no text selection".
      root.classList.remove('is-resizing-chat-sidebar');
    };
  }, [layout]);

  // Breakpoints: ≤1180px defaults to 280px (fresh state only), ≤1080px
  // auto-collapses. Crossing back above 1080px restores an auto-collapse.
  useEffect(() => {
    const onViewportResize = () => {
      const current = layoutRef.current;
      const next = applyViewportWidth(window.innerWidth, current, autoCollapsedRef.current);
      autoCollapsedRef.current = next.autoCollapsed;
      if (next.layout.collapsed !== current.collapsed || next.layout.width !== current.width) {
        applyLayout(next.layout, false);
      }
    };
    window.addEventListener('resize', onViewportResize);
    onViewportResize();
    return () => window.removeEventListener('resize', onViewportResize);
  }, [applyLayout]);

  const toggleCollapsed = useCallback(() => {
    autoCollapsedRef.current = false;
    const current = layoutRef.current;
    applyLayout({ width: current.width, collapsed: !current.collapsed }, true);
  }, [applyLayout]);

  // ⌘B / Ctrl+B toggles the column from anywhere in the app (task §6). The
  // shortcut is a view preference only: nothing is sent to the engine, and the
  // previous width is restored on expand because the width lives in the layout.
  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') {
        return;
      }
      event.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [toggleCollapsed]);

  const resetWidth = () => {
    applyLayout({ width: CHAT_SIDEBAR_DEFAULT_WIDTH, collapsed: false }, true);
  };

  const onSplitterPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || layoutRef.current.collapsed) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: layoutRef.current.width,
      width: layoutRef.current.width,
    };
    document.documentElement.classList.add('is-resizing-chat-sidebar');
  };

  const onSplitterPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null || drag.pointerId !== event.pointerId) {
      return;
    }
    const width = dragChatSidebarWidth(drag.startWidth, event.clientX - drag.startX);
    if (width === drag.width) {
      return;
    }
    drag.width = width;
    // Updated straight on the CSS variable: the list never re-renders mid-drag,
    // so the resize stays frame-accurate (no transition, no layout jitter).
    document.documentElement.style.setProperty('--chat-sidebar-width', `${width}px`);
    event.currentTarget.setAttribute('aria-valuenow', String(width));
  };

  const onSplitterPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null) {
      return;
    }
    dragRef.current = null;
    document.documentElement.classList.remove('is-resizing-chat-sidebar');
    if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    applyLayout({ width: drag.width, collapsed: false }, true);
  };

  const onSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const width = layoutRef.current.width;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      applyLayout({ width: nudgeChatSidebarWidth(width, -1), collapsed: false }, true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      applyLayout({ width: nudgeChatSidebarWidth(width, 1), collapsed: false }, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetWidth();
    }
  };

  const selectedId = route.name === 'chat' ? route.id : null;
  const activeChat =
    selectedId != null ? (chats.find((chat) => chat.chat_id === selectedId) ?? null) : null;

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
                <UserRound size={14} weight={selectedId === chat.chat_id ? 'Filled' : 'Outline'} />
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
            {/* Fixed-width slot: the badge keeps its intrinsic width and stays
                flush right inside it, while the slot gives the hover archive
                chip a deterministic left edge to step in front of (brand.css). */}
            {unreadCount > 0 && selectedId !== chat.chat_id && (
              <span className="chat-item__unread-slot">
                <span className="chat-item__unread" aria-label={`${unreadCount} 条未读消息`}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
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

  if (layout.collapsed) {
    // Collapsed: a 12px clickable strip is all that is left of the column. The
    // rail keeps its place and the chat area takes the freed width.
    return (
      <aside
        id="chat-sidebar-column"
        className="chat-sidebar chat-sidebar--collapsed"
        aria-label="群聊列表（已收起）"
      >
        <button
          type="button"
          className="chat-sidebar__strip"
          aria-label="展开会话列表"
          aria-expanded={false}
          aria-keyshortcuts="Control+B Meta+B"
          title="展开会话列表（⌘B / Ctrl+B）"
          onClick={toggleCollapsed}
        >
          <PanelLeftOpen size={12} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside id="chat-sidebar-column" className="chat-sidebar" aria-label="群聊列表">
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
        <button
          type="button"
          className="chat-sidebar__collapse"
          aria-label="收起会话列表"
          title="收起会话列表"
          onClick={toggleCollapsed}
        >
          <PanelLeftClose size={15} aria-hidden="true" />
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

      {/*
        Status strip: one row per agent with the live state text from
        `chat_status`, always visible at the foot of the list column (task §4).
      */}
      <SidebarStatusStrip chatId={selectedId} chat={activeChat} />

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

      {/*
        Collapse button on the divider itself (design preview: the chevron sits
        in the middle of the sash and appears on hover/focus). It is a sibling
        of the separator, not a child, so it never starts a drag and the
        separator keeps a clean role="separator" widget.
      */}
      <button
        type="button"
        className="chat-sidebar__sash-collapse"
        aria-label="收起会话列表"
        aria-expanded={true}
        aria-controls="chat-sidebar-column"
        aria-keyshortcuts="Control+B Meta+B"
        title="收起会话列表（⌘B / Ctrl+B）"
        onClick={toggleCollapsed}
      >
        <PanelLeftClose size={12} aria-hidden="true" />
      </button>

      {/*
        Resize separator: an 8px hit area inside the sidebar's right edge with a
        1px visible line — it draws the divider that used to be the sidebar's
        border-right, so the resting line and the hover state are the same
        pixel. Pointer capture keeps the drag working over the chat area;
        ←/→ = ±16px, Home / double-click = 336px.
      */}
      <div
        className="chat-sidebar__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话列表宽度"
        aria-valuenow={layout.width}
        aria-valuemin={CHAT_SIDEBAR_MIN_WIDTH}
        aria-valuemax={CHAT_SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={onSplitterPointerEnd}
        onPointerCancel={onSplitterPointerEnd}
        onKeyDown={onSplitterKeyDown}
        onDoubleClick={resetWidth}
      />
    </aside>
  );
}
