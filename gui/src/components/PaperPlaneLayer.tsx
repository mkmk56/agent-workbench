import { useEffect, useRef } from 'react';
import type { HudAgentId, HudExecutorId, HudFlight } from '../lib/hud';

interface Point {
  x: number;
  y: number;
}

interface Plane {
  seq: number;
  from: HudExecutorId;
  to: HudExecutorId;
  p0: Point;
  p1: Point;
  p2: Point;
  startedAt: number;
  duration: number;
  endedAt: number | null;
}

const MAX_ACTIVE = 3;
const STAGGER_MS = 180;
const TRAIL_FADE_MS = 400;

function easeOutQuint(t: number): number {
  // Approximation of cubic-bezier(0.22, 1, 0.36, 1); monotonic and stable
  // enough for a 600–900 ms flight.
  return 1 - (1 - t) ** 5;
}

function slotCenter(agent: HudExecutorId): Point | null {
  const node = document.querySelector<HTMLElement>(`[data-hud-agent="${agent}"]`);
  if (node == null) {
    return null;
  }
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function buildPlane(flight: HudFlight): Plane | null {
  const from = slotCenter(flight.from);
  const to = slotCenter(flight.to);
  if (from == null || to == null) {
    return null;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    return null;
  }
  const ux = dx / length;
  const uy = dy / length;
  const p0 = { x: from.x + ux * 22, y: from.y + uy * 22 };
  const p2 = to;
  let px = -uy;
  let py = ux;
  // Bow toward the inside of the window, never outside the capsule.
  if (px < 0) {
    px = -px;
    py = -py;
  }
  const bend = length * 0.25;
  const p1 = {
    x: (p0.x + p2.x) / 2 + px * bend,
    y: (p0.y + p2.y) / 2 + py * bend,
  };
  return {
    seq: flight.seq,
    from: flight.from,
    to: flight.to,
    p0,
    p1,
    p2,
    startedAt: 0,
    duration: 600 + Math.min(300, length * 2.7),
    endedAt: null,
  };
}

function pointAt(plane: Plane, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * plane.p0.x + 2 * u * t * plane.p1.x + t * t * plane.p2.x,
    y: u * u * plane.p0.y + 2 * u * t * plane.p1.y + t * t * plane.p2.y,
  };
}

