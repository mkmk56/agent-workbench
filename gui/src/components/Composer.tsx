import { CircleAlert, CornerUpLeft, Paperclip, Send, Smile, Timer, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { sendChatMessage, uploadChatFiles, type ChatStatus } from '../lib/chat';
import {
  readDraft,
  writeDraft,
  type PanelStorage,
} from '../lib/chat-panels';
import {
  CHAT_QUEUE_LIMIT,
  chipText,
  enqueueMessage,
  insertIntoDraft,
  readQueue,
  removeMessage,
  roundBlocksAutoSend,
  shouldFlush,
  writeQueue,
  type ChatQueueStorage,
  type QueuedMessage,
} from '../lib/chat-queue';
import { insertMentionAt, type MentionRequest } from '../lib/mention-menu';
import type { ChatAgentId } from '../types';
import { AttachmentBar, type AttachmentDraft } from './AttachmentBar';

const MAX_HEIGHT = 160;
const MAX_FILES = 10;

const EMOJIS = [
  '👍', '👏', '🙏', '😀', '😄', '😂', '🤔', '😮',
  '😢', '😡', '❤️', '🔥', '🎉', '🚀', '✅', '❌',
  '👀', '💡', '⚠️', '📌', '📎', '☕', '👌', '🙌',
];

const MENTIONABLES: { id: ChatAgentId; name: string }[] = [
  { id: 'muse', name: 'Muse' },
  { id: 'claude', name: 'Claude' },
  { id: 'dsh', name: 'dsh' },
];

let draftCounter = 0;
function nextDraftId(): string {
  draftCounter += 1;
  return `draft-${Date.now()}-${draftCounter}`;
}

function nextClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextQueueId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseMentions(text: string): ChatAgentId[] {
  const found: ChatAgentId[] = [];
  for (const match of text.matchAll(/@(muse|claude|dsh)/gi)) {
    const id = match[1].toLowerCase() as ChatAgentId;
    if (!found.includes(id)) {
      found.push(id);
    }
  }
  return found;
}

/** The three chat participants' real states, in a stable order. */
function agentStatesOf(status: ChatStatus | null): string[] {
  if (status == null) {
    return [];
  }
  return [status.muse.state, status.claude.state, status.dsh.state];
}

/** localStorage, or null when the context forbids it. */
function queueStorage(): ChatQueueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Same storage contract as the sidebar layout and the queue. */
function draftStorage(): PanelStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Chat composer (Muse, group-chat upgrade).
 *
 * Enter sends, Shift+Enter inserts a newline. Attach button / drag-drop / paste
 * stage files in the bar above the input; files upload when the message is
 * sent, and a failed send keeps both the text and the staged files. @ opens the
 * member picker; the picked members travel as mentions, otherwise all three
 * agents respond.
 *
 * Task §2 — the queue chip: with text in the box, Tab moves it into a local
 * queue instead of sending, so a running round is not interrupted. Each chip
 * can be put back into the input ("插入") or deleted. Queued text flushes by
 * itself when the round that was running finishes — the "finished" signal is
 * the per-agent state in `chat_status`, so a chat the engine reports as still
 * waiting keeps holding instead of guessing. A queue item is only dropped once
 * `sendChatMessage` returned ok; a failed auto-send keeps it and shows the real
 * error, so the UI never claims a message was delivered when it was not.
 */
export function Composer({
  chatId,
  status,
  onSent,
  mentionRequest = null,
  replyTo = null,
  onClearReply,
}: {
  chatId: string;
  status: ChatStatus | null;
  onSent: () => void | Promise<void>;
  /** "@ this agent" pick from the message stream; inserted at the caret. */
  mentionRequest?: MentionRequest | null;
  /** Phase 4 [H]: the message this draft is replying to (chat_recall window). */
  replyTo?: { messageId: string; from: string; summary: string } | null;
  onClearReply?: () => void;
}) {
  // Draft text is per chat and survives a switch / restart (Phase 4 [H]).
  const [text, setText] = useState(() => readDraft(draftStorage(), chatId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [showEmoji, setShowEmoji] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>(() => readQueue(queueStorage(), chatId));
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef(text);
  const draftsRef = useRef(drafts);
  const queueRef = useRef(queue);
  const sendingRef = useRef(sending);
  const sawRoundRef = useRef(false);
  draftsRef.current = drafts;
  queueRef.current = queue;
  sendingRef.current = sending;

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Persist the draft per chat. The composer is remounted on every chat switch,
  // so the initial state above re-reads exactly this chat's draft.
  useEffect(() => {
    writeDraft(draftStorage(), chatId, text);
  }, [chatId, text]);

  // The queue is a view-layer preference (like the sidebar layout): it lives in
  // localStorage per chat so switching pages does not silently drop it.
  useEffect(() => {
    writeQueue(queueStorage(), chatId, queue);
  }, [chatId, queue]);

  useEffect(() => {
    const element = textareaRef.current;
    if (element == null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const lastMentionSeq = useRef(0);

  // Muse: right-clicking an agent avatar in the message stream asks the
  // composer to drop `@handle ` in at the caret and take focus back so the user
  // can keep typing. `seq` makes two picks of the same agent distinct, and a
  // request addressed to another chat is ignored (the composer is remounted per
  // chat, so it can never land in the wrong draft). The handle comes from
  // `MENTION_HANDLES`, i.e. exactly what the parser and the colouring already
  // understand — no new @ format is introduced here.
  useEffect(() => {
    if (mentionRequest == null || mentionRequest.chatId !== chatId) {
      return;
    }
    if (mentionRequest.seq <= lastMentionSeq.current) {
      return;
    }
    lastMentionSeq.current = mentionRequest.seq;
    const element = textareaRef.current;
    const value = textRef.current;
    const insertion = insertMentionAt(
      value,
      mentionRequest.agent,
      element != null
        ? {
            start: element.selectionStart ?? value.length,
            end: element.selectionEnd ?? value.length,
          }
        : undefined,
    );
    setText(insertion.text);
    setError(null);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }, [mentionRequest, chatId]);

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) {
      return;
    }
    setDrafts((current) => {
      const room = MAX_FILES - current.length;
      const accepted = incoming.slice(0, Math.max(0, room));
      if (accepted.length < incoming.length) {
        setError(`一次最多 ${MAX_FILES} 个附件，多余的未添加。`);
      }
      return [
        ...current,
        ...accepted.map((file) => ({
          id: nextDraftId(),
          file,
          progress: 0,
          status: 'ready' as const,
        })),
      ];
    });
  };

  const removeDraft = (id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  };

  const updateDraft = (id: string, patch: Partial<AttachmentDraft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );
  };

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /@([A-Za-z]*)$/.exec(before);
    if (match == null) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(match[1].toLowerCase());
    setMentionIndex(0);
  };

  const mentionMatches = MENTIONABLES.filter(
    (agent) =>
      mentionQuery != null && agent.name.toLowerCase().startsWith(mentionQuery),
  );

  const applyMention = (agent: { id: ChatAgentId; name: string }) => {
    const element = textareaRef.current;
    const value = textRef.current;
    const caret = element?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = /@([A-Za-z]*)$/.exec(before);
    if (match == null) {
      return;
    }
    const next = `${before.slice(0, match.index)}@${agent.name} ${value.slice(caret)}`;
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      element?.focus();
      const pos = match.index + agent.name.length + 2;
      element?.setSelectionRange(pos, pos);
    });
  };

  const insertEmoji = (emoji: string) => {
    const element = textareaRef.current;
    const value = textRef.current;
    const caret = element?.selectionStart ?? value.length;
    const next = `${value.slice(0, caret)}${emoji}${value.slice(caret)}`;
    setText(next);
    setShowEmoji(false);
    requestAnimationFrame(() => {
      element?.focus();
      const pos = caret + emoji.length;
      element?.setSelectionRange(pos, pos);
    });
  };

  /**
   * `override` sends a queued message verbatim; without it the input box is the
   * source (the normal Enter / button path). Returns true only when the engine
   * accepted the message.
   */
  const send = useCallback(
    async (override?: string): Promise<boolean> => {
      const draft = (override ?? textRef.current).trim();
      const staged = draftsRef.current;
      if ((draft.length === 0 && staged.length === 0) || sendingRef.current) {
        return false;
      }
      setSending(true);
      setError(null);
      const mentions = parseMentions(draft);
      const summary =
        draft.length > 0
          ? draft
          : `发送了 ${staged.length} 个附件：${staged.map((item) => item.file.name).join('、')}`;

      // Upload staged files first; already-uploaded drafts are reused on retry.
      let fileIds = staged
        .filter((item) => item.status === 'done' && item.fileId != null)
        .map((item) => item.fileId as string);
      const toUpload = staged.filter((item) => item.status === 'ready' || item.status === 'failed');
      if (toUpload.length > 0) {
        for (const item of toUpload) {
          updateDraft(item.id, { status: 'uploading', progress: 0, error: undefined });
        }
        const upload = await uploadChatFiles(
          toUpload.map((item) => item.file),
          (index, progress) => updateDraft(toUpload[index].id, { progress }),
          chatId,
        );
        if (!upload.ok) {
          for (const item of toUpload) {
            updateDraft(item.id, { status: 'failed', error: upload.error });
          }
          setError(upload.error);
          setSending(false);
          return false;
        }
        upload.data.file_ids.forEach((fileId, index) => {
          updateDraft(toUpload[index].id, { status: 'done', progress: 1, fileId });
        });
        fileIds = [...fileIds, ...upload.data.file_ids];
      }

      const result = await sendChatMessage({
        chatId,
        from: 'user',
        to: 'muse',
        summary,
        files: fileIds.length > 0 ? fileIds : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        replyTo: replyTo?.messageId,
        clientMsgId: nextClientMsgId(),
      });
      setSending(false);
      if (!result.ok) {
        // Text and staged files are kept: retry reuses the uploaded file_ids.
        setError(result.error);
        return false;
      }
      if (override == null && textRef.current.trim() === draft) {
        setText('');
        writeDraft(draftStorage(), chatId, '');
      }
      setDrafts([]);
      setMentionQuery(null);
      onClearReply?.();
      await onSent();
      return true;
    },
    [chatId, onSent, replyTo, onClearReply],
  );

  const roundBlocked = useMemo(() => {
    // A round counts as unfinished while an agent is queued/starting/working,
    // or while the chat is waiting on someone (muse "等 Muse 回复", or an agent
    // waiting for the user). Auto-send only fires after that clears.
    return roundBlocksAutoSend(agentStatesOf(status));
  }, [status]);

  // Tab moved text into the queue while a round runs: flush one item per round
  // that actually finishes, and only after a round was observed running. The
  // latch stops a single idle poll window (status lags a send by 3–5 s) from
  // firing every queued line at once.
  useEffect(() => {
    if (roundBlocked) {
      sawRoundRef.current = true;
      return;
    }
    const item = shouldFlush(queueRef.current, {
      blocked: false,
      sawBusy: sawRoundRef.current,
    });
    if (item == null || sendingRef.current) {
      return;
    }
    sawRoundRef.current = false;
    void (async () => {
      const sent = await send(item.text);
      if (sent) {
        setQueue((current) => removeMessage(current, item.id));
        setQueueNotice(null);
      } else {
        // Keep the item; wait for the next finished round instead of looping.
        sawRoundRef.current = true;
      }
    })();
  }, [roundBlocked, queue, send]);

  const queueDraft = () => {
    const draft = textRef.current.trim();
    if (draft.length === 0) {
      return;
    }
    const result = enqueueMessage(queueRef.current, draft, {
      id: nextQueueId(),
      armed: roundBlocked,
      now: Date.now(),
    });
    if (result.added == null) {
      setQueueNotice(
        result.rejected === 'full'
          ? `排队最多 ${CHAT_QUEUE_LIMIT} 条，先发一条或删除一条。`
          : result.rejected === 'duplicate'
            ? '同样的内容已经在排队了。'
            : null,
      );
      return;
    }
    setQueue(result.queue);
    setQueueNotice(null);
    setText('');
    setMentionQuery(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const insertQueued = (id: string) => {
    const result = insertIntoDraft(queueRef.current, id, textRef.current);
    if (result.inserted == null) {
      return;
    }
    setQueue(result.queue);
    setText(result.text);
    setQueueNotice(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      element?.focus();
      element?.setSelectionRange(result.text.length, result.text.length);
    });
  };

  const dropQueued = (id: string) => {
    setQueue((current) => removeMessage(current, id));
    setQueueNotice(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery != null && mentionMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (index) => (index - 1 + mentionMatches.length) % mentionMatches.length,
        );
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        applyMention(mentionMatches[mentionIndex] ?? mentionMatches[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    // Tab queues the current text instead of sending it. Only when there is
    // text and the mention picker is closed, so an empty composer keeps the
    // normal Tab (leave the field) behaviour for keyboard users.
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      mentionQuery == null &&
      textRef.current.trim().length > 0
    ) {
      event.preventDefault();
      queueDraft();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    if (event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void send();
  };

  const onChange = (value: string, caret: number) => {
    setText(value);
    updateMention(value, caret);
    if (error != null) {
      setError(null);
    }
  };

  const canSend =
    (text.trim().length > 0 || drafts.length > 0) && !sending;

  return (
    <form
      className={`chat-composer${dragOver ? ' chat-composer--drag-over' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        addFiles(event.dataTransfer.files);
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
      {queue.length > 0 && (
        <div className="chat-queue" role="list" aria-label="排队中的消息">
          {queue.map((item) => (
            <div className="chat-queue__chip" role="listitem" key={item.id}>
              <span className="chat-queue__icon" aria-hidden="true">
                <Timer size={13} />
              </span>
              <span className="chat-queue__label">排队中</span>
              <span className="chat-queue__text" title={item.text}>
                {chipText(item.text)}
              </span>
              <span className="chat-queue__hint">
                {!item.armed
                  ? '排队时没有进行中的轮次，不会自动发送'
                  : roundBlocked
                    ? '本轮结束后自动发出'
                    : '等待确认轮次结束'}
              </span>
              <button
                type="button"
                className="chat-queue__action"
                aria-label={`把排队消息插回输入框：${chipText(item.text, 40)}`}
                title="插入到输入框"
                onClick={() => insertQueued(item.id)}
              >
                <CornerUpLeft size={13} aria-hidden="true" />
                插入
              </button>
              <button
                type="button"
                className="chat-queue__action chat-queue__action--danger"
                aria-label={`删除排队消息：${chipText(item.text, 40)}`}
                title="删除这条排队消息"
                onClick={() => dropQueued(item.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {queueNotice != null && (
        <p className="chat-queue__notice" role="status">
          {queueNotice}
        </p>
      )}
      <AttachmentBar items={drafts} onRemove={removeDraft} />
      {replyTo != null && (
        <div className="chat-composer__reply" role="note" aria-label="正在回复">
          <CornerUpLeft size={13} aria-hidden="true" />
          <span className="chat-composer__reply-name">{replyTo.from}</span>
          <span className="chat-composer__reply-text">
            {replyTo.summary.length > 80 ? `${replyTo.summary.slice(0, 80)}…` : replyTo.summary}
          </span>
          <button
            type="button"
            className="chat-composer__reply-clear"
            aria-label="取消回复"
            title="取消回复"
            onClick={() => onClearReply?.()}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="chat-composer__field">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="选择附件"
          tabIndex={-1}
          onChange={(event) => {
            if (event.target.files != null) {
              addFiles(event.target.files);
            }
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="chat-composer__attach"
          title="添加附件（可多选；也可直接拖入或粘贴图片）"
          aria-label="添加附件"
          disabled={sending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={16} aria-hidden="true" />
        </button>
        <label className="sr-only" htmlFor="chat-composer-input">
          发消息给 Muse
        </label>
        <textarea
          id="chat-composer-input"
          ref={textareaRef}
          className="chat-composer__input"
          value={text}
          rows={1}
          placeholder="发消息给 Muse，描述你想让 Agent 做的事…（@ 可指定成员，Tab 排队）"
          onChange={(event) =>
            onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files != null && files.length > 0) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          disabled={sending}
        />
        <button
          type="button"
          className="chat-composer__emoji"
          title="插入表情"
          aria-label="插入表情"
          aria-expanded={showEmoji}
          disabled={sending}
          onClick={() => setShowEmoji(!showEmoji)}
        >
          <Smile size={16} aria-hidden="true" />
        </button>
        <button
          type="submit"
          className="chat-composer__send"
          disabled={!canSend}
          aria-label={sending ? '正在发送' : '发送'}
        >
          <Send size={14} aria-hidden="true" />
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {mentionQuery != null && mentionMatches.length > 0 && (
        <ul className="chat-composer__mentions" role="listbox" aria-label="@ 成员">
          {mentionMatches.map((agent, index) => (
            <li key={agent.id} role="option" aria-selected={index === mentionIndex}>
              <button
                type="button"
                className={`chat-mention-item${index === mentionIndex ? ' is-active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyMention(agent);
                }}
              >
                @{agent.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {showEmoji && (
        <div className="chat-composer__emoji-panel" role="dialog" aria-label="选择表情">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`插入表情 ${emoji}`}
              onMouseDown={(event) => {
                event.preventDefault();
                insertEmoji(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}