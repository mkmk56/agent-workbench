import {
  Download,
  ExternalLink,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Loader2,
  Presentation,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatFile } from '../types';
import {
  attachmentUrl,
  fileExt,
  formatBytes,
  isImage,
  isTextPreviewable,
  kindLabel,
  loadChatFileText,
} from '../lib/attachments';
import { openChatFile, saveChatFile } from '../lib/chat';
import '../styles/attachments.css';

/**
 * File card for a shared attachment.
 *
 * - images render a real thumbnail through the narrow `chat-attachment:` scheme
 * - text/code open an in-app preview with syntax highlighting (content comes
 *   from main via `engine:chat-file-read`, never from the filesystem)
 * - every card has preview / download / open-with-system entries
 *
 * Muse: replace `MessageBubble`'s `FileChips` with `<FileCardList chatId={...}
 * files={message.files} />`; the card owns all of its own state.
 */

const KIND_ICONS: Record<ChatFile['kind'], typeof FileText> = {
  image: FileImage,
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  zip: FileArchive,
  code: FileCode2,
  text: FileText,
  other: FileType2,
};

const PARSE_LABELS: Record<string, string> = {
  ready: '已解析',
  parsing: '解析中',
  failed: '解析失败',
};

function iconFor(file: ChatFile) {
  const Icon = KIND_ICONS[file.kind] ?? FileText;
  return <Icon size={18} strokeWidth={1.7} aria-hidden="true" />;
}

function statusBadge(file: ChatFile): ReactNode {
  const label = file.status != null ? PARSE_LABELS[file.status] : null;
  if (label == null) {
    return null;
  }
  return (
    <span className={`file-card__status file-card__status--${file.status}`} title={label}>
      {file.status === 'parsing' && <Loader2 size={10} className="spin" aria-hidden="true" />}
      {label}
    </span>
  );
}

