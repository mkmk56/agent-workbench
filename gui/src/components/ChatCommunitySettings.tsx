import {
  Check,
  CircleAlert,
  Copy,
  Globe,
  KeyRound,
  Link2,
  Lock,
  RefreshCw,
  Ticket,
  UserRound,
  X,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CHAT_CATEGORIES,
  VISIBILITY_OPTIONS,
  approveJoinRequest,
  categoryLabel,
  createGroupInvite,
  declineJoinRequest,
  inviteShareText,
  inviteStatus,
  listGroupInvitesOnce,
  listJoinRequestsOnce,
  memberRoleLabel,
  revokeGroupInvite,
  setChatCategory,
  setChatVisibility,
  visibilityLabel,
} from '../lib/community';
import { formatRelative } from '../lib/labels';
import { copyText } from '../lib/workbench';
import type {
  ChatCategory,
  ChatMember,
  ChatVisibility,
  CreatedGroupInvite,
  GroupInvite,
  JoinRequest,
} from '../types';
import '../styles/community.css';

const VISIBILITY_ICON = {
  private: Lock,
  link: Link2,
  public: Globe,
} as const;

/**
 * REA Phase 5 §4.2 — the community half of the per-chat settings page.
 *
 *  - visibility (owner only) + category (owner or admin, enforced by the engine)
 *  - invite management (owner only): create, copy once, usage, revoke
 *  - join requests (owner may approve/decline; admin may only read)
 *
 * The GUI never decides authorization itself: every button calls the frozen
 * engine tool and shows the refusal verbatim. `isOwner` only controls what is
 * drawn, never what the engine allows.
 */
