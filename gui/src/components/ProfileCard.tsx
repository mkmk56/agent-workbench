import {
  CircleAlert,
  Loader2,
  Pencil,
  Save,
  X,
} from '../ui/icons';
import { useCallback, useEffect, useState } from 'react';
import {
  agentProfileOnce,
  PROFILE_MAX_LENGTH,
  updateAgentProfile,
  type AgentProfileCard,
} from '../lib/chat';

/**
 * Profile Card (REA Phase 2, docs/rea/TARGET_ARCHITECTURE.md D1).
 *
 * Reads through the engine `agent_profile` tool; editing is only offered for
 * agents this workstation's owner owns (`owner === 'user'`), which mirrors the
 * engine rule "an agent may only read/update itself, the owner may manage its
 * own agents". The 300-character cap is enforced here, in the main process and
 * in the engine — the UI never trusts itself with the limit.
 */

const AGENTS = [
  { agentId: 'agent_muse', label: 'Muse' },
  { agentId: 'agent_claude', label: 'Claude' },
  { agentId: 'agent_dsh', label: 'dsh' },
] as const;

const OWNER_ID = 'user';

function canEdit(card: AgentProfileCard | null): boolean {
  if (card == null) {
    return false;
  }
  return card.owner === OWNER_ID && card.status !== 'revoked';
}

function AgentCard({
  agentId,
  fallbackName,
  onChanged,
}: {
  agentId: string;
  fallbackName: string;
  onChanged?: () => void;
}) {
  const [card, setCard] = useState<AgentProfileCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await agentProfileOnce(agentId);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setCard(result.data);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEditing = () => {
    setDraft(card?.profile ?? '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    const result = await updateAgentProfile(agentId, draft);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCard(result.data);
    setError(null);
    setEditing(false);
    onChanged?.();
  };

  const name = card?.display_name ?? fallbackName;
  const editable = canEdit(card);
  const remaining = PROFILE_MAX_LENGTH - draft.length;

  return (
    <li className={`profile-card profile-card--${agentId.replace(/^agent_/, '')}`}>
      <div className="profile-card__head">
        <span className="profile-card__name">{name}</span>
        {card?.platform != null && <span className="profile-card__tag">{card.platform}</span>}
        {card?.status === 'revoked' && <span className="profile-card__tag is-warn">已吊销</span>}
      </div>

      {loading ? (
        <p className="profile-card__status" role="status">
          <Loader2 size={12} aria-hidden="true" />
          正在读取简介…
        </p>
      ) : editing ? (
        <div className="profile-card__edit">
          <label className="sr-only" htmlFor={`profile-input-${agentId}`}>
            {name} 的简介
          </label>
          <textarea
            id={`profile-input-${agentId}`}
            className="profile-card__input"
            value={draft}
            maxLength={PROFILE_MAX_LENGTH}
            rows={4}
            autoFocus
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="profile-card__actions">
            <span className={`profile-card__count${remaining < 20 ? ' is-low' : ''}`}>
              {draft.length} / {PROFILE_MAX_LENGTH}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving}
              onClick={() => void save()}
            >
              <Save size={13} aria-hidden="true" />
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              <X size={13} aria-hidden="true" />
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="profile-card__text">
            {card?.profile != null && card.profile.length > 0 ? card.profile : '还没有填写简介。'}
          </p>
          {error != null && (
            <p className="profile-card__error" role="alert">
              <CircleAlert size={12} aria-hidden="true" />
              {error}
            </p>
          )}
          <div className="profile-card__actions">
            <span className="profile-card__owner">
              {card?.owner === OWNER_ID ? '你名下的 Agent' : `归属：${card?.owner ?? '未知'}`}
            </span>
            {editable && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={startEditing}>
                <Pencil size={12} aria-hidden="true" />
                编辑简介
              </button>
            )}
          </div>
        </>
      )}
      {editing && error != null && (
        <p className="profile-card__error" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          {error}
        </p>
      )}
    </li>
  );
}

/** Panel listing the group's built-in agents with their Profile Cards. */
export function ProfileCardPanel({ onChanged }: { onChanged?: () => void }) {
  return (
    <div className="profile-panel" aria-label="Agent 简介">
      <ul className="profile-panel__list">
        {AGENTS.map((agent) => (
          <AgentCard
            key={agent.agentId}
            agentId={agent.agentId}
            fallbackName={agent.label}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </div>
  );
}