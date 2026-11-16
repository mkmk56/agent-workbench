import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatFile,
  ChatFileKind,
  ChatUploadDraft,
  ChatUploadProgress,
} from '../types';
import { readChatFile } from './chat';

/**
 * Renderer-side attachment intake.
 *
 * The component layer only deals with `draftId` / `file_id` handles: the main
 * process owns the bytes (dialog → draft registry → 1 MB chunked upload), so
 * nothing here touches the filesystem, and no host path ever crosses IPC.
 * Uploads start as soon as a draft is registered so the progress bar is real.
 */

export const CHAT_ATTACHMENT_SCHEME = 'chat-attachment';
// Keep in sync with the backend limit: src/files.js defaults chatMaxFileBytes
// to 20 MB. Declaring a larger GUI limit produced uploads the engine rejected.
export const MAX_FILE_BYTES = 20 * 1_024 * 1_024;
export const MAX_FILES_PER_UPLOAD = 20;
export const CHUNK_SIZE = 1_024 * 1_024;
export const TEXT_PREVIEW_LIMIT = 256 * 1_024;

export type AttachmentSource = 'dialog' | 'drop' | 'paste';

export interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  mime: string;
  kind: ChatFileKind;
  source: AttachmentSource;
  status: 'uploading' | 'ready' | 'error';
  percent: number;
  fileId: string | null;
  file: ChatFile | null;
  error: string | null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const KIND_LABELS: Record<ChatFileKind, string> = {
  image: '图片',
  pdf: 'PDF',
  docx: 'Word',
  xlsx: '表格',
  pptx: '演示文稿',
  zip: '压缩包',
  code: '代码',
  text: '文本',
  other: '文件',
};

export function kindLabel(kind: ChatFileKind): string {
  return KIND_LABELS[kind];
}

export function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toUpperCase() : '';
}

/** Narrow custom protocol URL; the main process re-validates chat/file ids. */
export function attachmentUrl(chatId: string, fileId: string): string {
  return `${CHAT_ATTACHMENT_SCHEME}://file/${encodeURIComponent(chatId)}/${encodeURIComponent(fileId)}`;
}

/** Text-ish previews are fetched through IPC (never through the protocol). */
export function isTextPreviewable(file: ChatFile): boolean {
  return file.kind === 'code' || file.kind === 'text';
}

export function isImage(file: ChatFile): boolean {
  return file.kind === 'image';
}

/** Load a code/text file's content for the preview overlay. */
export async function loadChatFileText(
  chatId: string,
  fileId: string,
  limit = TEXT_PREVIEW_LIMIT,
): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> {
  const result = await readChatFile({ chatId, fileId, mode: 'text', limit });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    text: result.data.content,
    truncated: result.data.truncated,
  };
}

function toItem(draft: ChatUploadDraft): PendingAttachment {
  return {
    localId: draft.draftId,
    name: draft.name,
    size: draft.size,
    mime: draft.mime,
    kind: draft.kind,
    source: draft.source,
    status: 'uploading',
    percent: 0,
    fileId: null,
    file: null,
    error: null,
  };
}

export interface ChatAttachmentsController {
  items: PendingAttachment[];
  readyFiles: ChatFile[];
  fileIds: string[];
  busy: boolean;
  error: string | null;
  /** Open the main-process file dialog and upload whatever was picked. */
  pick: () => Promise<void>;
  /** Drop / paste entry point; goes through the same draft + upload chain. */
  intakeFiles: (files: File[], source: 'drop' | 'paste') => Promise<void>;
  /** Re-run a failed upload using the still-registered draft. */
  retry: (localId: string) => Promise<void>;
  /** Remove a pending attachment (pending drafts are discarded in main). */
  remove: (localId: string) => Promise<void>;
  clear: () => void;
}

/**
 * One controller per composer. `chatId` scopes uploads to the open chat; a chat
 * switch resets the tray (files uploaded to the other chat are not reused).
 */
