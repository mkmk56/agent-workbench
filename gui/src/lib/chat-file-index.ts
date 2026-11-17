import { useEffect, useState } from 'react';
import type { ChatFile } from '../types';
import { listChatFiles } from './chat';
import { indexChatFiles } from './chat-files';

/**
 * Per-chat attachment index (P0-5 scheme B, docs/REFACTOR_PLAN.md §3.1).
 *
 * The message stream carries the attachment objects the engine returned; this
 * index adds the authoritative `list_chat_files` record for the whole chat and
 * is merged in by the page. One request per chat, cached for a short window and
 * invalidated after a send/upload, so a 3 s message poll never turns into a 3 s
 * file poll.
 *
 * A failure is not fatal: the message's own objects still render. The index is
 * an addition, never a prerequisite.
 */

const CACHE_TTL_MS = 15_000;

type IndexEntry = {
  files: Map<string, ChatFile>;
  error: string | null;
  at: number;
};

const EMPTY_INDEX: Map<string, ChatFile> = new Map();
const cache = new Map<string, IndexEntry>();
const inflight = new Map<string, Promise<IndexEntry>>();
const listeners = new Set<() => void>();

export function emptyChatFileIndex(): Map<string, ChatFile> {
  return EMPTY_INDEX;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Drop one chat's index (or all of them) and let every subscribed hook refetch.
 * Called after a send or upload finishes, and when the user opens the file list.
 */
export function invalidateChatFileIndex(chatId?: string | null): void {
  if (chatId == null) {
    cache.clear();
  } else {
    cache.delete(chatId);
  }
  notify();
}

function load(chatId: string): Promise<IndexEntry> {
  const running = inflight.get(chatId);
  if (running != null) {
    return running;
  }
  const task = listChatFiles(chatId)
    .then((result) => {
      const entry: IndexEntry = result.ok
        ? { files: indexChatFiles(result.data.files), error: null, at: Date.now() }
        : { files: EMPTY_INDEX, error: result.error, at: Date.now() };
      cache.set(chatId, entry);
      return entry;
    })
    .catch(() => {
      const entry: IndexEntry = {
        files: EMPTY_INDEX,
        error: '读取附件列表失败（主进程调用异常）。',
        at: Date.now(),
      };
      cache.set(chatId, entry);
      return entry;
    })
    .finally(() => {
      inflight.delete(chatId);
    });
  inflight.set(chatId, task);
  return task;
}

export type ChatFileIndexView = {
  files: Map<string, ChatFile>;
  loading: boolean;
  error: string | null;
};

export function useChatFileIndex(chatId: string | null): ChatFileIndexView {
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<ChatFileIndexView>({
    files: EMPTY_INDEX,
    loading: false,
    error: null,
  });

  useEffect(() => {
    const listener = () => setVersion((current) => current + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (chatId == null) {
      setView({ files: EMPTY_INDEX, loading: false, error: null });
      return;
    }
    const cached = cache.get(chatId);
    if (cached != null && Date.now() - cached.at < CACHE_TTL_MS) {
      setView({ files: cached.files, loading: false, error: cached.error });
      return;
    }
    let alive = true;
    setView({ files: EMPTY_INDEX, loading: true, error: null });
    void load(chatId).then((entry) => {
      if (!alive) {
        return;
      }
      setView({ files: entry.files, loading: false, error: entry.error });
    });
    return () => {
      alive = false;
    };
  }, [chatId, version]);

  return view;
}