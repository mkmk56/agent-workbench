import { CircleAlert, Files, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileCard } from '../components/FileCard';
import { listChatFiles, listChatsOnce, type ChatFile, type ChatSummary } from '../lib/chat';

/**
 * Files page (Muse, group-chat upgrade). All files uploaded into group chats,
 * grouped by chat: pick a chat, see its files with preview/download. Until
 * the engine exposes the file service, the empty state says so plainly.
 */
export function FilesPage() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  const refreshChats = async () => {
    setChatsLoading(true);
    const result = await listChatsOnce();
    setChatsLoading(false);
    if (!result.ok) {
      setChatsError(result.error);
      return;
    }
    setChatsError(null);
    setChats(result.data);
    if (selectedId == null && result.data.length > 0) {
      setSelectedId(result.data[0].chat_id);
    }
  };

  useEffect(() => {
    void refreshChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setFiles([]);
      setFilesError(null);
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
        setFiles([]);
        return;
      }
      setFilesError(null);
      setFiles(result.data.files);
    });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const selected = chats.find((chat) => chat.chat_id === selectedId) ?? null;

  return (
    <section className="files-page" aria-label="文件">
      <header className="page-head">
        <div className="page-head__text">
          <h1>文件</h1>
          <p>各群聊里上传的附件。每个文件可由 Muse、Claude 和 dsh 共同读取。</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void refreshChats()}
          disabled={chatsLoading}
        >
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </header>

      {chatsError != null && (
        <p className="files-page__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          群聊列表读取失败：{chatsError}
        </p>
      )}

      <div className="files-page__body">
        <nav className="files-page__chats" aria-label="群聊">
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
                onClick={() => setSelectedId(chat.chat_id)}
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
              <p>在群聊里点回形针按钮上传，文件会显示在这里。</p>
            </div>
          ) : (
            <ul className="files-page__grid">
              {files.map((file) => (
                <li key={file.file_id}>
                  <FileCard file={file} chatId={selected.chat_id} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
