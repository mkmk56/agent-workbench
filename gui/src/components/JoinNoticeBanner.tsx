import { BellRing, Check } from '../ui/icons';
import { useJoinNotices } from '../lib/join-notices';
import { navigate } from '../lib/router';
import '../styles/community.css';

/**
 * REA Phase 5 §4.7 — the per-chat join-request banner.
 *
 * Shown only while the chat has unread `join_request_notices` rows. "查看申请"
 * jumps to the chat's settings page (the request list lives there); "知道了"
 * runs the real `chat_join_notices` mark_read for this chat and hides the banner
 * from the next poll. Notices never enter the message stream.
 */
export function JoinNoticeBanner({ chatId }: { chatId: string }) {
  const notices = useJoinNotices({ chatId, pollMs: 10_000 });
  if (notices.unread.length === 0) {
    return null;
  }
  return (
    <div className="join-banner" role="status">
      <BellRing size={14} aria-hidden="true" />
      <span className="join-banner__text">
        有 {notices.unread.length} 条加入申请通知，群主可在群设置页处理。
      </span>
      <span className="join-banner__actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => navigate(`/chats/${encodeURIComponent(chatId)}/settings`)}
        >
          查看申请
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={notices.loading}
          onClick={() => void notices.markChatRead(chatId)}
        >
          <Check size={12} aria-hidden="true" />
          知道了
        </button>
      </span>
    </div>
  );
}