export function useChatAttachments(chatId: string): ChatAttachmentsController {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<PendingAttachment[]>([]);
  const alive = useRef(true);
  const progressUnsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    setItems([]);
    setError(null);
  }, [chatId]);

  useEffect(() => {
    alive.current = true;
    const api = window.workbench;
    if (api?.onChatUploadProgress) {
      progressUnsub.current = api.onChatUploadProgress((progress: ChatUploadProgress) => {
        if (!alive.current) {
          return;
        }
        setItems((current) =>
          current.map((item) =>
            item.localId === progress.draftId
              ? {
                  ...item,
                  percent: progress.percent,
                  fileId: progress.fileId ?? item.fileId,
                  error: progress.phase === 'error' ? (progress.error ?? item.error) : item.error,
                  status:
                    progress.phase === 'error'
                      ? 'error'
                      : progress.phase === 'done'
                        ? 'ready'
                        : 'uploading',
                }
              : item,
          ),
        );
      });
    }
    return () => {
      alive.current = false;
      progressUnsub.current?.();
      progressUnsub.current = null;
    };
  }, []);

  const uploadBatch = useCallback(
    async (drafts: ChatUploadDraft[]) => {
      if (drafts.length === 0) {
        return;
      }
      if (!window.workbench?.uploadChatFiles) {
        setError('聊天接口尚未接通（IPC 桥未就绪）。');
        return;
      }
      setError(null);
      setItems((current) => [...current, ...drafts.map(toItem)]);
      const uploadId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `upload-${Date.now()}`;
      const result = await window.workbench.uploadChatFiles({
        chatId,
        uploadId,
        draftIds: drafts.map((draft) => draft.draftId),
      });
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setItems((current) =>
          current.map((item) =>
            drafts.some((draft) => draft.draftId === item.localId)
              ? { ...item, status: 'error', error: result.error }
              : item,
          ),
        );
        setError(result.error);
        return;
      }
      const files = result.data.files ?? [];
      const errors = result.data.errors ?? [];
      const byDraft = new Map<string, ChatFile>();
      for (const file of files) {
        const draftId = (file as ChatFile & { draft_id?: string }).draft_id;
        if (draftId != null) {
          byDraft.set(draftId, file);
        }
      }
      setItems((current) =>
        current.map((item) => {
          const file = byDraft.get(item.localId);
          if (file != null) {
            return {
              ...item,
              status: 'ready',
              percent: 100,
              fileId: file.file_id,
              file,
              error: null,
            };
          }
          const failure = errors.find((entry) => entry.draftId === item.localId);
          if (failure != null) {
            return { ...item, status: 'error', error: failure.error };
          }
          return item;
        }),
      );
      if (errors.length > 0) {
        setError(errors[0].error);
      }
    },
    [chatId],
  );

  const pick = useCallback(async () => {
    if (!window.workbench?.pickChatFiles) {
      setError('文件选择接口未接通（IPC 桥未就绪）。');
      return;
    }
    const result = await window.workbench.pickChatFiles();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await uploadBatch(result.data.drafts ?? []);
  }, [uploadBatch]);

  const intakeFiles = useCallback(
    async (files: File[], source: 'drop' | 'paste') => {
      if (!window.workbench?.registerChatFiles) {
        setError('文件接口未接通（IPC 桥未就绪）。');
        return;
      }
      if (files.length === 0) {
        return;
      }
      const result = await window.workbench.registerChatFiles(files, source);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      await uploadBatch(result.data.drafts ?? []);
    },
    [uploadBatch],
  );

  const retry = useCallback(
    async (localId: string) => {
      if (!window.workbench?.uploadChatFiles) {
        return;
      }
      setItems((current) =>
        current.map((item) =>
          item.localId === localId ? { ...item, status: 'uploading', error: null } : item,
        ),
      );
      const uploadId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `retry-${Date.now()}`;
      const result = await window.workbench.uploadChatFiles({
        chatId,
        uploadId,
        draftIds: [localId],
      });
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setItems((current) =>
          current.map((item) =>
            item.localId === localId
              ? { ...item, status: 'error', error: result.error }
              : item,
          ),
        );
        return;
      }
      const file = (result.data.files ?? [])[0];
      setItems((current) =>
        current.map((item) =>
          item.localId === localId
            ? file != null
              ? { ...item, status: 'ready', percent: 100, fileId: file.file_id, file, error: null }
              : { ...item, status: 'error', error: result.data.errors?.[0]?.error ?? '上传失败。' }
            : item,
        ),
      );
    },
    [chatId],
  );

  const remove = useCallback(async (localId: string) => {
    setItems((current) => current.filter((item) => item.localId !== localId));
    await window.workbench?.discardChatDrafts?.([localId]);
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setError(null);
  }, []);

  const readyFiles = items
    .filter((item): item is PendingAttachment & { file: ChatFile } => item.file != null)
    .map((item) => item.file);
  const busy = items.some((item) => item.status === 'uploading');

  return {
    items,
    readyFiles,
    fileIds: readyFiles.map((file) => file.file_id),
    busy,
    error,
    pick,
    intakeFiles,
    retry,
    remove,
    clear,
  };
}
