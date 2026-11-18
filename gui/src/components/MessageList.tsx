import { MessageSquare, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage, ChatStatus } from '../lib/chat';
import { AGENT_STATE_LABELS } from '../lib/chat';
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
 */
export function MessageList({
  chatId,
  messages,
  status,
  loading,
  error,
  searchQuery = '',
  onRetry,
}: {
  chatId: string;
  messages: ChatMessage[];
  status: ChatStatus | null;
  loading: boolean;
  error: string | null;
  searchQuery?: string;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  useEffect(() => {
    stick.current = true;
    lastCount.current = 0;
  }, [chatId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element == null) {
      return;
    }
    const grew = messages.length !== lastCount.current;
    lastCount.current = messages.length;
    if (grew && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

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
        {loading && messages.length === 0 ? (
          <p className="chat-stream__status" role="status">
            正在读取消息…
          </p>
        ) : visibleMessages.length > 0 ? (
          <>
            {visibleMessages.map((message) => (
              <MessageBubble
                key={message.message_id}
                message={message}
                chatId={chatId}
                quoted={
                  message.reply_to != null
                    ? (quotedIndex.get(message.reply_to) ?? null)
                    : null
                }
              />
            ))}
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