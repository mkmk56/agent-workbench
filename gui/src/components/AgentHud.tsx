import { Circle, Hourglass, Mail, Play, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import dshMark from '../assets/sidebar/dsh-mark.png';
import claudeMark from '../assets/sidebar/claude-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import type { EngineStatus } from '../types';
import {
  hudElapsedLabel,
  useHudConfig,
  useHudData,
  type HudAgentId,
  type HudSlot,
  type HudState,
} from '../lib/hud';
import { navigate } from '../lib/router';
import { PaperPlaneLayer } from './PaperPlaneLayer';

const GLYPHS: Record<HudAgentId, string> = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

function AgentGlyph({ id, size }: { id: HudAgentId; size: number }) {
  return (
    <img
      className="hud-glyph"
      src={GLYPHS[id]}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

const STATE_ICONS: Record<HudState, ReactNode> = {
  idle: <Circle size={9} strokeWidth={2.2} aria-hidden="true" />,
  working: (
    <Play size={8} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
  ),
  waiting: <Hourglass size={9} strokeWidth={2.2} aria-hidden="true" />,
  error: <TriangleAlert size={9} strokeWidth={2.2} aria-hidden="true" />,
};

function slotAria(slot: HudSlot): string {
  const parts = [`${slot.name}`, slot.statusText];
  if (slot.activeCount > 0) {
    parts.push(`${slot.activeCount} 个活跃任务`);
  }
  if (slot.unread > 0) {
    parts.push(`${slot.unread} 条未读`);
  }
  if (slot.queued > 0) {
    parts.push(`${slot.queued} 条消息排队待发`);
  }
  return parts.join('，');
}

function StatusBadge({ state, label }: { state: HudState; label: string }) {
  return (
    <span className={`hud-badge hud-badge--${state}`}>
      {STATE_ICONS[state]}
      <span>{label}</span>
    </span>
  );
}

function HudPopover({ slot, note, id }: { slot: HudSlot; note?: string; id: string }) {
  return (
    <div className="hud-popover" role="tooltip" id={id}>
      <div className="hud-popover__head">
        <span className="hud-popover__icon" aria-hidden="true">
          <AgentGlyph id={slot.id} size={18} />
        </span>
        <span className="hud-popover__name">{slot.name}</span>
        <StatusBadge state={slot.state} label={slot.statusText} />
      </div>
      <p className="hud-popover__detail">{slot.detail}</p>
      {note != null && (
        <p className="hud-popover__error">
          <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />
          <span>{note}</span>
        </p>
      )}
      <dl className="hud-popover__meta">
        <dt>模型</dt>
        <dd>{slot.model}</dd>
        <dt>活跃任务</dt>
        <dd className="num">{slot.activeCount}</dd>
        <dt>本轮用时</dt>
        <dd className="num">{hudElapsedLabel(slot.elapsedMs)}</dd>
        <dt>未读</dt>
        <dd className="num">{slot.unread}</dd>
        {slot.queued > 0 && (
          <>
            <dt>排队消息</dt>
            <dd className="num">{slot.queued}</dd>
          </>
        )}
      </dl>
      <div className="hud-popover__hint">
        {slot.taskId != null ? '单击打开对应会话' : '单击查看任务列表'}
      </div>
    </div>
  );
}

/**
 * Persistent Agent HUD: an ink capsule with one slot per role. Identity is
 * carried by the lucide glyph shape; status by ring colour + glyph badge +
 * text in the hover card. No glow, gradients, glass or emoji.
 */
export function AgentHud({ engine }: { engine: EngineStatus | null }) {
  const { config } = useHudConfig();
  const { slots, flights, markRead, messagesError, messagesSaturated } = useHudData(
    engine,
    config.paperPlanes,
  );
  const [queued, setQueued] = useState<Partial<Record<HudAgentId, number>>>({});
  const [flashNonce, setFlashNonce] = useState<Record<HudAgentId, number>>({
    muse: 0,
    claude: 0,
    dsh: 0,
  });

  const onArrive = useCallback((agent: HudAgentId) => {
    setFlashNonce((current) => ({ ...current, [agent]: (current[agent] ?? 0) + 1 }));
  }, []);

  const onQueueChange = useCallback((counts: Partial<Record<HudAgentId, number>>) => {
    setQueued(counts);
  }, []);

  const openSlot = (slot: HudSlot) => {
    markRead(slot.id);
    if (slot.taskId != null) {
      navigate(`/tasks/${slot.taskId}`);
    } else {
      navigate('/tasks');
    }
  };

  return (
    <>
      <PaperPlaneLayer
        flights={flights}
        enabled={config.paperPlanes}
        onArrive={onArrive}
        onQueueChange={onQueueChange}
      />
      <nav className="hud" aria-label="Agent 状态侧栏">
        {slots.map((slot) => {
          const queueCount = queued[slot.id] ?? 0;
          const tipId = `hud-tip-${slot.id}`;
          const notes: string[] = [];
          if (slot.id === 'muse') {
            if (messagesError != null) {
              notes.push(`消息读取失败：${messagesError}（未读与纸飞机可能不完整）`);
            }
            if (messagesSaturated) {
              notes.push(
                '消息窗口已满（list_messages 500 条上限）：未读与纸飞机将停止更新，重启 GUI 也不能恢复。',
              );
            }
          }
          return (
            <div className="hud-slot" key={slot.id}>
              <button
                type="button"
                className={`hud-slot__button hud-slot__button--${slot.state}`}
                data-hud-agent={slot.id}
                aria-label={slotAria({ ...slot, queued: queueCount })}
                aria-describedby={tipId}
                onClick={() => openSlot(slot)}
              >
                <svg className="hud-ring" viewBox="0 0 44 44" aria-hidden="true">
                  <circle className="hud-ring__track" cx="22" cy="22" r="20" />
                  <circle
                    className={`hud-ring__arc hud-ring__arc--${slot.state}`}
                    cx="22"
                    cy="22"
                    r="20"
                  />
                </svg>
                <span className="hud-slot__glyph" aria-hidden="true">
                  <AgentGlyph id={slot.id} size={24} />
                </span>
                {STATE_ICONS[slot.state] != null && (
                  <span
                    className={`hud-slot__state hud-slot__state--${slot.state}`}
                    aria-hidden="true"
                  >
                    {STATE_ICONS[slot.state]}
                  </span>
                )}
                {slot.unread > 0 && (
                  <span className="hud-slot__unread" aria-hidden="true">
                    {slot.unread > 99 ? '99+' : slot.unread}
                  </span>
                )}
                {queueCount > 0 && (
                  <span
                    className="hud-slot__queue"
                    aria-hidden="true"
                    title={`${queueCount} 条消息排队待发`}
                  >
                    <Mail size={9} strokeWidth={2.2} />
                  </span>
                )}
                {flashNonce[slot.id] > 0 && (
                  <span
                    key={flashNonce[slot.id]}
                    className="hud-slot__flash"
                    aria-hidden="true"
                  />
                )}
              </button>
              <HudPopover
                id={tipId}
                slot={{ ...slot, queued: queueCount }}
                note={notes.length > 0 ? notes.join(' ') : undefined}
              />
            </div>
          );
        })}
      </nav>
    </>
  );
}