import {
  Bot,
  CircleAlert,
  FileCode2,
  ScrollText,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import { formatClock } from '../lib/labels';
import type { ChatMessage, ChatSender } from '../lib/chat';

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
 * numbered lists. Hand-rolled on purpose — no heavy dependency. Raw
 * HTML is never executed; React escapes every text node.
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

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

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
    } else {
      nodes.push(
        <strong key={key} className="chat-md__strong">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

export function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="chat-md">
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;
        if (block.type === 'code') {
          return (
            <pre key={key} className="chat-md__pre">
              <code>{block.code}</code>
            </pre>
          );
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

function Avatar({ sender }: { sender: ChatSender }) {
  const identity = identityFor(sender);
  return (
    <span
      className={`chat-avatar chat-avatar--md chat-avatar--${identity.kind}`}
      aria-hidden="true"
      title={identity.name}
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

function FileChips({ files }: { files: string[] }) {
  if (files.length === 0) {
    return null;
  }
  return (
    <ul className="conv-files" aria-label="涉及文件">
      {files.map((file) => (
        <li key={file} className="conv-file">
          <FileCode2 size={12} aria-hidden="true" />
          <span className="mono">{file}</span>
        </li>
      ))}
    </ul>
  );
}

function ExecutionLink({ taskId }: { taskId: string }) {
  return (
    <a
      className="chat-card__link"
      href={`#/tasks/${encodeURIComponent(taskId)}`}
      title="进入隐藏的任务详情调试页"
    >
      <ScrollText size={12} aria-hidden="true" />
      查看执行记录
    </a>
  );
}

function StructuredNotice({ taskId }: { taskId: string | null }) {
  return (
    <div className="chat-structured" role="note">
      <CircleAlert size={14} aria-hidden="true" />
      <span>引擎返回了结构化内容，聊天流不展示原始 JSON、工具参数或日志。</span>
      {taskId != null && <ExecutionLink taskId={taskId} />}
    </div>
  );
}

function ConclusionCard({ message }: { message: ChatMessage }) {
  const structured = isStructuredPayload(message.summary);
  const statusLabel = message.status != null ? DELIVERY_STATUS[message.status] : null;
  const failed = message.status === 'failed';
  return (
    <article
      className={`chat-card${failed ? ' chat-card--failed' : ''}`}
      aria-label="Agent 结论"
    >
      <header className="chat-card__head">
        <span className="chat-card__eyebrow">结论</span>
        {statusLabel != null && (
          <span className={`chat-card__status${failed ? ' is-error' : ''}`}>{statusLabel}</span>
        )}
      </header>
      {message.summary.length > 0 &&
        (structured ? (
          <StructuredNotice taskId={message.task_id ?? null} />
        ) : (
          <RichText text={message.summary} />
        ))}
      <FileChips files={message.files.map((file) => file.name)} />
      {message.question != null && (
        <div className="conv-question">
          <strong>需要回答</strong>
          <p>{message.question}</p>
        </div>
      )}
      {message.task_id != null && (
        <footer className="chat-card__footer">
          <ExecutionLink taskId={message.task_id} />
        </footer>
      )}
    </article>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const identity = identityFor(message.from);
  const isUser = identity.kind === 'user';
  // Only executor reports become conclusion cards; Muse coordinates in plain
  // language and must not be dressed up as an agent result.
  const isConclusion = message.from === 'claude' || message.from === 'dsh';
  const structured = isStructuredPayload(message.summary);

  return (
    <article
      className={`chat-msg chat-msg--${isUser ? 'user' : 'agent'}`}
      data-sender={message.from}
    >
      <Avatar sender={message.from} />
      <div className="chat-msg__body">
        <div className="chat-msg__meta">
          <span className="chat-msg__sender">{identity.name}</span>
          {message.created_at.length > 0 && (
            <time dateTime={message.created_at}>{formatClock(message.created_at)}</time>
          )}
        </div>
        {isConclusion ? (
          <ConclusionCard message={message} />
        ) : (
          <div className="chat-bubble">
            {message.summary.length === 0 ? (
              <span className="chat-bubble__empty">（这条消息没有文字摘要）</span>
            ) : structured ? (
              <StructuredNotice taskId={message.task_id ?? null} />
            ) : (
              <RichText text={message.summary} />
            )}
            <FileChips files={message.files.map((file) => file.name)} />
            {message.question != null && (
              <div className="conv-question">
                <strong>需要回答</strong>
                <p>{message.question}</p>
              </div>
            )}
            {message.task_id != null && (
              <div className="chat-bubble__footer">
                <ExecutionLink taskId={message.task_id} />
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}