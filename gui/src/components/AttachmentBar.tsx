import {
  File as FileIcon,
  Image as ImageIcon,
  X,
} from '../ui/icons';
import { useEffect, useState } from 'react';

export interface AttachmentDraft {
  id: string;
  file: File;
  progress: number;
  status: 'ready' | 'uploading' | 'done' | 'failed';
  error?: string;
  fileId?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DraftThumb({ draft }: { draft: AttachmentDraft }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = draft.file.type.startsWith('image/');
  useEffect(() => {
    if (!isImage) {
      return;
    }
    const objectUrl = URL.createObjectURL(draft.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [draft.file, isImage]);
  return (
    <span className="attach-item__thumb" aria-hidden="true">
      {url != null ? (
        <img src={url} alt="" draggable={false} />
      ) : isImage ? (
        <ImageIcon size={16} strokeWidth={1.8} />
      ) : (
        <FileIcon size={16} strokeWidth={1.8} />
      )}
    </span>
  );
}

/**
 * Pre-send attachment strip (Muse, group-chat upgrade). Shows the files
 * staged in the composer with thumbnails, sizes, upload progress and a
 * remove button. Files are only uploaded when the message is sent; removing
 * a draft never loses the message text.
 */
export function AttachmentBar({
  items,
  onRemove,
}: {
  items: AttachmentDraft[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="attach-bar" aria-label="待发送附件">
      {items.map((draft) => (
        <li
          key={draft.id}
          className={`attach-item attach-item--${draft.status}`}
        >
          <DraftThumb draft={draft} />
          <span className="attach-item__body">
            <span className="attach-item__name" title={draft.file.name}>
              {draft.file.name}
            </span>
            <span className="attach-item__meta">
              {formatSize(draft.file.size)}
              {draft.status === 'uploading' && ` · 上传中 ${Math.round(draft.progress * 100)}%`}
              {draft.status === 'failed' && draft.error != null && ` · ${draft.error}`}
            </span>
            {draft.status === 'uploading' && (
              <span
                className="attach-item__progress"
                role="progressbar"
                aria-valuenow={Math.round(draft.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${Math.round(draft.progress * 100)}%` }} />
              </span>
            )}
          </span>
          <button
            type="button"
            className="attach-item__remove"
            onClick={() => onRemove(draft.id)}
            disabled={draft.status === 'uploading'}
            aria-label={`移除附件 ${draft.file.name}`}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
