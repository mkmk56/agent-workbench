import {
  ChevronUp,
  MessageSquare,
  RefreshCw,
} from '../ui/icons';
import { useEffect, useMemo, useRef } from 'react';
import { buildChatStream, type StreamItem } from '../lib/chat-panels';
import type { ChatMessage, ChatStatus } from '../lib/chat';
import { AGENT_STATE_LABELS } from '../lib/chat';
import type { MenuPoint } from '../lib/mention-menu';
import type { ChatAgentId } from '../types';
import { MessageBubble } from './MessageBubble';

const THINKING_STATES = new Set(['working', 'starting', 'waiting']);

const THINKING_AGENTS = ['muse', 'claude', 'dsh'] as const;

const THINKING_NAMES: Record<(typeof THINKING_AGENTS)[number], string> = {
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

/**
 * Message stream for one chat. Keeps the viewport pinned to the newest message
 * only while the reader is already near the bottom, so reading history is not
 * interrupted by the store's polling. Messages carry their attachments as
 * full ChatFile objects (already merged with `list_chat_files` by the page), so
 * each bubble renders one "Edited files" card below it.
 *
 * Phase 4 adds: a day separator, same-sender grouping, the "hide system
 * messages" filter and a top "load earlier" button that consumes the engine's
 * `has_more`/`before` paging instead of pretending the first page is all.
 */
export function MessageList({
  chatId,
  messages,
  status,
  loading,
  error,
  searchQuery = '',
  hideSystem = false,
  hasMore = false,
  loadingEarlier = false,
  onRetry,
  onLoadEarlier,
  onMentionAgent,
  onReply,
  onOpenTask,
  onRecall,
  canRecall,
}: {
  chatId: string;
  messages: ChatMessage[];
  status: ChatStatus | null;
  loading: boolean;
  error: string | null;
  searchQuery?: string;
  /** Phase 4 [B]: hide `kind === 'system'` rows (preference owned by the page). */
  hideSystem?: boolean;
  hasMore?: boolean;
  loadingEarlier?: boolean;
  onRetry: () => void;
  onLoadEarlier?: () => void;
  /** Right-click on an agent avatar: open the "@ this agent" menu. */
  onMentionAgent?: (agent: ChatAgentId, point: MenuPoint) => void;
  onReply?: (message: ChatMessage) => void;
  onOpenTask?: (taskId: string) => void;
  onRecall?: (message: ChatMessage) => void;
  canRecall?: (message: ChatMessage) => boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);
  const pendingRestore = useRef<{ height: number; top: number } | null>(null);

  useEffect(() => {
    stick.current = true;
    lastCount.current = 0;
    pendingRestore.current = null;
  }, [chatId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element == null) {
      return;
    }
    // Loading older history prepends rows; keep the reader on the message they
    // were looking at instead of jumping to the inserted page.
    const restore = pendingRestore.current;
    if (restore != null) {
      pendingRestore.current = null;
      element.scrollTop = element.scrollHeight - restore.height + restore.top;
      lastCount.current = element.childElementCount;
      return;
    }
    const grew = messages.length !== lastCount.current;
    lastCount.current = messages.length;
    if (grew && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const loadEarlier = () => {
    const element = scrollRef.current;
    if (element != null) {
      pendingRestore.current = {
        height: element.scrollHeight,
        top: element.scrollTop,
      };
    }
    onLoadEarlier?.();
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (element == null) {
      return;
    }
    stick.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  // Inline search filters the loaded messages; the thinking indicator is
  // hidden while searching so the stream shows only matches.
  const needle = searchQuery.trim().toLowerCase();
  const visibleMessages =
    needle.length === 0
      ? messages
      : messages.filter((message) => message.summary.toLowerCase().includes(needle));

  const stream: StreamItem[] = useMemo(
    () => buildChatStream(visibleMessages, { hideSystem }),
    [visibleMessages, hideSystem],
  );

  // reply_to carries the message id (MESSAGE_PROTOCOL.md §3); older engines only
  // sent the seq, so both are indexed. A miss simply means "not loaded yet".
  const quotedIndex = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const message of messages) {
      map.set(message.message_id, message);
      map.set(String(message.seq), message);
    }
    return map;
  }, [messages]);

  return (
    <div className="chat-stream-wrap">
      {error != null && (
        <div className="chat-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            <RefreshCw size={12} aria-hidden="true" />
            重试
          </button>
        </div>
      )}
      <div
        className="chat-stream"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="群聊消息"
        aria-busy={loading && messages.length === 0}
      >
        {hasMore && needle.length === 0 && (
          <div className="chat-stream__earlier">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={loadingEarlier}
              onClick={loadEarlier}
            >
              <ChevronUp size={13} aria-hidden="true" />
              {loadingEarlier ? '加载中…' : '加载更早消息'}
            </button>
          </div>
        )}
        {loading && messages.length === 0 ? (
          <p className="chat-stream__status" role="status">
            正在读取消息…
          </p>
        ) : stream.length > 0 ? (
          <>
            {stream.map((item) =>
              item.type === 'day' ? (
                <div className="chat-day" key={item.key} role="separator">
                  <span>{item.label}</span>
                </div>
              ) : (
                <MessageBubble
                  key={item.key}
                  message={item.message}
                  chatId={chatId}
                  grouped={item.grouped}
                  onMentionAgent={onMentionAgent}
                  onReply={onReply}
                  onOpenTask={onOpenTask}
                  onRecall={onRecall}
                  canRecall={canRecall?.(item.message) ?? false}
                  quoted={
                    item.message.reply_to != null
                      ? (quotedIndex.get(item.message.reply_to) ?? null)
                      : null
                  }
                />
              ),
            )}
            {needle.length === 0 &&
              status != null &&
              THINKING_AGENTS.filter((id) => {
                const state = status[id]?.state;
                return state != null && THINKING_STATES.has(state);
              }).map((id) => {
                const agent = status[id];
                if (agent == null) {
                  return null;
                }
                return (
                  <div key={id} className="chat-thinking" role="status">
                    <span className="chat-thinking__dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    {THINKING_NAMES[id]} {AGENT_STATE_LABELS[agent.state]}…
                  </div>
                );
              })}
          </>
        ) : error == null ? (
          <div className="chat-empty chat-empty--inline">
            <span className="chat-empty__icon" aria-hidden="true">
              <MessageSquare size={32} strokeWidth={1.6} />
            </span>
            <h2 className="chat-empty__title">
              {needle.length > 0 ? '没有匹配的消息' : '还没有消息'}
            </h2>
            <p className="chat-empty__desc">
              {needle.length > 0
                ? `本群聊已加载的消息里没有 “${searchQuery.trim()}”。`
                : '在下方发送第一条消息，Muse 会读完后拆分任务并分配给 Agent。'}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}