import {
  CircleAlert,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  X,
} from '../ui/icons';
import { useEffect, useMemo, useState } from 'react';
import { addChatMember, removeChatMember, type ChatMember } from '../lib/chat';
import { memberRoleLabel, setChatRole } from '../lib/community';
import { formatRelative } from '../lib/labels';

const BUILTIN_HANDLES = ['muse', 'claude', 'dsh'] as const;

const BUILTIN_LABELS: Record<(typeof BUILTIN_HANDLES)[number], string> = {
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

function platformLabel(member: ChatMember): string {
  if (member.role === 'owner') {
    return '群主';
  }
  if (member.platform != null && member.platform.length > 0) {
    return member.platform;
  }
  return member.participant_id ?? member.agent_id;
}

function joinedText(member: ChatMember): string {
  if (member.joined_at == null) {
    return '加入时间未知';
  }
  if (typeof member.joined_at === 'number') {
    return `加入于 ${formatRelative(new Date(member.joined_at).toISOString())}`;
  }
  const parsed = Date.parse(member.joined_at);
  return Number.isFinite(parsed) ? `加入于 ${formatRelative(member.joined_at)}` : '加入时间未知';
}

/**
 * REA Phase 4 [C]: the members drawer behind the header member button.
 *
 * The list is the engine's canonical `chat_members` rows, so the header count
 * and this drawer can never disagree. Adding/removing is owner-only in the
 * engine (`chat_add_member` / `chat_remove_member`); the GUI never decides
 * authorization on its own and shows the engine's refusal verbatim.
 *
 * Removing a member does not delete their messages or reassign their tasks
 * (design §6.1), so there is no destructive warning beyond the confirmation.
 */
export function ChatMembersDrawer({
  chatId,
  members,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  chatId: string;
  members: ChatMember[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState<string>('');
  const [customId, setCustomId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);

  // The GUI holds the human token; a group with an owner row is owner-managed.
  // This only decides what is drawn — the engine re-checks every mutation.
  const isOwner = useMemo(() => members.some((member) => member.role === 'owner'), [members]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const present = useMemo(() => new Set(members.map((member) => member.agent_id)), [members]);

  // Only offer agents that are not already in the chat; the engine rejects a
  // duplicate add anyway, but a filtered list is the honest UI.
  const candidates = BUILTIN_HANDLES.filter(
    (handle) => !present.has(handle) && !present.has(`agent_${handle}`),
  );

  const runAdd = async () => {
    const target = adding.length > 0 ? adding : customId.trim();
    if (target.length === 0) {
      setActionError('先选择一个 Agent，或填入已配对 Agent 的 ID。');
      return;
    }
    setBusy('add');
    setActionError(null);
    try {
      const result = await addChatMember({ chatId, agentId: target });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setAdding('');
      setCustomId('');
      onRefresh();
    } finally {
      setBusy(null);
    }
  };

  const runRemove = async (agentId: string) => {
    setConfirmRemove(null);
    setBusy(agentId);
    setActionError(null);
    try {
      const result = await removeChatMember({ chatId, agentId });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      onRefresh();
    } finally {
      setBusy(null);
    }
  };

  /**
   * REA Phase 5 §4.3 / D5: owner-only admin appointment. Only member↔admin is
   * allowed (the engine refuses owner targets); the row refreshes from the
   * engine's canonical chat_members after every attempt.
   */
  const runSetRole = async (member: ChatMember, role: 'admin' | 'member') => {
    setRoleBusy(member.agent_id);
    setActionError(null);
    try {
      const result = await setChatRole({
        chatId,
        agentId: member.agent_id,
        role,
      });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      onRefresh();
    } finally {
      setRoleBusy(null);
    }
  };

  return (
    <>
      <div className="chat-scrim" aria-hidden="true" onClick={onClose} />
      <aside className="members-drawer" role="dialog" aria-label="群成员">
        <header className="members-drawer__head">
          <h2>
            <Users size={15} aria-hidden="true" />
            群成员（{members.length}）
          </h2>
          <div className="members-drawer__head-actions">
            <button
              type="button"
              className="members-drawer__icon-btn"
              aria-label="刷新成员"
              title="刷新"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="members-drawer__icon-btn"
              aria-label="关闭成员面板"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        <p className="members-drawer__note">
          成员来自引擎 chat_members 表，增删需要群主权限（引擎校验）。移除成员不会删除其历史消息。
        </p>

        {error != null && (
          <p className="members-drawer__error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {error}
          </p>
        )}

        <ul className="members-drawer__list">
          {members.map((member) => (
            <li key={member.agent_id} className="members-drawer__row">
              <span
                className="members-drawer__avatar"
                aria-hidden="true"
                style={member.color != null ? { background: member.color } : undefined}
              >
                {member.display_name.slice(0, 1)}
              </span>
              <span className="members-drawer__identity">
                <span className="members-drawer__name">{member.display_name}</span>
                <span className="members-drawer__meta">
                  {platformLabel(member)} · {member.status} · {joinedText(member)}
                </span>
              </span>
              <span className="members-drawer__badges">
                <span
                  className={`role-badge${member.role === 'owner' ? ' role-badge--owner' : member.role === 'admin' ? ' role-badge--admin' : ''}`}
                >
                  {memberRoleLabel(member.role)}
                </span>
                {isOwner && member.role !== 'owner' && (
                  <button
                    type="button"
                    className="members-drawer__role-btn"
                    disabled={roleBusy != null || busy != null}
                    title={
                      member.role === 'admin'
                        ? '撤销管理员（群主可以随时降级）'
                        : '任命为管理员（仅内容与查看权限）'
                    }
                    onClick={() =>
                      void runSetRole(member, member.role === 'admin' ? 'member' : 'admin')
                    }
                  >
                    {roleBusy === member.agent_id
                      ? '处理中…'
                      : member.role === 'admin'
                        ? '撤销管理员'
                        : '设为管理员'}
                  </button>
                )}
              </span>
              {isOwner && member.role !== 'owner' && (
                confirmRemove === member.agent_id ? (
                  <span className="members-drawer__confirm">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy != null}
                      onClick={() => void runRemove(member.agent_id)}
                    >
                      确认移除
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmRemove(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : member.role === 'admin' ? (
                  // D5: an admin must be demoted before removal; the engine
                  // refuses `cannot_remove_admin` anyway, so no dead button.
                  null
                ) : (
                  <button
                    type="button"
                    className="members-drawer__remove"
                    aria-label={`移除 ${member.display_name}`}
                    title="移除成员"
                    disabled={busy != null || roleBusy != null}
                    onClick={() => setConfirmRemove(member.agent_id)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )
              )}
            </li>
          ))}
        </ul>

        {isOwner ? (
          <section className="members-drawer__add" aria-label="添加成员">
            <h3>
              <UserPlus size={13} aria-hidden="true" />
              添加成员
            </h3>
            {candidates.length > 0 ? (
              <div className="members-drawer__candidates">
                {candidates.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className={`members-drawer__candidate${adding === handle ? ' is-active' : ''}`}
                    aria-pressed={adding === handle}
                    onClick={() => setAdding(adding === handle ? '' : handle)}
                  >
                    {BUILTIN_LABELS[handle]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="members-drawer__hint">内置 Agent 都已在群里。</p>
            )}
            <label className="members-drawer__field">
              <span>已配对 Agent ID（可选）</span>
              <input
                type="text"
                value={customId}
                placeholder="agent_xxxxxxxx"
                onChange={(event) => setCustomId(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy != null}
              onClick={() => void runAdd()}
            >
              {busy === 'add' ? '添加中…' : '添加'}
            </button>
            {actionError != null && (
              <p className="members-drawer__error" role="alert">
                <CircleAlert size={13} aria-hidden="true" />
                {actionError}
              </p>
            )}
            <p className="members-drawer__hint">
              上限 50 人（引擎强制）；加入时不会把历史消息算成未读。
            </p>
          </section>
        ) : (
          <p className="members-drawer__hint">
            只有群主可以增删成员与任命管理员；管理员不获得成员管理权限。
          </p>
        )}
      </aside>
    </>
  );
}