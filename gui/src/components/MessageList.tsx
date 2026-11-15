import { MessageSquare, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../lib/chat';
import { MessageBubble } from './MessageBubble';

/**
 * Message stream for one chat. Keeps the viewport pinned to the newest message
 * only while the reader is already near the bottom, so reading history is not
 * interrupted by the 3-second poll.
 */
export function MessageList({
  chatId,
  messages,
  loading,
  error,
  onRetry,
}: {
  chatId: string;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
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
        ) : messages.length > 0 ? (
          messages.map((message) => (
            <MessageBubble key={message.message_id} message={message} />
          ))
        ) : error == null ? (
          <div className="chat-empty chat-empty--inline">
            <span className="chat-empty__icon" aria-hidden="true">
              <MessageSquare size={32} strokeWidth={1.6} />
            </span>
            <h2 className="chat-empty__title">还没有消息</h2>
            <p className="chat-empty__desc">
              在下方发送第一条消息，Muse 会读完后拆分任务并分配给 Agent。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}