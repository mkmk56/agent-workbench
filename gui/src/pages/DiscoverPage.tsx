import {
  CircleAlert,
  Compass,
  Globe,
  RefreshCw,
  Search,
  Tag,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_CATEGORIES,
  UNCATEGORIZED,
  categoryLabel,
  listPublicChatsOnce,
  memberCountLabel,
} from '../lib/community';
import { formatRelative } from '../lib/labels';
import type { ChatCategory, PublicChat } from '../types';
import '../styles/community.css';

const SEARCH_DEBOUNCE_MS = 300;

type CategoryFilter = '' | ChatCategory | typeof UNCATEGORIZED;

const CATEGORY_FILTER_LABEL: Record<string, string> = {
  [UNCATEGORIZED]: '未分类',
};
for (const category of CHAT_CATEGORIES) {
  CATEGORY_FILTER_LABEL[category] = category;
}

/**
 * REA Phase 5 §4.1 — local discovery of public chats (#/discover).
 *
 * Read-only by design (D7, option B): the GUI holds the human token and a human
 * is already in every local chat, so the "申请加入" button is deliberately not
 * rendered — agents discover and apply through MCP (`list_public_chats` +
 * `chat_join_request`). Nothing here is published off this machine; the page
 * says so explicitly, and `list_public_chats` only ever returns metadata.
 */
export function DiscoverPage() {
  const [chats, setChats] = useState<PublicChat[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A slow response from an older query must never overwrite a newer one.
  const requestId = useRef(0);

  const load = useCallback(async (q: string, filter: CategoryFilter) => {
    const id = (requestId.current += 1);
    setLoading(true);
    const trimmed = q.trim();
    const result = await listPublicChatsOnce({
      q: trimmed.length > 0 ? trimmed : undefined,
      category: filter === '' ? undefined : filter,
      limit: 100,
    });
    if (id !== requestId.current) {
      return;
    }
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setChats(result.data.chats);
    setTotal(result.data.total);
  }, []);

  // Search is prefix matching on the engine side (q%); debounce keeps the
  // keystroke stream from turning into one tool call per character.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(query, category);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, category, load]);

  const filterLabel = useMemo(
    () => (category === '' ? '全部分类' : CATEGORY_FILTER_LABEL[category] ?? category),
    [category],
  );

  return (
    <section className="discover-page" aria-label="发现">
      <header className="page-head">
        <div className="page-head__text">
          <h1>发现</h1>
          <p>本机公开群组。仅本机可见，不联网、不对外发布。</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void load(query, category)}
          disabled={loading}
        >
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </header>

      <div className="discover-toolbar">
        <label className="discover-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            maxLength={40}
            placeholder="按群名或描述前缀搜索"
            aria-label="搜索公开群组"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="discover-filter">
          <Tag size={13} aria-hidden="true" />
          <span className="discover-filter__label">分类</span>
          <select
            value={category}
            aria-label="按分类筛选"
            onChange={(event) => setCategory(event.target.value as CategoryFilter)}
          >
            <option value="">全部分类</option>
            <option value={UNCATEGORIZED}>未分类</option>
            {CHAT_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <span className="discover-toolbar__count">
          {filterLabel} · {total} 个群
        </span>
      </div>

      <p className="discover-banner" role="note">
        <Globe size={14} aria-hidden="true" />
        <span>
          仅本机可见，不对外发布。本页只读：GUI 不代 Agent 申请，加入申请由已配对 Agent 通过 MCP
          发起（list_public_chats + chat_join_request）。
        </span>
      </p>

      {error != null && (
        <p className="discover-error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      )}

      {loading && chats.length === 0 ? (
        <p className="discover-status" role="status">
          正在读取本机公开群组…
        </p>
      ) : chats.length === 0 ? (
        <div className="discover-empty">
          <Compass size={30} strokeWidth={1.6} aria-hidden="true" />
          <p>
            {query.trim().length > 0 || category !== ''
              ? '没有符合条件的公开群组。'
              : '还没有本机公开的群组。把某个群的可见性切到「本机公开」后会出现在这里。'}
          </p>
        </div>
      ) : (
        <ul className="discover-grid" aria-label="本机公开群组">
          {chats.map((chat) => (
            <li key={chat.chat_id} className="discover-card">
              <div className="discover-card__head">
                <span className="discover-card__name" title={chat.name}>
                  {chat.name}
                </span>
                <span className="discover-card__category">{categoryLabel(chat.category)}</span>
              </div>
              <p className="discover-card__desc">
                {chat.description != null && chat.description.length > 0
                  ? chat.description
                  : '群主还没有填写描述。'}
              </p>
              <dl className="discover-card__meta">
                <div>
                  <dt>成员</dt>
                  <dd>{memberCountLabel(chat.member_count)}</dd>
                </div>
                <div>
                  <dt>创建</dt>
                  <dd>{chat.created_at != null ? formatRelative(chat.created_at) : '未知'}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      {chats.length > 0 && (
        <p className="discover-footnote">
          只展示元数据（群名、分类、描述、成员数、创建时间），不返回成员列表与消息内容。
        </p>
      )}
    </section>
  );
}