import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  UserRound,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import type { ChatMessage, ChatSender } from '../lib/chat';
import { formatClock } from '../lib/labels';
import { mentionAgentFor, type MenuPoint } from '../lib/mention-menu';
import type { ChatAgentId } from '../types';
import { EditedFilesCard } from './EditedFilesCard';

const IDENTITIES: Record<
  Exclude<ChatSender, 'user' | 'unknown'>,
  { name: string; mark: string }
> = {
  muse: { name: 'Muse', mark: museMark },
  claude: { name: 'Claude', mark: claudeMark },
  dsh: { name: 'dsh', mark: dshMark },
};

const DELIVERY_STATUS: Record<string, string> = {
  queued: '排队',
  delivered: '已投递',
  stored: '已存储',
  answered: '已回复',
  sent: '已发送',
  pending: '待处理',
  held: '等待回复',
  failed: '投递失败',
};

const MENTION_NAMES: Record<string, string> = {
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

function identityFor(sender: ChatSender): {
  name: string;
  mark: string | null;
  kind: 'agent' | 'user' | 'unknown';
} {
  if (sender === 'user') {
    return { name: '你', mark: null, kind: 'user' };
  }
  if (sender === 'unknown') {
    return { name: '未知发送者', mark: null, kind: 'unknown' };
  }
  const identity = IDENTITIES[sender];
  return { name: identity.name, mark: identity.mark, kind: 'agent' };
}

function isStructuredPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
 * Lightweight Markdown: fenced code, inline code, bold, bullet and
 * numbered lists, @mentions. Hand-rolled on purpose — no heavy
 * dependency. Raw HTML is never executed; React escapes every text node.
 * ------------------------------------------------------------------ */

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; code: string };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list != null && list.items.length > 0) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    }
    list = null;
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (code != null) {
      if (FENCE.test(line)) {
        blocks.push({ type: 'code', code: code.join('\n') });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      flushText();
      code = [];
      continue;
    }
    if (line.trim().length === 0) {
      flushText();
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet != null || ordered != null) {
      flushParagraph();
      const isOrdered = ordered != null;
      if (list == null || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((isOrdered ? ordered?.[1] : bullet?.[1]) ?? '');
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code != null) {
    blocks.push({ type: 'code', code: code.join('\n') });
  }
  flushText();
  return blocks;
}

// `@muse` must be a whole handle: the lookarounds stop `@musex` (or an address
// like `foo@muse`) from being coloured as a mention of `muse`. Unknown handles
// keep their plain-text fallback, which `mentionIdFor` already handles.
const INLINE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![A-Za-z0-9_])@[Mm]use(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])@[Cc]laude(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])@[Dd]sh(?![A-Za-z0-9_]))/g;

