import {
  CircleAlert,
  Files,
  PanelLeft,
  RefreshCw,
  Search,
  Upload,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCard } from '../components/FileCard';
import {
  listChatFiles,
  listChatsOnce,
  newClientMessageId,
  type ChatFile,
  type ChatSummary,
} from '../lib/chat';
import {
  FILE_SORT_OPTIONS,
  FILE_SORT_DEFAULT,
  filterFilesByName,
  sortFiles,
  type FileSortKey,
} from '../lib/file-list';
import type { ChatUploadDraft, EngineResult } from '../types';
import '../styles/files.css';

/**
 * Files page (Muse, REA Phase 4 §7.2 [G]). All files uploaded into group
 * chats, grouped by chat: pick a chat, upload, search, sort, and delete.
 *
 * Upload note: `lib/chat.uploadChatFiles` takes renderer `File` objects (the
 * chat drop/paste path). The files page gets drafts from the main-process
 * dialog instead, so it drives the same preload primitives directly
 * (`pickChatFiles` → `uploadChatFiles({ draftIds })` → `discardChatDrafts`).
 * Progress and errors come from the main process and are shown verbatim; a
 * failed upload never claims success.
 */
type UploadRow = { draftId: string; name: string; percent: number };

const UPLOAD_PICK_FAILED = '打开文件选择框失败（主进程调用异常）。';

function pickDrafts(): Promise<EngineResult<{ drafts: ChatUploadDraft[] }>> {
  const api = window.workbench;
  if (api == null || typeof api.pickChatFiles !== 'function') {
    return Promise.resolve({ ok: false, error: '当前主进程不支持文件选择对话框。' });
  }
  return api
    .pickChatFiles()
    .catch(() => ({ ok: false as const, error: UPLOAD_PICK_FAILED }));
}

/** Failed drafts stay registered in the main process; drop them explicitly. */
function discardDrafts(draftIds: readonly string[]): void {
  if (draftIds.length === 0) {
    return;
  }
  void window.workbench?.discardChatDrafts?.([...draftIds]).catch(() => undefined);
}

/** Stream the dialog drafts through the chunked upload, reporting 0–100 each. */
async function uploadDrafts(
  chatId: string,
  drafts: readonly ChatUploadDraft[],
  onProgress: (draftId: string, percent: number) => void,
): Promise<EngineResult<{ fileIds: string[] }>> {
  const api = window.workbench;
  if (api == null || typeof api.uploadChatFiles !== 'function') {
    return { ok: false, error: '主进程未暴露上传接口。' };
  }
  const uploadId = newClientMessageId();
  const reported = new Map<string, number>();
  const unsubscribe = api.onChatUploadProgress?.((progress) => {
    if (progress.uploadId !== uploadId) {
      return;
    }
    const percent =
      progress.phase === 'done' ? 100 : Math.max(0, Math.min(100, progress.percent));
    if (percent >= (reported.get(progress.draftId) ?? 0)) {
      reported.set(progress.draftId, percent);
      onProgress(progress.draftId, percent);
    }
  });
  try {
    const result = await api.uploadChatFiles({
      chatId,
      uploadId,
      draftIds: drafts.map((draft) => draft.draftId),
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? '上传文件失败。' };
    }
    if (result.data.errors.length > 0) {
      return {
        ok: false,
        error: result.data.errors.map((item) => `${item.name}: ${item.error}`).join('；'),
      };
    }
    return { ok: true, data: { fileIds: result.data.files.map((file) => file.file_id) } };
  } catch {
    return { ok: false, error: '上传文件失败（主进程调用异常）。' };
  } finally {
    unsubscribe?.();
  }
}

