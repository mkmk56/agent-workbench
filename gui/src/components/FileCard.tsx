import {
  Archive,
  Download,
  Eye,
  FileCode2,
  FileSpreadsheet,
  FileText,
  File as FileIcon,
  Image as ImageIcon,
} from 'lucide-react';
import type { ChatFile } from '../lib/chat';
import { fileDisplayName, fileKindOf, fileStatusOf, formatFileSize } from '../lib/chat-files';
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
 * size, format, preview and download).
 *
 * The name is rendered in full — a long name wraps instead of being cut with an
 * ellipsis (task §5). Preview/download behaviour lives in useChatFileActions,
 * shared with the chat stream's "Edited files" card, and historical attachments
 * (legacy path rows) offer neither action because the engine holds no bytes.
 */
export function FileCard({ file, chatId }: { file: ChatFile; chatId: string }) {
  const kind = fileKindOf(file);
  const Icon = KIND_ICON[kind] ?? FileIcon;
  const actions = useChatFileActions(chatId, file);
  const status = fileStatusOf(file);
  const name = fileDisplayName(file);

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
        {actions.error != null && (
          <span className="file-card__error" role="alert">
            {actions.error}
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
      </span>
    </figure>
  );
}