import { BellRing, Check } from '../ui/icons';
import { JOIN_NOTICES_POLL_MS, useJoinNotices } from '../lib/join-notices';
import { navigate } from '../lib/router';
import '../styles/community.css';

/**
 * REA Phase 5 §4.7 — the per-chat join-request banner.
 *
 * Shown only while the chat has unread `join_request_notices` rows addressed to
 * this viewer. "查看申请" jumps to the chat's settings page (the request list
 * lives there); "知道了" runs `chat_join_notices` mark_read=all for this chat
 * and hides the banner from the next poll. Notices never enter the message
 * stream.
 *
 * A failing poll is surfaced instead of hidden: without it the banner would
 * silently disappear while the engine still holds unread notices, which looks
 * exactly like "nothing to do" (§4.7 read/write honesty).
 */
export function JoinNoticeBanner({ chatId }: { chatId: string }) {
  const notices = useJoinNotices({ chatId, pollMs: JOIN_NOTICES_POLL_MS });
  const hasUnread = notices.unread.length > 0;
  if (!hasUnread && notices.error == null) {
    return null;
  }
  return (
    <div className="join-banner" role="status">
      <BellRing size={14} aria-hidden="true" />
      <span className="join-banner__text">
        {hasUnread
          ? `有 ${notices.unread.length} 条加入申请通知，群主可在群设置页处理。`
          : '加入申请通知暂时读取不到。'}
        {notices.error != null && (
          <span className="join-banner__error" role="alert">
            {notices.error}
          </span>
        )}
      </span>
      <span className="join-banner__actions">
        {hasUnread && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => navigate(`/chats/${encodeURIComponent(chatId)}/settings`)}
          >
            查看申请
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={notices.loading || !hasUnread}
          onClick={() => void notices.markChatRead(chatId)}
        >
          <Check size={12} aria-hidden="true" />
          知道了
        </button>
      </span>
    </div>
  );
}