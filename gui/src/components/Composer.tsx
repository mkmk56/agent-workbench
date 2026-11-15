import { CircleAlert, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { sendChatMessage } from '../lib/chat';

const MAX_HEIGHT = 160;

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, and an empty
 * draft never reaches the engine. Nothing is drawn optimistically: the message
 * enters the stream only after `send_chat_message` confirms it, via onSent().
 */
export function Composer({
  chatId,
  onSent,
}: {
  chatId: string;
  onSent: () => void | Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    const element = textareaRef.current;
    if (element == null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const send = async () => {
    const draft = textRef.current.trim();
    if (draft.length === 0 || sending) {
      return;
    }
    setSending(true);
    setError(null);
    const result = await sendChatMessage({
      chatId,
      from: 'user',
      to: 'muse',
      summary: draft,
    });
    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Keep anything typed while the request was in flight.
    if (textRef.current.trim() === draft) {
      setText('');
    }
    await onSent();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    if (event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void send();
  };

  const onChange = (value: string) => {
    setText(value);
    if (error != null) {
      setError(null);
    }
  };

  const canSend = text.trim().length > 0 && !sending;

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error != null && (
        <div className="chat-composer__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>发送失败：{error}</span>
          <button type="button" className="chat-composer__retry" onClick={() => void send()}>
            重试
          </button>
        </div>
      )}
      <div className="chat-composer__field">
        <label className="sr-only" htmlFor="chat-composer-input">
          发消息给 Muse
        </label>
        <textarea
          id="chat-composer-input"
          ref={textareaRef}
          className="chat-composer__input"
          value={text}
          rows={1}
          placeholder="发消息给 Muse，描述你想让 Agent 做的事…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="chat-composer-hint"
          disabled={sending}
        />
        <button
          type="submit"
          className="btn btn-primary chat-composer__send"
          disabled={!canSend}
          aria-label={sending ? '正在发送' : '发送'}
        >
          <Send size={14} aria-hidden="true" />
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      <div className="chat-composer__foot" id="chat-composer-hint">
        <span className="chat-composer__hint">Enter 发送 · Shift+Enter 换行 · 空白消息不会发送</span>
      </div>
    </form>
  );
}