import {
  BellRing,
  X,
} from '../ui/icons';
import { useCallback, useEffect, useState } from 'react';
import { useEngineEventSignal } from '../lib/engine';
import { formatRelative } from '../lib/labels';
import { wakeKindLabel, wakeStatusOnce } from '../lib/wake';
import type { WakeUnreadNotice } from '../types';

const AGENT_IDS = ['claude', 'dsh', 'muse'] as const;
const POLL_MS = 15_000;

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  dsh: 'dsh',
  muse: 'Muse',
};

/**
 * REA Phase 4 [B]: the in-chat banner for pending `[wake]` reminders.
 *
 * Phase 4 hard requirement (design §5, §9 D2): the reminder no longer enters
 * the message stream. It is surfaced here instead — outside the scrollback,
 * dismissed by click, and never persisted as a message. The data is the
 * engine's own pending-notice list from `wake_status`; when the engine does not
 * expose it the banner renders nothing rather than inventing a reminder.
 */
export function WakeBanner({ chatId }: { chatId: string }) {
  const [notices, setNotices] = useState<WakeUnreadNotice[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const signal = useEngineEventSignal();

  const load = useCallback(async () => {
    const results = await Promise.all(
      AGENT_IDS.map((agentId) => wakeStatusOnce(agentId, chatId)),
    );
    const collected: WakeUnreadNotice[] = [];
    for (const result of results) {
      if (!result.ok) {
        continue;
      }
      for (const notice of result.data.notices ?? []) {
        // The engine answers per agent; only this chat's notices belong here.
        if (notice.chat_id != null && notice.chat_id !== chatId) {
          continue;
        }
        collected.push(notice);
      }
    }
    // Newest first, de-duplicated by id (two agents cannot share one notice id).
    const unique = new Map(collected.map((notice) => [notice.id, notice]));
    setNotices(
      [...unique.values()].sort((left, right) => {
        const leftAt = left.created_at != null ? Date.parse(left.created_at) : 0;
        const rightAt = right.created_at != null ? Date.parse(right.created_at) : 0;
        return rightAt - leftAt;
      }),
    );
  }, [chatId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void load();
      }
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  // A live wake event can create a reminder: refresh right away.
  useEffect(() => {
    if (signal > 0) {
      void load();
    }
  }, [signal, load]);

  const visible = notices.filter((notice) => !dismissed.has(notice.id));
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="wake-banner" role="status" aria-live="polite">
      <span className="wake-banner__icon" aria-hidden="true">
        <BellRing size={14} />
      </span>
      <ul className="wake-banner__list">
        {visible.map((notice) => (
          <li key={notice.id} className="wake-banner__item">
            <span>
              <strong>{AGENT_NAMES[notice.agent_id] ?? notice.agent_id}</strong> 未读
              {' · '}
              {wakeKindLabel(notice.kind)}
              {notice.created_at != null && ` · ${formatRelative(notice.created_at)}`}
            </span>
            <button
              type="button"
              className="wake-banner__dismiss"
              aria-label="忽略这条唤醒提醒"
              title="忽略（不写入消息流）"
              onClick={() => setDismissed((current) => new Set(current).add(notice.id))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <span className="wake-banner__note">
        唤醒提醒不再进入聊天流；此处仅提示，明细见收件箱。
      </span>
    </div>
  );
}