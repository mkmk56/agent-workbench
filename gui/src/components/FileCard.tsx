import { Archive, Download, Eye, FileCode2, FileSpreadsheet, FileText, File as FileIcon, Image as ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatFile } from '../lib/chat';
import { downloadChatFile, previewChatFile, readChatFile } from '../lib/chat';

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindOf(file: ChatFile): 'image' | 'pdf' | 'doc' | 'sheet' | 'code' | 'archive' | 'file' {
  const name = file.name.toLowerCase();
  const mime = file.mime.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return 'image';
  }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return 'pdf';
  }
  if (/\.(docx?|txt|md)$/.test(name)) {
    return 'doc';
  }
  if (/\.(xlsx?|csv)$/.test(name)) {
    return 'sheet';
  }
  if (/\.(py|js|ts|tsx|jsx|java|c|cpp|h|html|css|json|xml|sql|sh)$/.test(name)) {
    return 'code';
  }
  if (/\.zip$/.test(name)) {
    return 'archive';
  }
  return 'file';
}

const KIND_ICON = {
  image: ImageIcon,
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  code: FileCode2,
  archive: Archive,
  file: FileIcon,
} as const;

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  pdf: 'PDF',
  doc: '文档',
  sheet: '表格',
  code: '代码',
  archive: '压缩包',
  file: '文件',
};

/**
 * File card (Muse, group-chat upgrade). One uploaded file: icon/thumbnail,
 * name, size, format, preview and download. Preview loads real content
 * through readChatFile/previewChatFile; every failure is shown as a real
 * error, never a fake preview.
 */
export function FileCard({ file, chatId }: { file: ChatFile; chatId: string }) {
  const kind = kindOf(file);
  const Icon = KIND_ICON[kind];
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (kind === 'image') {
      void previewChatFile(chatId, file.file_id).then((result) => {
        if (!alive) {
          return;
        }
        if (result.ok) {
          setPreviewUrl(result.data.url);
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [chatId, file.file_id, kind]);

  const toggleTextPreview = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (textPreview != null) {
      setExpanded(true);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    const result = await readChatFile(chatId, file.file_id);
    setPreviewLoading(false);
    if (!result.ok) {
      setPreviewError(result.error);
      return;
    }
    setTextPreview(result.data.text);
    setExpanded(true);
  };

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    const result = await downloadChatFile(chatId, file.file_id);
    setDownloading(false);
    if (!result.ok) {
      setDownloadError(result.error);
    }
  };

  const canTextPreview = kind === 'doc' || kind === 'code' || kind === 'sheet' || kind === 'pdf';

  return (
    <figure className="file-card">
      <span className="file-card__thumb" aria-hidden="true">
        {previewUrl != null ? (
          <img src={previewUrl} alt="" draggable={false} />
        ) : (
          <Icon size={18} strokeWidth={1.8} />
        )}
      </span>
      <figcaption className="file-card__body">
        <span className="file-card__name" title={file.name}>
          {file.name}
        </span>
        <span className="file-card__meta">
          {KIND_LABEL[kind]} · {formatSize(file.size)}
          {file.status.length > 0 && ` · ${file.status}`}
        </span>
        {(previewError != null || downloadError != null) && (
          <span className="file-card__error" role="alert">
            {previewError ?? downloadError}
          </span>
        )}
        {expanded && textPreview != null && (
          <pre className="file-card__text">{textPreview}</pre>
        )}
      </figcaption>
      <span className="file-card__actions">
        {canTextPreview && (
          <button
            type="button"
            className="file-card__action"
            onClick={() => void toggleTextPreview()}
            disabled={previewLoading}
            aria-label={expanded ? `收起 ${file.name} 预览` : `预览 ${file.name}`}
          >
            <Eye size={14} aria-hidden="true" />
            {previewLoading ? '加载中…' : expanded ? '收起' : '预览'}
          </button>
        )}
        <button
          type="button"
          className="file-card__action"
          onClick={() => void download()}
          disabled={downloading}
          aria-label={`下载 ${file.name}`}
        >
          <Download size={14} aria-hidden="true" />
          {downloading ? '下载中…' : '下载'}
        </button>
      </span>
    </figure>
  );
}
