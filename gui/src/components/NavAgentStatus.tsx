import { CircleCheck, Clock3, TriangleAlert } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import {
  agentActivity,
  availabilityTone,
  executorAvailability,
  latestAgentMessage,
  type AgentId,
  type ExecutorAgent,
} from '../lib/agent-status';
import { useChatMessagesView, useChatStatusView } from '../lib/chat-store';
import { useAgentInfo } from '../lib/engine';

const AGENTS: { id: AgentId; name: string }[] = [
  { id: 'muse', name: 'Muse' },
  { id: 'claude', name: 'Claude' },
  { id: 'dsh', name: 'dsh' },
];

const MARKS: Record<AgentId, string> = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

const ACTIVITY_ICON = {
  check: CircleCheck,
  alert: TriangleAlert,
  clock: Clock3,
} as const;

/**
 * Agent status cards on the nav rail (task §1).
 *
 * Each rail avatar opens a card on hover or keyboard focus with:
 *  - name;
 *  - state — from `chat_status` when a chat is open, otherwise the executor
 *    availability the engine reports in `agent_info`;
 *  - the agent's newest message in the open chat (real message text + real
 *    timestamp);
 *  - "最近动态" with two distinguishable styles: a check icon + "任务已完成" or
 *    an alert icon + the blockage wording, so the difference never relies on
 *    colour alone.
 *
 * There is no quota/usage/token-budget source in the engine, so the card shows
 * **no** percentage and no progress bar — a missing fact is simply not drawn.
 * The HUD (AgentHud.tsx / hud.css / its portal) is untouched: this block is a
 * separate rail section with its own class names.
 *
 * The card is positioned with `position: fixed` from the avatar's rect: the rail
 * scrolls (`overflow-y: auto`), so an absolutely positioned card would be
 * clipped by the column.
 */
export function NavAgentStatus({ chatId }: { chatId: string | null }) {
  const { agents } = useAgentInfo(30_000);
  const [openId, setOpenId] = useState<AgentId | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeNow = useCallback(() => {
    cancelClose();
    anchorRef.current = null;
    setOpenId(null);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      anchorRef.current = null;
      setOpenId(null);
    }, 140);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const show = (id: AgentId, element: HTMLElement | null) => {
    if (element == null) {
      return;
    }
    cancelClose();
    anchorRef.current = element;
    setOpenId(id);
  };

  return (
    <div className="nav-rail__agents" role="group" aria-label="Agent 状态卡">
      {AGENTS.map((agent) => {
        const availability = executorAvailability(agents, agent.id);
        const tone = availabilityTone(availability);
        const isOpen = openId === agent.id;
        return (
          <button
            key={agent.id}
            type="button"
            className={`nav-agent${isOpen ? ' is-open' : ''}`}
            aria-label={`${agent.name} 状态卡`}
            aria-describedby={isOpen ? `nav-agent-card-${agent.id}` : undefined}
            title={`${agent.name} · ${availability.detail}`}
            onMouseEnter={(event) => show(agent.id, event.currentTarget)}
            onMouseLeave={scheduleClose}
            onFocus={(event) => show(agent.id, event.currentTarget)}
            onBlur={scheduleClose}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && isOpen) {
                event.preventDefault();
                closeNow();
              }
            }}
            onClick={(event) => show(agent.id, event.currentTarget)}
          >
            <img src={MARKS[agent.id]} alt="" draggable={false} />
            <span className={`nav-agent__dot nav-agent__dot--${tone}`} aria-hidden="true" />
          </button>
        );
      })}

      {openId != null && anchorRef.current != null && (
        <NavAgentCard
          agentId={openId}
          chatId={chatId}
          agents={agents}
          anchor={anchorRef.current}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}

function NavAgentCard({
  agentId,
  chatId,
  agents,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: {
  agentId: AgentId;
  chatId: string | null;
  agents: ExecutorAgent[];
  anchor: HTMLElement;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const definition = AGENTS.find((agent) => agent.id === agentId) ?? AGENTS[0];
  const availability = executorAvailability(agents, agentId);
  // Subscribed only while the card exists: the rail itself never keeps the chat
  // poller alive on non-chat routes.
  const { status, loading } = useChatStatusView(chatId);
  const { messages } = useChatMessagesView(chatId);
  const agentState = status == null ? null : (status[agentId] ?? null);
  const latest = chatId == null ? null : latestAgentMessage(messages, agentId);
  const activity =
    agentState != null
      ? agentActivity(agentState.state, agentId)
      : {
          kind: 'neutral' as const,
          icon: 'clock' as const,
          label:
            availability.available === false
              ? '最近：执行器不可用'
              : '最近：未选中群聊，没有实时动态',
        };
  const ActivityIcon = ACTIVITY_ICON[activity.icon];

  const stateLine =
    chatId == null
      ? availability.detail
      : agentState != null
        ? agentState.task_id != null
          ? `${agentState.label} · 任务 #${agentState.task_id.slice(0, 8)}`
          : agentState.label
        : loading
          ? '读取群聊状态…'
          : availability.detail;

  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const card = cardRef.current;
    if (card == null) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const height = card.offsetHeight;
    const left = Math.round(rect.right + 8);
    const top = Math.round(
      Math.max(8, Math.min(rect.top - 6, window.innerHeight - height - 8)),
    );
    setPosition((current) =>
      current != null && current.left === left && current.top === top
        ? current
        : { left, top },
    );
  }, [anchor]);

  useLayoutEffect(() => {
    place();
  }, [place, messages, status, activity.label, stateLine]);

  useEffect(() => {
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  return (
    <div
      className="agent-card"
      id={`nav-agent-card-${agentId}`}
      ref={cardRef}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="group"
      aria-label={`${definition.name} 状态`}
    >
      <header className="agent-card__head">
        <span className="agent-card__avatar" aria-hidden="true">
          <img src={MARKS[agentId]} alt="" draggable={false} />
        </span>
        <span className="agent-card__ident">
          <span className="agent-card__name">{definition.name}</span>
          <span className="agent-card__tag">成员</span>
        </span>
        <span
          className={`agent-card__dot agent-card__dot--${availabilityTone(availability)}`}
          aria-hidden="true"
        />
      </header>

      <p className="agent-card__state">{stateLine}</p>

      {latest != null && (
        <div className="agent-card__latest">
          <span className="agent-card__latest-meta">最新消息 · {latest.relative}</span>
          <p className="agent-card__latest-text">{latest.text}</p>
        </div>
      )}

      <p className={`agent-card__activity agent-card__activity--${activity.kind}`}>
        <ActivityIcon size={13} aria-hidden="true" />
        {activity.label}
      </p>
    </div>
  );
}