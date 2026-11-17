/**
 * Main-window geometry: initial size, restored bounds and the display clamp.
 *
 * Pure math only (no electron imports) so it can be exercised with
 * `node --test`; main.ts owns the file IO and the `screen` lookups.
 *
 * Why this exists (Phase 1 frontend audit, LAY-2): the window used to be a
 * fixed 1440×900 with min 1080×700 and no `screen` lookup at all, so on a
 * 1366×768 or high-scaling display it opened out of bounds and never came
 * back where the user left it.
 */

export type WindowWorkArea = { x: number; y: number; width: number; height: number };
export type WindowBounds = { x: number; y: number; width: number; height: number };
export type StoredWindowState = WindowBounds & { isMaximized: boolean };

export const DEFAULT_WINDOW_WIDTH = 1440;
export const DEFAULT_WINDOW_HEIGHT = 900;
export const MIN_WINDOW_WIDTH = 1080;
export const MIN_WINDOW_HEIGHT = 700;

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    // Work area smaller than the hard minimum (e.g. 125% scaling on a small
    // panel): the display wins, otherwise the window cannot be fitted at all.
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function finiteInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

export type InitialWindowGeometry = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

/** Default size and minimum size, both clamped to the work area. */
export function initialWindowGeometry(workArea: WindowWorkArea): InitialWindowGeometry {
  return {
    width: Math.min(DEFAULT_WINDOW_WIDTH, clamp(workArea.width, 1, Number.MAX_SAFE_INTEGER)),
    height: Math.min(DEFAULT_WINDOW_HEIGHT, clamp(workArea.height, 1, Number.MAX_SAFE_INTEGER)),
    minWidth: Math.min(MIN_WINDOW_WIDTH, workArea.width),
    minHeight: Math.min(MIN_WINDOW_HEIGHT, workArea.height),
  };
}

/**
 * Clamp restored bounds into a work area: the size never exceeds the display
 * and the window always keeps its title bar reachable. A display that no longer
 * exists is handled by the caller (the bounds are clamped to the fallback work
 * area it passes in).
 */
export function clampWindowBounds(bounds: WindowBounds, workArea: WindowWorkArea): WindowBounds {
  const width = clamp(
    finiteInt(bounds.width, DEFAULT_WINDOW_WIDTH),
    Math.min(MIN_WINDOW_WIDTH, workArea.width),
    workArea.width,
  );
  const height = clamp(
    finiteInt(bounds.height, DEFAULT_WINDOW_HEIGHT),
    Math.min(MIN_WINDOW_HEIGHT, workArea.height),
    workArea.height,
  );
  return {
    x: clamp(finiteInt(bounds.x, workArea.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(finiteInt(bounds.y, workArea.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/** Validator for the on-disk `window.json`; anything else is ignored. */
export function isStoredWindowState(value: unknown): value is StoredWindowState {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'];
  if (!numbers.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))) {
    return false;
  }
  return typeof record.isMaximized === 'boolean';
}