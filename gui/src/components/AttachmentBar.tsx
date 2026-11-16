import { Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  attachmentUrl,
  formatBytes,
  isImage,
  kindLabel,
  type PendingAttachment,
} from '../lib/attachments';
import '../styles/attachments.css';

const IMAGE_KINDS = new Set(['image']);

/**
 * Pre-send attachment tray: thumbnail, name, size, live upload progress, retry
 * on failure and per-item removal. It renders state owned by
 * `useChatAttachments(chatId)` — it never uploads by itself.
 *
 * Muse: place it directly above the composer field inside <Composer>.
 */
export function AttachmentBar({
  chatId,
  items,
  onRemove,
  onRetry,
  disabled = false,
}: {
  chatId: string;
  items: PendingAttachment[];
  onRemove: (localId: string) => void | Promise<void>;
  onRetry?: (localId: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="attach-bar" aria-label="待发送附件">
      {items.map((item) => {
        const thumbUrl =
          item.fileId != null && IMAGE_KINDS.has(item.kind)
            ? attachmentUrl(chatId, item.fileId)
            : null;
        return (
          <li
            key={item.localId}
            className={`attach-chip attach-chip--${item.status}`}
            data-name={item.name}
            data-status={item.status}
          >
            <span className="attach-chip__thumb" aria-hidden="true">
              {thumbUrl != null ? (
                <img src={thumbUrl} alt="" draggable={false} data-attach-thumb="" />
              ) : (
                <span className="attach-chip__kind">{kindLabel(item.kind)}</span>
              )}
            </span>
            <span className="attach-chip__meta">
              <span className="attach-chip__name" title={item.name}>
                {item.name}
              </span>
              <span className="attach-chip__sub">
                {kindLabel(item.kind)} · {formatBytes(item.size)}
                {item.status === 'uploading' && item.percent > 0
                  ? ` · 上传中 ${item.percent}%`
                  : item.status === 'ready'
                    ? ' · 已就绪'
                    : ''}
              </span>
              {item.status === 'uploading' && (
                <span
                  className="attach-chip__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.percent}
                  aria-label={`${item.name} 上传进度`}
                >
                  <span
                    className="attach-chip__progress-fill"
                    style={{ width: `${Math.max(4, item.percent)}%` }}
                  />
                </span>
              )}
              {item.status === 'error' && (
                <span className="attach-chip__error" role="alert">
                  {item.error ?? '上传失败'}
                  {onRetry != null && (
                    <button
                      type="button"
                      className="attach-chip__retry"
                      disabled={disabled}
                      onClick={() => void onRetry(item.localId)}
                    >
                      重试
                    </button>
                  )}
                </span>
              )}
            </span>
            <button
              type="button"
              className="attach-chip__remove"
              aria-label={`移除 ${item.name}`}
              title="移除"
              disabled={disabled}
              onClick={() => void onRemove(item.localId)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function collectFiles(data: DataTransfer | null): File[] {
  if (data == null) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file != null) {
        files.push(file);
      }
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      files.push(file);
    }
  }
  return files;
}

/**
 * Drag & drop + paste surface for the chat window.
 *
 * Wraps the composer (or the whole message area) and funnels both gestures into
 * the same `intakeFiles` chain as the attach button — one upload path, one tray.
 * Text paste is left alone: preventDefault only happens when files are present.
 *
 * Muse: wrap <Composer> (or the chat main area) with this component.
 */
export function AttachmentDropZone({
  onFiles,
  disabled = false,
  className = '',
  children,
}: {
  onFiles: (files: File[], source: 'drop' | 'paste') => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (data: DataTransfer | null): boolean =>
    data != null &&
    (Array.from(data.types ?? []).includes('Files') || (data.files?.length ?? 0) > 0);

  return (
    <div
      className={`attach-dropzone${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      data-attach-dropzone=""
      onDragEnter={(event) => {
        if (disabled || !hasFiles(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer != null) {
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        depth.current = 0;
        setDragging(false);
        if (disabled) {
          return;
        }
        const files = collectFiles(event.dataTransfer);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        void onFiles(files, 'drop');
      }}
      onPaste={(event) => {
        if (disabled) {
          return;
        }
        const files = collectFiles(event.clipboardData);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        void onFiles(files, 'paste');
      }}
    >
      {children}
      {dragging && (
        <div className="attach-dropzone__hint" role="presentation">
          <Paperclip size={18} aria-hidden="true" />
          <span>松开鼠标即可上传到当前群聊</span>
        </div>
      )}
    </div>
  );
}

/** Convenience for Muse: one drop target that includes the attach button hook. */
export function AttachmentDropHint() {
  return (
    <span className="attach-hint">
      <Paperclip size={12} aria-hidden="true" />
      可拖拽文件到此窗口，或粘贴图片
    </span>
  );
}

export { isImage };
