import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import {
  MENTION_HANDLES,
  clampMenuPosition,
  type MenuPoint,
  type MenuPlacement,
} from '../lib/mention-menu';
import type { ChatAgentId } from '../types';

const MARKS: Record<ChatAgentId, string> = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

const NAMES: Record<ChatAgentId, string> = {
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

/**
 * Avatar right-click menu: a single "@ this agent" item.
 *
 * Rendered through a portal into `document.body` as a fixed box, so the chat
 * stream's own scrolling container never clips it. It only holds the one
 * mention action (no other entries), closes on Escape or a click anywhere
 * outside, and positions itself through `clampMenuPosition` so it flips left /
 * up instead of running past the window edge.
 */
export function AgentMentionMenu({
  agent,
  point,
  onPick,
  onClose,
}: {
  agent: ChatAgentId;
  /** Pointer position of the `contextmenu` event (fixed coordinates). */
  point: MenuPoint;
  onPick: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRef = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  // Measure after the first paint pass, then pin the menu inside the viewport.
  useLayoutEffect(() => {
    const element = menuRef.current;
    const width = element?.offsetWidth ?? 0;
    const height = element?.offsetHeight ?? 0;
    setPlacement(
      clampMenuPosition({
        x: point.x,
        y: point.y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
    // A pointer menu is a keyboard-visible surface too: the item takes focus so
    // Enter activates it and Escape closes it without moving a mouse.
    itemRef.current?.focus();
  }, [point.x, point.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu != null && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // The menu is anchored to a point on screen: scrolling the stream or
    // resizing the window would leave it floating over the wrong message.
    const onDetach = () => onClose();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onDetach, true);
    window.addEventListener('resize', onDetach);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onDetach, true);
      window.removeEventListener('resize', onDetach);
    };
  }, [onClose]);

  const name = NAMES[agent];
  const handle = MENTION_HANDLES[agent];

  return createPortal(
    <div
      ref={menuRef}
      className="chat-avatar-menu"
      role="menu"
      aria-label={`提及 ${name}`}
      style={{
        left: placement?.left ?? point.x,
        top: placement?.top ?? point.y,
        // Hidden for the one measuring frame, so the menu never flashes at the
        // unclamped pointer position.
        visibility: placement == null ? 'hidden' : 'visible',
      }}
    >
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        className="chat-avatar-menu__item"
        aria-label={`插入 @${handle}，提及 ${name}`}
        onClick={onPick}
      >
        <img className="chat-avatar-menu__mark" src={MARKS[agent]} alt="" draggable={false} />
        <span className="chat-avatar-menu__name">{name}</span>
        <span className="chat-avatar-menu__handle">@{handle}</span>
      </button>
    </div>,
    document.body,
  );
}