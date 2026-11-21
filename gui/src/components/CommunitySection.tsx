import {
  Check,
  CircleAlert,
  Compass,
  RefreshCw,
  UserCheck,
  Users,
  X,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listChatsOnce } from '../lib/chat';
import {
  approveJoinRequest,
  categoryLabel,
  declineJoinRequest,
  listAgentsDirectoryOnce,
  listJoinRequestsOnce,
  listPublicChatsOnce,
  memberCountLabel,
} from '../lib/community';
import { formatRelative } from '../lib/labels';
import type { AgentDirectoryEntry, JoinRequest, PublicChat } from '../types';
import '../styles/community.css';

/**
 * REA Phase 5 §4.5 — the "社区" section of the settings page (human/master).
 *
 * Three read-mostly lists, all from the frozen tools:
 *  - public chats on this machine (`list_public_chats`)
 *  - every pending join request across chats (`chat_join_list`), owner may decide
 *  - the global agent directory (`list_agents`)
 *
 * Mutations reuse the same engine tools as the chat settings page; a refusal is
 * displayed verbatim and the lists are re-read afterwards.
 */
export function CommunitySection() {
  const [publicChats, setPublicChats] = useState<PublicChat[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [agents, setAgents] = useState<AgentDirectoryEntry[]>([]);
  const [chatNames, setChatNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [chatsResult, publicResult, requestsResult, agentsResult] = await Promise.all([
      listChatsOnce(),
      listPublicChatsOnce({ limit: 200 }),
      listJoinRequestsOnce({ status: 'pending', limit: 100 }),
      listAgentsDirectoryOnce({ limit: 100 }),
    ]);
    setLoading(false);

    if (chatsResult.ok) {
      setChatNames(
        new Map(chatsResult.data.map((chat) => [chat.chat_id, chat.name])),
      );
    }
    if (publicResult.ok) {
      setPublicChats(publicResult.data.chats);
      setChatError(null);
    } else {
      setChatError(publicResult.error);
    }
    if (requestsResult.ok) {
      setRequests(requestsResult.data.requests);
      setRequestError(null);
    } else {
      setRequestError(requestsResult.error);
    }
    if (agentsResult.ok) {
      setAgents(agentsResult.data.agents);
      setAgentError(null);
    } else {
      setAgentError(agentsResult.error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (request: JoinRequest, approve: boolean) => {
    setDeciding(request.request_id);
    setRequestError(null);
    try {
      const result = approve
        ? await approveJoinRequest(request.request_id)
        : await declineJoinRequest({ requestId: request.request_id });
      if (!result.ok) {
        setRequestError(result.error);
        return;
      }
      await load();
    } finally {
      setDeciding(null);
    }
  };

  const ownerCount = useMemo(
    () => agents.filter((agent) => agent.owner === 'user').length,
    [agents],
  );

  return (
    <div className="community-section">
      <div className="community-toolbar">
        <span className="community-block__hint">
          全部为本地数据，不会对外发布。列表来自 list_public_chats / chat_join_list / list_agents。
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={13} aria-hidden="true" />
          刷新
        </button>
      </div>

      <div className="community-block" aria-label="公开群组一览">
        <div className="community-block__head">
          <h3 className="community-block__title">
            <Compass size={13} aria-hidden="true" /> 公开群组一览
            <span className="inbox-join-panel__count">{publicChats.length}</span>
          </h3>
        </div>
        {chatError != null && (
          <p className="community-error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {chatError}
          </p>
        )}
        {publicChats.length === 0 ? (
          <p className="community-empty">
            本机还没有公开群组。在群设置的「可见性」里切到「本机公开」后会出现在这里。
          </p>
        ) : (
          <ul className="community-list">
            {publicChats.map((chat) => (
              <li key={chat.chat_id} className="community-row">
                <span className="community-row__main">
                  <span className="community-row__title">{chat.name}</span>
                  <span className="community-row__meta">
                    {categoryLabel(chat.category)} · {memberCountLabel(chat.member_count)}
                    {chat.created_at != null
                      ? ` · 创建于 ${formatRelative(chat.created_at)}`
                      : ''}
                  </span>
                </span>
                <span className="community-tags">
                  <span className="role-badge">本机公开</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="community-block" aria-label="跨群待处理申请">
        <div className="community-block__head">
          <h3 className="community-block__title">
            <Users size={13} aria-hidden="true" /> 全部待处理申请
            <span className="inbox-join-panel__count">{requests.length}</span>
          </h3>
        </div>
        {requestError != null && (
          <p className="community-error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {requestError}
          </p>
        )}
        {requests.length === 0 ? (
          <p className="community-empty">没有跨群待处理申请。</p>
        ) : (
          <ul className="community-list">
            {requests.map((request) => (
              <li key={request.request_id} className="community-row">
                <span className="community-row__main">
                  <span className="community-row__title">
                    {request.applicant.display_name}
                    <span className="role-badge">{request.applicant.platform ?? 'agent'}</span>
                  </span>
                  <span className="community-row__meta">
                    申请加入「{chatNames.get(request.chat_id) ?? request.chat_id}」
                    {request.created_at != null
                      ? ` · ${formatRelative(request.created_at)}`
                      : ''}
                  </span>
                  {request.message != null && request.message.length > 0 && (
                    <span className="community-row__meta">「{request.message}」</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm community-row__action"
                  disabled={deciding != null}
                  onClick={() => void decide(request, true)}
                >
                  <Check size={12} aria-hidden="true" />
                  批准
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm community-row__action"
                  disabled={deciding != null}
                  onClick={() => void decide(request, false)}
                >
                  <X size={12} aria-hidden="true" />
                  拒绝
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="community-block" aria-label="全局 Agent 目录">
        <div className="community-block__head">
          <h3 className="community-block__title">
            <UserCheck size={13} aria-hidden="true" /> 全局 Agent 目录
            <span className="inbox-join-panel__count">{agents.length}</span>
          </h3>
        </div>
        {agentError != null && (
          <p className="community-error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            {agentError}
          </p>
        )}
        {agents.length === 0 ? (
          <p className="community-empty">还没有已配对的 Agent。</p>
        ) : (
          <ul className="community-list">
            {agents.map((agent) => (
              <li key={agent.agent_id} className="community-row">
                <span className="community-row__main">
                  <span className="community-row__title">
                    {agent.display_name}
                    <span className="role-badge">{agent.platform ?? 'agent'}</span>
                    <span
                      className={`join-status join-status--${agent.status === 'active' ? 'approved' : 'declined'}`}
                    >
                      {agent.status}
                    </span>
                  </span>
                  <span className="community-row__meta">
                    所属账号 {agent.owner ?? '—'} · 所在群 {agent.chat_count} 个
                    {agent.profile != null && agent.profile.length > 0
                      ? ` · ${agent.profile}`
                      : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="community-block__hint">
          本机账号拥有的 Agent {ownerCount} 个；Agent token 调 list_agents 只能看到自己与同群成员。
        </p>
      </div>
    </div>
  );
}