/** Identity handle behind an @mention, so the token layer can colour it. */
function mentionIdFor(token: string): 'muse' | 'claude' | 'dsh' | null {
  const handle = token.slice(1).toLowerCase();
  if (handle === 'muse' || handle === 'claude' || handle === 'dsh') {
    return handle;
  }
  return null;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="chat-md__code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="chat-md__strong">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const mentionId = mentionIdFor(token);
      const name = MENTION_NAMES[mentionId ?? ''] ?? token.slice(1);
      nodes.push(
        <span
          key={key}
          // Identity colours come from the --color-bubble-* tokens (Muse's token
          // layer, d09c428): no new colour values are invented here.
          className={`chat-mention${mentionId != null ? ` chat-mention--${mentionId}` : ''}`}
          data-mention={mentionId ?? undefined}
        >
          @{name}
        </span>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard != null) {
        await navigator.clipboard.writeText(code);
      } else if (window.workbench) {
        await window.workbench.copyText(code);
      } else {
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the button just stays in its default state.
    }
  };
  return (
    <div className="chat-md__codeblock">
      <button
        type="button"
        className="chat-md__copy"
        onClick={() => void copy()}
        aria-label="复制代码"
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="chat-md__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="chat-md">
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;
        if (block.type === 'code') {
          return <CodeBlock key={key} code={block.code} />;
        }
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ));
          return block.ordered ? (
            <ol key={key} className="chat-md__list">
              {items}
            </ol>
          ) : (
            <ul key={key} className="chat-md__list">
              {items}
            </ul>
          );
        }
        return (
          <p key={key} className="chat-md__p">
            {renderInline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Message avatar. Right-clicking an agent avatar opens the "insert @handle"
 * menu (Muse); the user's own avatar and unknown senders stay inert.
 */
function Avatar({
  sender,
  onMentionAgent,
}: {
  sender: ChatSender;
  onMentionAgent?: (agent: ChatAgentId, point: MenuPoint) => void;
}) {
  const identity = identityFor(sender);
  const mentionable = onMentionAgent != null ? mentionAgentFor(sender) : null;
  return (
    <span
      className={`chat-avatar chat-avatar--md chat-avatar--${identity.kind === 'agent' ? sender : identity.kind}`}
      aria-hidden="true"
      title={mentionable != null ? `${identity.name}（右键 @）` : identity.name}
      data-mention-agent={mentionable ?? undefined}
      onContextMenu={
        mentionable == null || onMentionAgent == null
          ? undefined
          : (event) => {
              // Custom menu instead of Electron's native one (Muse).
              event.preventDefault();
              event.stopPropagation();
              onMentionAgent(mentionable, { x: event.clientX, y: event.clientY });
            }
      }
    >
      {identity.mark != null ? (
        <img src={identity.mark} alt="" draggable={false} />
      ) : identity.kind === 'user' ? (
        <UserRound size={15} strokeWidth={2} />
      ) : (
        <Bot size={15} strokeWidth={2} />
      )}
    </span>
  );
}

/**
 * Attachments of one message, rendered as the "Edited files" card (P0-5
 * scheme B): one flat row per file with its full path, a real summary and the
 * parse status. The file objects have already been merged with
 * `list_chat_files` by the page.
 */
function MessageFiles({
  files,
  chatId,
  from,
}: {
  files: ChatMessage['files'];
  chatId: string;
  from: 'user' | 'agent';
}) {
  if (files.length === 0) {
    return null;
  }
  return <EditedFilesCard files={files} chatId={chatId} from={from} />;
}

function StructuredNotice() {
  return (
    <div className="chat-structured" role="note">
      <CircleAlert size={14} aria-hidden="true" />
      <span>引擎返回了结构化内容，聊天流不展示原始 JSON、工具参数或日志。</span>
    </div>
  );
}

const FOLD_CHARS = 1200;
const FOLD_LINES = 30;
const QUOTE_CHARS = 140;

/**
 * Quoted message block (MESSAGE_PROTOCOL.md §3): the quote carries the quoted
 * agent's identity colour from the --color-bubble-* tokens. When the quoted
 * message is not in the loaded window the block says so instead of inventing a
 * preview.
 */
function QuoteBlock({
  quoted,
  replyTo,
}: {
  quoted: ChatMessage | null;
  replyTo: string | null;
}) {
  const senderId = quoted?.from ?? 'unknown';
  const name =
    quoted == null
      ? '引用的消息'
      : identityFor(quoted.from).name;
  const text =
    quoted == null
      ? '不在已加载的消息范围内'
      : quoted.summary.length > QUOTE_CHARS
        ? `${quoted.summary.slice(0, QUOTE_CHARS)}…`
        : quoted.summary;
  return (
    <div
      className={`chat-quote chat-quote--${senderId}`}
      data-reply-to={replyTo ?? undefined}
      role="note"
      aria-label={`引用 ${name} 的消息`}
    >
      <span className="chat-quote__name">{name}</span>
      <span className="chat-quote__text">{text.length > 0 ? text : '（无文字）'}</span>
    </div>
  );
}

export function MessageBubble({
  message,
  chatId,
  quoted,
  onMentionAgent,
}: {
  message: ChatMessage;
  chatId: string;
  /** Message referenced by `reply_to`, resolved by the stream (null: not loaded). */
  quoted?: ChatMessage | null;
  /** Right-click on an agent avatar: open the "@ this agent" menu. */
  onMentionAgent?: (agent: ChatAgentId, point: MenuPoint) => void;
}) {
  const identity = identityFor(message.from);
  const isUser = identity.kind === 'user';
  const structured = isStructuredPayload(message.summary);
  const statusLabel = message.status != null ? DELIVERY_STATUS[message.status] : null;
  const failed = message.status === 'failed';
  const long =
    message.summary.length > FOLD_CHARS ||
    message.summary.split('\n').length > FOLD_LINES;
  const [folded, setFolded] = useState(long);

  return (
    <article
      className={`chat-msg chat-msg--${isUser ? 'user' : 'agent'}`}
      data-sender={message.from}
    >
      <Avatar sender={message.from} onMentionAgent={onMentionAgent} />
      <div className="chat-msg__body">
        <div className="chat-msg__meta">
          <span className="chat-msg__sender">{identity.name}</span>
          {message.created_at.length > 0 && (
            <time dateTime={message.created_at}>{formatClock(message.created_at)}</time>
          )}
          {statusLabel != null && (
            <span className={`chat-msg__status${failed ? ' is-error' : ''}`}>{statusLabel}</span>
          )}
        </div>
        <div className={`chat-bubble${failed ? ' chat-bubble--failed' : ''}${folded ? ' chat-bubble--folded' : ''}`}>
          {message.reply_to != null && message.reply_to.length > 0 && (
            <QuoteBlock quoted={quoted ?? null} replyTo={message.reply_to} />
          )}
          {message.summary.length === 0 ? (
            <span className="chat-bubble__empty">（这条消息没有文字摘要）</span>
          ) : structured ? (
            <StructuredNotice />
          ) : (
            <RichText text={message.summary} />
          )}
          {message.question != null && (
            <div className="conv-question">
              <strong>需要回答</strong>
              <p>{message.question}</p>
            </div>
          )}
        </div>
        {/*
          The attachment/edit card sits under the bubble, not inside it: a panel
          inside a bubble would be a card inside a card (VISUAL_SCHEME.md §5).
        */}
        <MessageFiles
          files={message.files}
          chatId={chatId}
          from={isUser ? 'user' : 'agent'}
        />
        {long && (
          <button
            type="button"
            className="chat-msg__fold"
            onClick={() => setFolded(!folded)}
            aria-expanded={!folded}
          >
            {folded ? (
              <>
                <ChevronDown size={13} aria-hidden="true" />
                展开全文
              </>
            ) : (
              <>
                <ChevronUp size={13} aria-hidden="true" />
                收起
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