export function FilesPage() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<FileSortKey>(FILE_SORT_DEFAULT);
  const [selectorOpen, setSelectorOpen] = useState(true);
  const [uploads, setUploads] = useState<UploadRow[] | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  // Bumped after an upload/delete so the effect below re-reads the list.
  const [reloadKey, setReloadKey] = useState(0);

  const refreshChats = useCallback(async () => {
    setChatsLoading(true);
    const result = await listChatsOnce();
    setChatsLoading(false);
    if (!result.ok) {
      setChatsError(result.error);
      return;
    }
    setChatsError(null);
    setChats(result.data);
    setSelectedId((current) => {
      if (current != null && result.data.some((chat) => chat.chat_id === current)) {
        return current;
      }
      return result.data.length > 0 ? result.data[0].chat_id : null;
    });
  }, []);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const refreshAll = useCallback(async () => {
    await refreshChats();
    reload();
  }, [refreshChats, reload]);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  useEffect(() => {
    if (selectedId == null) {
      setFiles([]);
      setFilesError(null);
      setFilesLoading(false);
      return;
    }
    let alive = true;
    setFilesLoading(true);
    void listChatFiles(selectedId).then((result) => {
      if (!alive) {
        return;
      }
      setFilesLoading(false);
      if (!result.ok) {
        setFilesError(result.error);
        // Never keep another chat's files on screen under this chat's name.
        setFiles([]);
        return;
      }
      setFilesError(null);
      setFiles(result.data.files);
    });
    return () => {
      alive = false;
    };
  }, [selectedId, reloadKey]);

  const selected = chats.find((chat) => chat.chat_id === selectedId) ?? null;

  const filtered = useMemo(
    () => sortFiles(filterFilesByName(files, query), sortKey),
    [files, query, sortKey],
  );

  const handleUpload = async () => {
    if (selected == null || uploads != null) {
      return;
    }
    setUploadError(null);
    setUploadNotice(null);
    const picked = await pickDrafts();
    if (!picked.ok) {
      setUploadError(picked.error);
      return;
    }
    const drafts = picked.data.drafts;
    if (drafts.length === 0) {
      // Dialog cancelled: nothing to upload and nothing to report.
      return;
    }
    setUploads(drafts.map((draft) => ({ draftId: draft.draftId, name: draft.name, percent: 0 })));
    const chatId = selected.chat_id;
    const result = await uploadDrafts(chatId, drafts, (draftId, percent) => {
      setUploads((rows) =>
        rows == null
          ? rows
          : rows.map((row) => (row.draftId === draftId ? { ...row, percent } : row)),
      );
    });
    setUploads(null);
    if (!result.ok) {
      setUploadError(result.error);
      discardDrafts(drafts.map((draft) => draft.draftId));
    } else {
      setUploadNotice(`已上传 ${result.data.fileIds.length} 个文件。`);
    }
    // Reload even after a failure: an upload may have partially succeeded.
    reload();
  };

  const handleDeleted = (fileId: string) => {
    setFiles((current) => current.filter((file) => file.file_id !== fileId));
    setUploadNotice('已删除 1 个文件。');
  };

  const matched = filtered.length !== files.length;

  return (
    <section className="files-page" aria-label="文件">
      <header className="page-head">
        <div className="page-head__text">
          <h1>文件</h1>
          <p>
            各群聊里上传的附件。每个文件可由 Muse、Claude 和 dsh 共同读取。
            {selected != null ? `当前群聊：${selected.name}。` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleUpload()}
            disabled={selected == null || uploads != null}
          >
            <Upload size={14} aria-hidden="true" />
            {uploads != null ? '上传中…' : '上传文件'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refreshAll()}
            disabled={chatsLoading}
          >
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </button>
        </div>
      </header>

      {chatsError != null && (
        <p className="files-page__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          群聊列表读取失败：{chatsError}
        </p>
      )}

      {uploadError != null && (
        <p className="files-page__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          上传失败：{uploadError}
        </p>
      )}

      {uploadNotice != null && uploads == null && (
        <p className="files-page__notice" role="status">
          {uploadNotice}
        </p>
      )}

      {uploads != null && (
        <div className="files-page__upload" role="status" aria-live="polite">
          <p className="files-page__upload-title">正在上传 {uploads.length} 个文件…</p>
          <ul className="files-page__upload-list">
            {uploads.map((row) => (
              <li key={row.draftId} className="files-page__upload-row">
                <span className="files-page__upload-name" title={row.name}>
                  {row.name}
                </span>
                <span className="files-page__upload-bar" aria-hidden="true">
                  <span
                    className="files-page__upload-fill"
                    style={{ width: `${Math.round(row.percent)}%` }}
                  />
                </span>
                <span className="files-page__upload-percent">{Math.round(row.percent)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="files-page__toolbar">
        <label className="search files-page__search">
          <Search size={14} className="icon" aria-hidden="true" />
          <span className="sr-only">搜索文件名</span>
          <input
            type="search"
            className="input"
            value={query}
            placeholder="搜索文件名…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="排序方式">
          {FILE_SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={sortKey === option.value ? 'is-active' : undefined}
              aria-pressed={sortKey === option.value}
              onClick={() => setSortKey(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm files-page__toggle"
          aria-expanded={selectorOpen}
          aria-controls="files-page-chats"
          onClick={() => setSelectorOpen((open) => !open)}
        >
          <PanelLeft size={14} aria-hidden="true" />
          {selectorOpen ? '收起群聊' : '展开群聊'}
        </button>
      </div>

      <div className="files-page__body">
        <nav
          id="files-page-chats"
          className="files-page__chats"
          aria-label="群聊"
          hidden={!selectorOpen}
        >
          {chatsLoading ? (
            <p className="files-page__status" role="status">
              正在读取群聊…
            </p>
          ) : chats.length === 0 ? (
            <p className="files-page__status">还没有群聊。</p>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.chat_id}
                type="button"
                className={`files-page__chat${chat.chat_id === selectedId ? ' is-active' : ''}`}
                onClick={() => {
                  setSelectedId(chat.chat_id);
                  setUploadNotice(null);
                }}
                aria-current={chat.chat_id === selectedId}
              >
                {chat.name}
              </button>
            ))
          )}
        </nav>

        <div className="files-page__list">
          {selected == null ? (
            <p className="files-page__status">先选择一个群聊。</p>
          ) : filesLoading ? (
            <p className="files-page__status" role="status">
              正在读取「{selected.name}」的文件…
            </p>
          ) : filesError != null ? (
            <p className="files-page__error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              文件读取失败：{filesError}
            </p>
          ) : files.length === 0 ? (
            <div className="files-page__empty">
              <Files size={28} strokeWidth={1.6} aria-hidden="true" />
              <p>「{selected.name}」还没有上传文件。</p>
              <p>点“上传文件”选择文件，或直接在群聊里拖入附件，都会显示在这里。</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="files-page__empty">
              <Files size={28} strokeWidth={1.6} aria-hidden="true" />
              <p>没有匹配「{query.trim()}」的文件。</p>
              <p>清空搜索框可以看到这个群聊的全部 {files.length} 个文件。</p>
            </div>
          ) : (
            <>
              <p className="files-page__count">
                {matched
                  ? `匹配 ${filtered.length} / ${files.length} 个文件`
                  : `共 ${files.length} 个文件`}
              </p>
              <ul className="files-page__grid">
                {filtered.map((file) => (
                  <li key={file.file_id}>
                    <FileCard
                      file={file}
                      chatId={selected.chat_id}
                      onDeleted={handleDeleted}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}