/**
 * Spec checks for the main-window geometry (task book §4, Phase 1 audit LAY-2).
 *
 * Run with: npm run test:layout
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampWindowBounds,
  initialWindowGeometry,
  isStoredWindowState,
} from '../electron/window-state.ts';

const bigScreen = { x: 0, y: 0, width: 2560, height: 1400 };
const smallScreen = { x: 0, y: 0, width: 1093, height: 614 };
const secondary = { x: 2560, y: 0, width: 1920, height: 1080 };

test('default window is 1440×900 with min 1080×700 on a large screen', () => {
  assert.deepEqual(initialWindowGeometry(bigScreen), {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
  });
});

test('default geometry is clamped to a small work area (1366×768 @125%)', () => {
  assert.deepEqual(initialWindowGeometry(smallScreen), {
    width: 1093,
    height: 614,
    minWidth: 1080,
    minHeight: 614,
  });
});

test('restored bounds are clamped into the work area', () => {
  assert.deepEqual(clampWindowBounds({ x: 100, y: 100, width: 1440, height: 900 }, bigScreen), {
    x: 100,
    y: 100,
    width: 1440,
    height: 900,
  });

  // Larger than the display: shrink first, then keep it on screen.
  assert.deepEqual(clampWindowBounds({ x: 0, y: 0, width: 3000, height: 2000 }, bigScreen), {
    x: 0,
    y: 0,
    width: 2560,
    height: 1400,
  });

  // Off-screen position (display removed / resolution changed).
  const rescued = clampWindowBounds({ x: 4000, y: -900, width: 1200, height: 800 }, bigScreen);
  assert.equal(rescued.x, 2560 - 1200);
  assert.equal(rescued.y, 0);

  assert.deepEqual(clampWindowBounds({ x: -50, y: -50, width: 1200, height: 800 }, secondary), {
    x: 2560,
    y: 0,
    width: 1200,
    height: 800,
  });
});

test('restored size never drops below the minimum unless the screen is smaller', () => {
  assert.deepEqual(clampWindowBounds({ x: 0, y: 0, width: 400, height: 300 }, bigScreen), {
    x: 0,
    y: 0,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
  });
  const tiny = clampWindowBounds({ x: 0, y: 0, width: 400, height: 300 }, smallScreen);
  assert.equal(tiny.width, 1080);
  assert.equal(tiny.height, 614);
});

test('stored window state validation', () => {
  const valid = { x: 10, y: 20, width: 1440, height: 900, isMaximized: false };
  assert.equal(isStoredWindowState(valid), true);
  assert.equal(isStoredWindowState({ ...valid, isMaximized: true }), true);
  assert.equal(isStoredWindowState({ x: 10, y: 20, width: 1440, height: 900 }), false);
  assert.equal(isStoredWindowState({ ...valid, width: '1440' }), false);
  assert.equal(isStoredWindowState({ ...valid, x: Number.NaN }), false);
  assert.equal(isStoredWindowState([]), false);
  assert.equal(isStoredWindowState(null), false);
  assert.equal(isStoredWindowState('{}'), false);
});