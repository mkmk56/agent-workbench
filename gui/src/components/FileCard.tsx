import {
  Archive,
  Download,
  Eye,
  FileCode2,
  FileSpreadsheet,
  FileText,
  File as FileIcon,
  Image as ImageIcon,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { ChatFile } from '../lib/chat';
import { deleteChatFile } from '../lib/chat';
import { fileDisplayName, fileKindOf, fileStatusOf, formatFileSize } from '../lib/chat-files';
import { fileOriginLabel } from '../lib/file-list';
import { useChatFileActions } from './useChatFileActions';

const KIND_ICON = {
  image: ImageIcon,
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: FileText,
  code: FileCode2,
  text: FileText,
  zip: Archive,
  other: FileIcon,
} as const;

/**
 * Flat file card for the Files page (one uploaded file: icon/thumbnail, name,
 * size, format, uploader/date, preview, download and delete).
 *
 * The name is rendered in full — a long name wraps instead of being cut with an
 * ellipsis (task §5). Preview/download behaviour lives in useChatFileActions,
 * shared with the chat stream's "Edited files" card, and historical attachments
 * (legacy path rows) offer neither action because the engine holds no bytes.
 *
 * Delete is a two-step inline confirm: the first click arms it, the second
 * calls `chat_delete_file`. A failure keeps the card (and shows the engine's
 * own error text) — only a real `deleted` result removes it from the page.
 */
export function FileCard({
  file,
  chatId,
  onDeleted,
}: {
  file: ChatFile;
  chatId: string;
  onDeleted?: (fileId: string) => void;
}) {
  const kind = fileKindOf(file);
  const Icon = KIND_ICON[kind] ?? FileIcon;
  const actions = useChatFileActions(chatId, file);
  const status = fileStatusOf(file);
  const name = fileDisplayName(file);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    const result = await deleteChatFile({ chatId, fileId: file.file_id });
    setDeleting(false);
    if (!result.ok) {
      setConfirming(false);
      setDeleteError(result.error);
      return;
    }
    if (!result.data.deleted) {
      // The engine answered but reported nothing was removed: say so instead of
      // dropping the card and pretending the file is gone.
      setConfirming(false);
      setDeleteError('引擎未删除该文件（可能已被删除或没有权限）。');
      return;
    }
    onDeleted?.(file.file_id);
  };

  return (
    <figure className="file-card">
      <span className="file-card__thumb" aria-hidden="true">
        {actions.previewUrl != null ? (
          <img src={actions.previewUrl} alt="" draggable={false} />
        ) : (
          <Icon size={18} strokeWidth={1.8} />
        )}
      </span>
      <figcaption className="file-card__body">
        <span className="file-card__name" title={name}>
          {name}
        </span>
        <span className="file-card__meta">
          {file.size > 0 ? formatFileSize(file.size) : '大小未知'} · {status.label}
        </span>
        <span className="file-card__origin">{fileOriginLabel(file)}</span>
        {actions.error != null && (
          <span className="file-card__error" role="alert">
            {actions.error}
          </span>
        )}
        {deleteError != null && (
          <span className="file-card__error" role="alert">
            删除失败：{deleteError}
          </span>
        )}
        {actions.expanded && actions.textPreview != null && (
          <pre className="file-card__text">{actions.textPreview}</pre>
        )}
      </figcaption>
      <span className="file-card__actions">
        {actions.canPreviewText && actions.canAct && (
          <button
            type="button"
            className="file-card__action"
            onClick={() => void actions.toggleTextPreview()}
            disabled={actions.previewLoading}
            aria-label={actions.expanded ? `收起 ${name} 预览` : `预览 ${name}`}
          >
            <Eye size={14} aria-hidden="true" />
            {actions.previewLoading ? '加载中…' : actions.expanded ? '收起' : '预览'}
          </button>
        )}
        {actions.canAct && (
          <button
            type="button"
            className="file-card__action"
            onClick={() => void actions.download()}
            disabled={actions.downloadLoading}
            aria-label={`下载 ${name}`}
          >
            <Download size={14} aria-hidden="true" />
            {actions.downloadLoading ? '下载中…' : '下载'}
          </button>
        )}
        {actions.canAct &&
          (confirming ? (
            <span className="file-card__confirm" role="group" aria-label={`确认删除 ${name}`}>
              <button
                type="button"
                className="file-card__action file-card__action--danger"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
              <button
                type="button"
                className="file-card__action"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="file-card__action file-card__action--danger"
              onClick={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
              aria-label={`删除 ${name}`}
            >
              <Trash2 size={14} aria-hidden="true" />
              删除
            </button>
          ))}
      </span>
    </figure>
  );
}