export function FileCard({
  chatId,
  file,
  onPreview,
  compact = false,
}: {
  chatId: string;
  file: ChatFile;
  /** Optional override (e.g. Muse opens a shared preview panel instead). */
  onPreview?: (file: ChatFile) => void;
  compact?: boolean;
}) {
  const [overlay, setOverlay] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const preview = () => {
    if (onPreview != null) {
      onPreview(file);
      return;
    }
    setOverlay(true);
  };

  const download = async () => {
    setNotice(null);
    const result = await saveChatFile({ chatId, fileId: file.file_id });
    if (!result.ok) {
      setNotice(result.error);
    } else if (result.data.savedPath.length === 0) {
      setNotice('已取消保存。');
    }
  };

  const open = async () => {
    setNotice(null);
    const result = await openChatFile({ chatId, fileId: file.file_id });
    if (!result.ok) {
      setNotice(result.error);
    }
  };

  const showThumb = isImage(file);

  return (
    <>
      <div
        className={`file-card${compact ? ' file-card--compact' : ''}`}
        data-file-name={file.name}
        data-file-kind={file.kind}
      >
        <div className="file-card__visual" aria-hidden="true">
          {showThumb ? (
            <img
              className="file-card__thumb"
              src={attachmentUrl(chatId, file.file_id)}
              alt=""
              loading="lazy"
              draggable={false}
              data-file-thumb=""
            />
          ) : (
            <span className="file-card__icon">{iconFor(file)}</span>
          )}
        </div>
        <div className="file-card__body">
          <div className="file-card__title-row">
            <span className="file-card__name" title={file.name}>
              {file.name}
            </span>
            {statusBadge(file)}
          </div>
          <div className="file-card__meta">
            <span>{kindLabel(file.kind)}</span>
            {fileExt(file.name).length > 0 && <span>· {fileExt(file.name)}</span>}
            {file.size > 0 && <span>· {formatBytes(file.size)}</span>}
          </div>
          {file.preview_text != null && !showThumb && (
            <p className="file-card__snippet" title="解析摘要">
              {file.preview_text.slice(0, 120)}
              {file.preview_text.length > 120 ? '…' : ''}
            </p>
          )}
          <div className="file-card__actions">
            <button
              type="button"
              className="file-card__action"
              data-action="preview"
              onClick={preview}
            >
              预览
            </button>
            <button
              type="button"
              className="file-card__action"
              data-action="download"
              onClick={() => void download()}
            >
              <Download size={12} aria-hidden="true" />
              下载
            </button>
            <button
              type="button"
              className="file-card__action"
              data-action="open"
              onClick={() => void open()}
            >
              <ExternalLink size={12} aria-hidden="true" />
              打开
            </button>
          </div>
          {notice != null && (
            <p className="file-card__notice" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
      {overlay && (
        <FilePreviewOverlay chatId={chatId} file={file} onClose={() => setOverlay(false)} />
      )}
    </>
  );
}

export function FileCardList({
  chatId,
  files,
  onPreview,
  emptyHint = null,
}: {
  chatId: string;
  files: ChatFile[];
  onPreview?: (file: ChatFile) => void;
  emptyHint?: ReactNode;
}) {
  if (files.length === 0) {
    return emptyHint == null ? null : <div className="file-card-list">{emptyHint}</div>;
  }
  return (
    <ul className="file-card-list" aria-label="附件">
      {files.map((file) => (
        <li key={file.file_id} className="file-card-list__item">
          <FileCard chatId={chatId} file={file} onPreview={onPreview} />
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Preview overlay
 * ------------------------------------------------------------------ */

type Lang = 'js' | 'json' | 'css' | 'html' | 'md' | 'py' | 'sh' | 'conf' | 'sql' | 'plain';

function languageOf(name: string): Lang {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js';
  if (['json', 'jsonc'].includes(ext)) return 'json';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['html', 'htm', 'xml', 'vue', 'svelte', 'svg'].includes(ext)) return 'html';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (ext === 'py') return 'py';
  if (['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'].includes(ext)) return 'sh';
  if (['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env'].includes(ext)) return 'conf';
  if (ext === 'sql') return 'sql';
  return 'plain';
}

const KEYWORDS: Record<Lang, Set<string>> = {
  js: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
    'continue', 'import', 'export', 'default', 'from', 'as', 'class', 'extends', 'new', 'this',
    'super', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in',
    'of', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
    'static', 'void', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'delete', 'yield',
  ]),
  json: new Set(['true', 'false', 'null']),
  css: new Set(['important', 'media', 'supports', 'keyframes', 'import', 'root', 'var']),
  html: new Set(['html', 'head', 'body', 'div', 'span', 'script', 'style', 'meta', 'link']),
  md: new Set(),
  py: new Set([
    'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'class',
    'try', 'except', 'finally', 'with', 'await', 'async', 'lambda', 'yield', 'raise', 'pass',
    'None', 'True', 'False', 'in', 'not', 'and', 'or', 'is',
  ]),
  sh: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'case', 'esac', 'function',
    'export', 'local', 'return', 'echo', 'set', 'shift', 'read', 'while', 'until',
  ]),
  conf: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
  sql: new Set([
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'table', 'alter', 'drop', 'join', 'left', 'right', 'inner', 'outer', 'group', 'by', 'order',
    'limit', 'and', 'or', 'not', 'null', 'primary', 'key', 'index',
  ]),
  plain: new Set(),
};

interface Token {
  type: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punct' | 'space';
  text: string;
}

function commentPattern(lang: Lang): string {
  if (lang === 'js' || lang === 'json' || lang === 'css' || lang === 'sql') {
    return '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  }
  if (lang === 'html') {
    return '<!--[^\\n]*';
  }
  if (lang === 'py' || lang === 'sh' || lang === 'conf') {
    return '#[^\\n]*';
  }
  return '';
}

function tokenizeLine(line: string, lang: Lang, re: RegExp): Token[] {
  const tokens: Token[] = [];
  const keywords = KEYWORDS[lang];
  let index = 0;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > index) {
      tokens.push({ type: 'plain', text: line.slice(index, match.index) });
    }
    const [text] = match;
    if (match[1] != null) {
      tokens.push({ type: 'comment', text });
    } else if (match[2] != null) {
      tokens.push({ type: 'string', text });
    } else if (match[3] != null) {
      tokens.push({ type: 'number', text });
    } else if (match[4] != null) {
      tokens.push(
        keywords.has(text) ? { type: 'keyword', text } : { type: 'plain', text },
      );
    } else if (match[5] != null) {
      tokens.push({ type: 'space', text });
    } else {
      tokens.push({ type: 'punct', text });
    }
    index = match.index + text.length;
    if (text.length === 0) {
      re.lastIndex += 1;
    }
  }
  if (index < line.length) {
    tokens.push({ type: 'plain', text: line.slice(index) });
  }
  return tokens;
}

function buildTokenRe(lang: Lang): RegExp {
  const comment = commentPattern(lang);
  const parts = [
    comment.length > 0 ? `(${comment})` : '((?!))',
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)',
    '\\b(\\d+(?:\\.\\d+)?)\\b',
    '([A-Za-z_$][A-Za-z0-9_$]*)',
    '(\\s+)',
    '([^\\s])',
  ];
  return new RegExp(parts.join('|'), 'g');
}

