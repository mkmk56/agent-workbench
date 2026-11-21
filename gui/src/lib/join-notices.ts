import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listJoinNoticesOnce,
  markJoinNoticesRead,
  unreadNotices,
} from './community';
import type { JoinNotice } from '../types';

/**
 * REA Phase 5 §4.7 — the GUI polls `chat_join_notices` on the same cadence as
 * the Inbox and surfaces unread notices in the chat banner and the Inbox
 * summary. Notices are not messages: they never enter a chat stream and do not
 * touch the 20/epoch budget (D4b), so this is the only channel that shows them.
 */

/**
 * §4.7 fixes one cadence for every join-notice surface (Inbox summary and the
 * per-chat banner). It matches the Inbox counter poll so both ticks line up and
 * a notice is never counted in one place before the other.
 */
export const JOIN_NOTICES_POLL_MS = 5_000;

export interface JoinNoticesView {
  notices: JoinNotice[];
  unread: JoinNotice[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Mark every unread notice of one chat read (banner "知道了"). */
  markChatRead: (chatId: string) => Promise<boolean>;
  /** Mark all unread notices read (Inbox clear action). */
  markAllRead: () => Promise<boolean>;
}

export function useJoinNotices(options: {
  chatId?: string;
  pollMs?: number;
  enabled?: boolean;
} = {}): JoinNoticesView {
  const { chatId, pollMs = JOIN_NOTICES_POLL_MS, enabled = true } = options;
  const [notices, setNotices] = useState<JoinNotice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const id = (requestId.current += 1);
    setLoading(true);
    const result = await listJoinNoticesOnce({
      chatId,
      read: false,
      limit: 100,
    });
    if (id !== requestId.current) {
      return;
    }
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setNotices(result.data.notices);
  }, [chatId, enabled]);

  useEffect(() => {
    if (!enabled) {
      setNotices([]);
      return;
    }
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void load();
      }
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, load, pollMs]);

  const markChatRead = useCallback(
    async (targetChatId: string): Promise<boolean> => {
      const pending = unreadNotices(notices).filter(
        (notice) => notice.chat_id === targetChatId,
      );
      if (pending.length === 0) {
        return true;
      }
      // One round trip: the engine marks every *own* unread notice of that chat
      // (`recipientId` is always the caller's own). Marking per notice used to
      // walk the whole page, including rows that belong to another recipient and
      // can never be marked read by us — the ghost unread this fixes.
      const result = await markJoinNoticesRead({ markRead: 'all', chatId: targetChatId });
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      await load();
      return true;
    },
    [load, notices],
  );

  const markAllRead = useCallback(async (): Promise<boolean> => {
    if (unreadNotices(notices).length === 0) {
      return true;
    }
    const result = await markJoinNoticesRead({ markRead: 'all', chatId });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    await load();
    return true;
  }, [chatId, load, notices]);

  return {
    notices,
    unread: unreadNotices(notices),
    error,
    loading,
    refresh: load,
    markChatRead,
    markAllRead,
  };
}