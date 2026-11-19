/**
 * Spec checks for the avatar right-click "@ this agent" menu (Muse).
 *
 * Run with: npm run test:chat
 *
 * Two invariants are pinned here:
 *  - the inserted text uses exactly the handles the chat parser already
 *    understands, so a right-click mention colours and resolves like a typed
 *    one (no new @ format);
 *  - the menu placement stays inside the viewport, flipping left / up near an
 *    edge instead of overflowing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMentions } from '../src/lib/chat.ts';
import {
  MENU_VIEWPORT_MARGIN,
  MENTION_AGENT_IDS,
  MENTION_HANDLES,
  clampMenuPosition,
  insertMentionAt,
  mentionAgentFor,
} from '../src/lib/mention-menu.ts';

test('only the three built-in agents are @-able', () => {
  assert.deepEqual([...MENTION_AGENT_IDS], ['muse', 'claude', 'dsh']);
  assert.equal(mentionAgentFor('muse'), 'muse');
  assert.equal(mentionAgentFor('claude'), 'claude');
  assert.equal(mentionAgentFor('dsh'), 'dsh');
  // You cannot @ yourself, and a stranger has no handle to insert.
  assert.equal(mentionAgentFor('user'), null);
  assert.equal(mentionAgentFor('unknown'), null);
  assert.equal(mentionAgentFor(''), null);
  assert.equal(mentionAgentFor(null), null);
  assert.equal(mentionAgentFor(undefined), null);
});

test('inserted mentions parse with the existing @ pipeline', () => {
  for (const agent of MENTION_AGENT_IDS) {
    const insertion = insertMentionAt('', agent);
    assert.equal(insertion.text, `@${MENTION_HANDLES[agent]} `);
    assert.equal(insertion.handle, MENTION_HANDLES[agent]);
    const parsed = parseMentions(insertion.text);
    assert.equal(parsed.length, 1, `@${agent} must parse as one mention`);
    assert.equal(parsed[0].id, agent);
  }
});

test('an empty draft becomes just the handle plus a space', () => {
  const insertion = insertMentionAt('', 'muse');
  assert.equal(insertion.text, '@muse ');
  // The caret sits after the trailing space so typing continues there.
  assert.equal(insertion.caret, insertion.text.length);
});

test('a caret at the end keeps a separator before the handle', () => {
  const insertion = insertMentionAt('ping', 'claude', { start: 4, end: 4 });
  assert.equal(insertion.text, 'ping @claude ');
  assert.equal(insertion.caret, insertion.text.length);
});

test('no extra separator when the caret already follows whitespace', () => {
  const insertion = insertMentionAt('ping ', 'dsh', { start: 5, end: 5 });
  assert.equal(insertion.text, 'ping @dsh ');
  assert.equal(insertion.caret, insertion.text.length);
});

test('the caret sits in the middle of the draft when inserted mid-text', () => {
  const insertion = insertMentionAt('hello world', 'muse', { start: 5, end: 5 });
  assert.equal(insertion.text, 'hello @muse  world');
  // Right after the inserted " @muse ", before the existing space.
  assert.equal(insertion.caret, 12);
  assert.equal(parseMentions(insertion.text)[0]?.id, 'muse');
});

test('an active selection is replaced by the mention', () => {
  const insertion = insertMentionAt('hi @old there', 'muse', { start: 3, end: 7 });
  assert.equal(insertion.text, 'hi @muse  there');
  assert.equal(insertion.caret, 9);
  const parsed = parseMentions(insertion.text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'muse');
});

test('out-of-range carets are clamped instead of throwing', () => {
  const past = insertMentionAt('abc', 'muse', { start: 99, end: 99 });
  assert.equal(past.text, 'abc @muse ');
  assert.equal(past.caret, past.text.length);

  const before = insertMentionAt('abc', 'muse', { start: -5, end: -5 });
  assert.equal(before.text, '@muse abc');
  assert.equal(before.caret, '@muse '.length);

  const reversed = insertMentionAt('abc', 'muse', { start: 3, end: 1 });
  assert.equal(reversed.text, 'abc @muse ');
  assert.equal(reversed.caret, reversed.text.length);
});

test('a menu that fits stays exactly at the pointer', () => {
  const placement = clampMenuPosition({
    x: 100,
    y: 120,
    width: 168,
    height: 40,
    viewportWidth: 1200,
    viewportHeight: 800,
  });
  assert.deepEqual(placement, { left: 100, top: 120, flippedX: false, flippedY: false });
});

test('near the right edge the menu opens to the left of the pointer', () => {
  const placement = clampMenuPosition({
    x: 1100,
    y: 200,
    width: 168,
    height: 40,
    viewportWidth: 1200,
    viewportHeight: 800,
  });
  assert.equal(placement.flippedX, true);
  assert.equal(placement.left, 1100 - 168);
  assert.equal(placement.flippedY, false);
  assert.equal(placement.top, 200);
});

test('near the bottom edge the menu opens above the pointer', () => {
  const placement = clampMenuPosition({
    x: 200,
    y: 780,
    width: 168,
    height: 40,
    viewportWidth: 1200,
    viewportHeight: 800,
  });
  assert.equal(placement.flippedY, true);
  assert.equal(placement.top, 780 - 40);
  assert.equal(placement.flippedX, false);
});

test('a menu larger than the window is clamped to the safe margin', () => {
  const placement = clampMenuPosition({
    x: 500,
    y: 500,
    width: 1400,
    height: 900,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(placement.left, MENU_VIEWPORT_MARGIN);
  assert.equal(placement.top, MENU_VIEWPORT_MARGIN);
});

test('the default and custom margins are both honoured', () => {
  const custom = clampMenuPosition({
    x: 990,
    y: 10,
    width: 20,
    height: 10,
    viewportWidth: 1000,
    viewportHeight: 800,
    margin: 0,
  });
  assert.equal(custom.flippedX, true);
  assert.equal(custom.left, 970);

  const clamped = clampMenuPosition({
    x: 2,
    y: 2,
    width: 20,
    height: 10,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(clamped.left, MENU_VIEWPORT_MARGIN);
  assert.equal(clamped.top, MENU_VIEWPORT_MARGIN);
  assert.equal(clamped.flippedX, false);
  assert.equal(clamped.flippedY, false);
});