const MAX_PREVIEW_LINES = 4000;

function HighlightedCode({ text, name }: { text: string; name: string }) {
  const lang = languageOf(name);
  const re = buildTokenRe(lang);
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(0, MAX_PREVIEW_LINES);
  let highlighted = 0;
  return (
    <pre className="file-preview__code" data-code-preview="">
      <code>
        {lines.map((line, lineIndex) => (
          <span className="file-preview__line" key={lineIndex}>
            {tokenizeLine(line, lang, re).map((token, tokenIndex) => {
              if (token.type === 'plain' || token.type === 'space') {
                return <span key={tokenIndex}>{token.text}</span>;
              }
              highlighted += 1;
              return (
                <span
                  className={`file-preview__tok file-preview__tok--${token.type}`}
                  data-tok-type={token.type}
                  key={tokenIndex}
                >
                  {token.text}
                </span>
              );
            })}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function FilePreviewOverlay({
  chatId,
  file,
  onClose,
}: {
  chatId: string;
  file: ChatFile;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    if (!isTextPreviewable(file) || file.file_id.length === 0) {
      return;
    }
    setLoading(true);
    setError(null);
    const result = await loadChatFileText(chatId, file.file_id);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText(result.text);
    setTruncated(result.truncated);
  }, [chatId, file]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    const result = await saveChatFile({ chatId, fileId: file.file_id });
    if (!result.ok) {
      setError(result.error);
    }
  };

  const open = async () => {
    const result = await openChatFile({ chatId, fileId: file.file_id });
    if (!result.ok) {
      setError(result.error);
    }
  };

  let body: ReactNode;
  if (isImage(file)) {
    body = (
      <div className="file-preview__image-wrap">
        <img
          className="file-preview__image"
          src={attachmentUrl(chatId, file.file_id)}
          alt={file.name}
          draggable={false}
          data-file-thumb=""
        />
      </div>
    );
  } else if (isTextPreviewable(file)) {
    body = loading ? (
      <p className="file-preview__note">
        <Loader2 size={14} className="spin" aria-hidden="true" /> 正在读取文件内容…
      </p>
    ) : error != null ? (
      <p className="file-preview__note file-preview__note--error" role="alert">
        {error}
        <button type="button" className="file-preview__action" onClick={() => void load()}>
          <RefreshCw size={12} aria-hidden="true" />
          重试
        </button>
      </p>
    ) : (
      <>
        <HighlightedCode text={text ?? ''} name={file.name} />
        {truncated && (
          <p className="file-preview__note">内容较大，仅预览前 {formatBytes(256 * 1024)}。</p>
        )}
      </>
    );
  } else {
    body = (
      <div className="file-preview__note file-preview__note--fallback">
        <p>
          {kindLabel(file.kind)} 暂不支持内联预览（避免在渲染进程里执行文档解析）。
        </p>
        {file.preview_text != null && (
          <p className="file-preview__parse" data-parsed-preview="">
            解析摘要：{file.preview_text.slice(0, 600)}
          </p>
        )}
        <div className="file-preview__fallback-actions">
          <button type="button" className="file-preview__action" onClick={() => void download()}>
            <Download size={12} aria-hidden="true" />
            下载到本地
          </button>
          <button type="button" className="file-preview__action" onClick={() => void open()}>
            <ExternalLink size={12} aria-hidden="true" />
            用系统应用打开
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="file-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${file.name}`}
      data-preview-overlay=""
      data-preview-name={file.name}
      data-preview-kind={file.kind}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="file-preview__panel">
        <header className="file-preview__head">
          <span className="file-preview__icon">{iconFor(file)}</span>
          <span className="file-preview__title">
            <span className="file-preview__name" title={file.name}>
              {file.name}
            </span>
            <span className="file-preview__sub">
              {kindLabel(file.kind)}
              {file.size > 0 ? ` · ${formatBytes(file.size)}` : ''}
              {file.mime.length > 0 ? ` · ${file.mime}` : ''}
            </span>
          </span>
          <span className="file-preview__head-actions">
            <button type="button" className="file-preview__action" onClick={() => void download()}>
              <Download size={13} aria-hidden="true" />
              下载
            </button>
            <button type="button" className="file-preview__action" onClick={() => void open()}>
              <ExternalLink size={13} aria-hidden="true" />
              打开
            </button>
            <button
              type="button"
              ref={closeRef}
              className="file-preview__action file-preview__close"
              aria-label="关闭预览"
              onClick={onClose}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </span>
        </header>
        <div className="file-preview__body">{body}</div>
      </div>
    </div>
  );
}

export { isTextPreviewable };