export function ChatCommunitySettings({
  chatId,
  visibility,
  category,
  members,
  onChanged,
}: {
  chatId: string;
  visibility: ChatVisibility;
  category: string | null;
  members: ChatMember[];
  onChanged: () => void;
}) {
  const isOwner = useMemo(() => members.some((member) => member.role === 'owner'), [members]);
  const isAdmin = useMemo(
    () => isOwner || members.some((member) => member.role === 'admin'),
    [isOwner, members],
  );

  const [draftCategory, setDraftCategory] = useState<string>(category ?? '');
  const [pendingVisibility, setPendingVisibility] = useState<ChatVisibility | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState<ChatVisibility | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [ttlHours, setTtlHours] = useState('24');
  const [maxUses, setMaxUses] = useState('10');
  const [creating, setCreating] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<CreatedGroupInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  useEffect(() => {
    setDraftCategory(category ?? '');
  }, [category]);

  const loadInvites = useCallback(async () => {
    if (!isOwner) {
      setInvites([]);
      return;
    }
    setInvitesLoading(true);
    const result = await listGroupInvitesOnce({ chatId, limit: 50 });
    setInvitesLoading(false);
    if (!result.ok) {
      setInvitesError(result.error);
      return;
    }
    setInvitesError(null);
    setInvites(result.data.invites);
  }, [chatId, isOwner]);

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    const result = await listJoinRequestsOnce({ chatId, status: 'pending', limit: 50 });
    setRequestsLoading(false);
    if (!result.ok) {
      setRequestsError(result.error);
      return;
    }
    setRequestsError(null);
    setRequests(result.data.requests);
  }, [chatId]);

  useEffect(() => {
    void loadInvites();
    void loadRequests();
  }, [loadInvites, loadRequests]);

  const applyVisibility = async (next: ChatVisibility) => {
    setPendingVisibility(null);
    setVisibilityBusy(next);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      const result = await setChatVisibility({ chatId, visibility: next });
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsSaved(`可见性已改为「${visibilityLabel(result.data.visibility)}」。`);
      onChanged();
      // Switching to private auto-declines pending requests and revokes invites
      // in the engine; reload both lists so the GUI never shows stale rows.
      await Promise.all([loadRequests(), loadInvites()]);
    } finally {
      setVisibilityBusy(null);
    }
  };

  const chooseVisibility = (next: ChatVisibility) => {
    if (next === visibility || visibilityBusy != null) {
      return;
    }
    // D1: switching to private is destructive (pending requests declined,
    // invites revoked), so it asks once more instead of firing on click.
    if (next === 'private') {
      setPendingVisibility(next);
      return;
    }
    void applyVisibility(next);
  };

  const saveCategory = async () => {
    const next = (draftCategory === '' ? null : draftCategory) as ChatCategory | null;
    setCategoryBusy(true);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      const result = await setChatCategory({ chatId, category: next });
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsSaved(`分类已保存为「${categoryLabel(result.data.category)}」。`);
      onChanged();
    } finally {
      setCategoryBusy(false);
    }
  };

  const createInvite = async () => {
    setCreating(true);
    setInvitesError(null);
    setCopied(false);
    setCopyError(null);
    try {
      const ttl = Number.parseInt(ttlHours, 10);
      const uses = Number.parseInt(maxUses, 10);
      const result = await createGroupInvite({
        chatId,
        ttlHours: Number.isFinite(ttl) ? ttl : undefined,
        maxUses: Number.isFinite(uses) ? uses : undefined,
      });
      if (!result.ok) {
        setInvitesError(result.error);
        return;
      }
      setCreatedInvite(result.data);
      await loadInvites();
    } finally {
      setCreating(false);
    }
  };

  const copyInvite = async (invite: CreatedGroupInvite) => {
    setCopyError(null);
    const ok = await copyText(inviteShareText(invite.chat_id, invite.code));
    if (ok) {
      setCopied(true);
    } else {
      setCopyError('复制失败：请手动选中邀请码文本。');
    }
  };

  const revokeInvite = async (invite: GroupInvite) => {
    setRevoking(invite.invite_id);
    setInvitesError(null);
    try {
      const result = await revokeGroupInvite(invite.invite_id);
      if (!result.ok) {
        setInvitesError(result.error);
        return;
      }
      await Promise.all([loadInvites(), loadRequests()]);
    } finally {
      setRevoking(null);
    }
  };

  const decide = async (request: JoinRequest, approve: boolean) => {
    setDeciding(request.request_id);
    setRequestsError(null);
    try {
      const result = approve
        ? await approveJoinRequest(request.request_id)
        : await declineJoinRequest({ requestId: request.request_id });
      if (!result.ok) {
        setRequestsError(result.error);
        return;
      }
      await Promise.all([loadRequests(), loadInvites()]);
      if (approve) {
        onChanged();
      }
    } finally {
      setDeciding(null);
    }
  };

  return (
    <>
      <section className="chat-settings-card" aria-label="可见性与分类">
        <h2 className="chat-settings-card__title">可见性与分类</h2>
        <p className="chat-settings-card__hint">
          可见性只由群主修改；分类可由群主或管理员修改。切换为「私有」会作废待处理申请与邀请码。
        </p>

        <div className="visibility-options" role="radiogroup" aria-label="群可见性">
          {VISIBILITY_OPTIONS.map((option) => {
            const Icon = VISIBILITY_ICON[option.value];
            const active = visibility === option.value;
            const busy = visibilityBusy === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`visibility-option${active ? ' is-active' : ''}`}
                disabled={!isOwner || visibilityBusy != null}
                onClick={() => chooseVisibility(option.value)}
              >
                <Icon size={14} className="visibility-option__icon" aria-hidden="true" />
                <span className="visibility-option__text">
                  <span className="visibility-option__label">
                    {option.label}
                    {currentLabel(active, busy)}
                  </span>
                  <span className="visibility-option__hint">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {pendingVisibility != null && (
          <div className="chat-settings-row">
            <span className="chat-settings-card__hint">
              确认切到「私有」？本群全部待处理申请会被拒绝，未撤销邀请码会立即失效。
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={visibilityBusy != null}
              onClick={() => void applyVisibility(pendingVisibility)}
            >
              确认切换
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPendingVisibility(null)}
            >
              取消
            </button>
          </div>
        )}

        <label className="chat-settings-field">
          <span>
            分类{!isAdmin ? '（仅群主或管理员可改）' : ''} · 当前 {categoryLabel(category)}
          </span>
          <select
            className="chat-settings-select"
            value={draftCategory}
            disabled={!isAdmin || categoryBusy}
            aria-label="群分类"
            onChange={(event) => setDraftCategory(event.target.value)}
          >
            <option value="">未分类</option>
            {CHAT_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="chat-settings-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!isAdmin || categoryBusy || (category ?? '') === draftCategory}
            onClick={() => void saveCategory()}
          >
            {categoryBusy ? '保存中…' : '保存分类'}
          </button>
          <span className="chat-settings-card__hint">
            分类是十类枚举；「未分类」保存为 NULL。
          </span>
        </div>

        {settingsError != null && (
          <p className="chat-settings-page__error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {settingsError}
          </p>
        )}
        {settingsSaved != null && (
          <p className="chat-settings-card__ok" role="status">
            {settingsSaved}
          </p>
        )}
      </section>

      <section className="chat-settings-card" aria-label="邀请码管理">
        <h2 className="chat-settings-card__title">邀请码管理（仅群主）</h2>
        {!isOwner ? (
          <p className="chat-settings-card__hint">
            邀请码创建与撤销仅群主可用；管理员可以在下方查看申请，但不能批准或拒绝。
          </p>
        ) : (
          <>
            <p className="chat-settings-card__hint">
              码只在创建时展示一次（32 位 hex，≥128-bit 熵），服务端只存 SHA-256。分享格式为
              chat_id + 空格 + code。
            </p>
            <div className="invite-create-form">
              <label>
                <span>有效期（小时）</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={ttlHours}
                  onChange={(event) => setTtlHours(event.target.value)}
                />
              </label>
              <label>
                <span>可用次数</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxUses}
                  onChange={(event) => setMaxUses(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={creating}
                onClick={() => void createInvite()}
              >
                <Ticket size={13} aria-hidden="true" />
                {creating ? '创建中…' : '创建邀请码'}
              </button>
            </div>

            {createdInvite != null && (
              <div className="invite-created" role="status">
                <span className="invite-created__label">
                  新邀请码（只展示一次，请立即复制）
                </span>
                <div className="invite-created__code">
                  <code>{inviteShareText(createdInvite.chat_id, createdInvite.code)}</code>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void copyInvite(createdInvite)}
                  >
                    <Copy size={13} aria-hidden="true" />
                    {copied ? '已复制' : '复制邀请'}
                  </button>
                </div>
                {copyError != null && (
                  <span className="chat-settings-card__hint">{copyError}</span>
                )}
              </div>
            )}

            <div className="chat-settings-row">
              <span className="chat-settings-card__hint">
                共 {invites.length} 个邀请码（不返回码与哈希）
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={invitesLoading}
                onClick={() => void loadInvites()}
              >
                <RefreshCw size={12} aria-hidden="true" />
                刷新
              </button>
            </div>

            {invitesError != null && (
              <p className="chat-settings-page__error" role="alert">
                <CircleAlert size={13} aria-hidden="true" />
                {invitesError}
              </p>
            )}

            {invites.length === 0 ? (
              <p className="chat-settings-card__hint">
                {invitesLoading ? '正在读取邀请码…' : '还没有邀请码。'}
              </p>
            ) : (
              <ul className="invite-list">
                {invites.map((invite) => {
                  const status = inviteStatus(invite);
                  return (
                    <li key={invite.invite_id} className="invite-row">
                      <span className="invite-row__main">
                        <span className="invite-row__title">
                          <KeyRound size={12} aria-hidden="true" />
                          {invite.invite_id.slice(0, 8)}
                          <span className={`invite-status invite-status--${status.tone}`}>
                            {status.label}
                          </span>
                        </span>
                        <span className="invite-row__meta">
                          用量 {invite.uses}/{invite.max_uses} · 过期{' '}
                          {invite.expires_at != null ? formatRelative(invite.expires_at) : '—'}
                          {invite.created_by != null ? ` · 由 ${invite.created_by} 创建` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        // An expired invite is not revoked: it is dead for joins
                        // but still listed, so allow cleanup. Only an already
                        // revoked (or exhausted) row has nothing to revoke.
                        disabled={
                          revoking === invite.invite_id ||
                          (status.state !== 'active' && status.state !== 'expired')
                        }
                        onClick={() => void revokeInvite(invite)}
                      >
                        <X size={12} aria-hidden="true" />
                        撤销
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="chat-settings-card" aria-label="加入申请">
        <div className="community-block__head">
          <h2 className="chat-settings-card__title">
            加入申请（待处理 {requests.length}）
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={requestsLoading}
            onClick={() => void loadRequests()}
          >
            <RefreshCw size={12} aria-hidden="true" />
            刷新
          </button>
        </div>
        <p className="chat-settings-card__hint">
          {isOwner
            ? '群主可以批准或拒绝；批准后申请人才成为成员并回填收件箱游标。'
            : '管理员只能查看申请，不能批准或拒绝。'}
        </p>

        {requestsError != null && (
          <p className="chat-settings-page__error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {requestsError}
          </p>
        )}

        {requests.length === 0 ? (
          <p className="chat-settings-card__hint">
            {requestsLoading ? '正在读取申请…' : '没有待处理的加入申请。'}
          </p>
        ) : (
          <ul className="join-request-list">
            {requests.map((request) => (
              <li key={request.request_id} className="join-request-row">
                <span className="join-request-row__main">
                  <span className="join-request-row__title">
                    <UserRound size={12} aria-hidden="true" />
                    {request.applicant.display_name}
                    <span className="role-badge">
                      {request.applicant.platform ?? 'agent'}
                    </span>
                  </span>
                  <span className="join-request-row__meta">
                    {request.created_at != null ? formatRelative(request.created_at) : '时间未知'}
                    {request.invite_id != null ? ' · 使用邀请码申请' : ' · 公开群无码申请'}
                  </span>
                  {request.message != null && request.message.length > 0 && (
                    <span className="join-request-row__message">「{request.message}」</span>
                  )}
                </span>
                {isOwner && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={deciding != null}
                      onClick={() => void decide(request, true)}
                    >
                      <Check size={12} aria-hidden="true" />
                      {deciding === request.request_id ? '处理中…' : '批准'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={deciding != null}
                      onClick={() => void decide(request, false)}
                    >
                      <X size={12} aria-hidden="true" />
                      拒绝
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="chat-settings-card__hint">
          当前成员 {members.length} 人 · 角色：
          {members
            .map((member) => `${member.display_name}(${memberRoleLabel(member.role)})`)
            .join('、')}
        </p>
      </section>
    </>
  );
}

function currentLabel(active: boolean, busy: boolean): string {
  if (busy) {
    return '（切换中…）';
  }
  return active ? '（当前）' : '';
}