function tangentAt(plane: Plane, t: number): number {
  const u = 1 - t;
  const dx = 2 * u * (plane.p1.x - plane.p0.x) + 2 * t * (plane.p2.x - plane.p1.x);
  const dy = 2 * u * (plane.p1.y - plane.p0.y) + 2 * t * (plane.p2.y - plane.p1.y);
  return Math.atan2(dy, dx);
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  plane: Plane,
  end: number,
  alpha: number,
): void {
  if (end <= 0 || alpha <= 0) {
    return;
  }
  const steps = 24;
  ctx.save();
  ctx.beginPath();
  for (let index = 0; index <= steps; index += 1) {
    const point = pointAt(plane, (end * index) / steps);
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(138, 143, 152, ${Math.min(1, alpha).toFixed(3)})`;
  ctx.stroke();
  ctx.restore();
}

function drawPlane(ctx: CanvasRenderingContext2D, plane: Plane, progress: number): void {
  const point = pointAt(plane, progress);
  const angle = tangentAt(plane, progress);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(-6, 5);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-6, -5);
  ctx.closePath();
  ctx.fillStyle = '#F5F3EE';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1E2126';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(-3, 0);
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#8A8F98';
  ctx.stroke();
  ctx.restore();
}

/**
 * Canvas overlay for agent-to-agent messages. It is pointer-events: none and
 * only paints while a flight or its fading trail exists.
 */
export function PaperPlaneLayer({
  flights,
  enabled,
  onArrive,
  onQueueChange,
}: {
  flights: HudFlight[];
  enabled: boolean;
  onArrive: (agent: HudAgentId) => void;
  onQueueChange: (counts: Partial<Record<HudAgentId, number>>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const queue = useRef<HudFlight[]>([]);
  const active = useRef<Plane[]>([]);
  const fading = useRef<Plane[]>([]);
  const seen = useRef<number>(0);
  const initialized = useRef(false);
  const raf = useRef<number | null>(null);
  const pumpTimer = useRef<number | null>(null);
  const zeroTimers = useRef<Set<number>>(new Set());
  const lastStart = useRef(0);
  const enabledRef = useRef(enabled);
  const arriveRef = useRef(onArrive);
  const queueRef = useRef(onQueueChange);

  arriveRef.current = onArrive;
  queueRef.current = onQueueChange;

  const reportQueue = (): void => {
    const counts: Partial<Record<HudAgentId, number>> = {};
    for (const flight of queue.current) {
      counts[flight.from] = (counts[flight.from] ?? 0) + 1;
    }
    queueRef.current(counts);
  };

  const pump = (): void => {
    if (pumpTimer.current != null) {
      window.clearTimeout(pumpTimer.current);
      pumpTimer.current = null;
    }
    if (!enabledRef.current) {
      if (queue.current.length > 0) {
        queue.current = [];
        reportQueue();
      }
      return;
    }
    const now = performance.now();
    if (
      active.current.length < MAX_ACTIVE &&
      queue.current.length > 0 &&
      now - lastStart.current >= STAGGER_MS - 8
    ) {
      const flight = queue.current.shift();
      if (flight != null) {
        const plane = buildPlane(flight);
        if (plane != null) {
          plane.startedAt = now;
          active.current.push(plane);
          lastStart.current = now;
          ensureLoop();
        }
      }
      reportQueue();
    }
    if (queue.current.length > 0) {
      const wait =
        active.current.length >= MAX_ACTIVE
          ? 140
          : Math.max(40, STAGGER_MS - (performance.now() - lastStart.current));
      pumpTimer.current = window.setTimeout(pump, wait);
    }
  };

  const ensureLoop = (): void => {
    if (raf.current == null) {
      raf.current = window.requestAnimationFrame(draw);
    }
  };

  const draw = (): void => {
    raf.current = null;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas == null || context == null) {
      return;
    }
    const now = performance.now();
    const width = window.innerWidth;
    const height = window.innerHeight;
    context.clearRect(0, 0, width, height);

    const remaining: Plane[] = [];
    for (const plane of active.current) {
      const raw = Math.min(1, (now - plane.startedAt) / plane.duration);
      const progress = easeOutQuint(raw);
      drawTrail(context, plane, progress, 0.45);
      if (raw < 1) {
        drawPlane(context, plane, progress);
        remaining.push(plane);
      } else {
        plane.endedAt = now;
        fading.current.push(plane);
        arriveRef.current(plane.to);
        const timer = window.setTimeout(() => {
          zeroTimers.current.delete(timer);
          pump();
        }, 0);
        zeroTimers.current.add(timer);
      }
    }
    active.current = remaining;

    fading.current = fading.current.filter((plane) => {
      const elapsed = now - (plane.endedAt ?? now);
      if (elapsed >= TRAIL_FADE_MS) {
        return false;
      }
      drawTrail(context, plane, 1, 0.45 * (1 - elapsed / TRAIL_FADE_MS));
      return true;
    });

    if (active.current.length > 0 || fading.current.length > 0) {
      ensureLoop();
    }
  };

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      queue.current = [];
      reportQueue();
    } else {
      pump();
    }
    // reportQueue and pump only read refs; nothing else to depend on here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    const latest = flights.reduce((max, flight) => Math.max(max, flight.seq), 0);
    if (!initialized.current) {
      // Do not replay history when the panel mounts.
      initialized.current = true;
      seen.current = latest;
      return;
    }
    const fresh = flights.filter((flight) => flight.seq > seen.current);
    if (fresh.length === 0) {
      return;
    }
    seen.current = latest;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!enabled || reduced) {
      for (const flight of fresh) {
        arriveRef.current(flight.to);
      }
      return;
    }
    queue.current.push(...fresh);
    reportQueue();
    pump();
    // enqueue helper only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, enabled]);

  useEffect(() => {
    const resize = (): void => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas == null || context == null) {
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * ratio);
      canvas.height = Math.floor(window.innerHeight * ratio);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      ensureLoop();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (raf.current != null) {
        window.cancelAnimationFrame(raf.current);
        raf.current = null;
      }
      if (pumpTimer.current != null) {
        window.clearTimeout(pumpTimer.current);
        pumpTimer.current = null;
      }
      for (const timer of zeroTimers.current) {
        window.clearTimeout(timer);
      }
      zeroTimers.current.clear();
    };
    // resize/loop setup is mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="plane-layer" aria-hidden="true" />;
}