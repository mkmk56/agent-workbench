/**
 * Agent Workbench brand theme for Astryx.
 *
 * This module is the single source of truth for both the static CSS build
 * (scripts/build-theme.mjs) and the renderer's Theme provider. The generated
 * CSS is loaded as a normal stylesheet; `__built` keeps Astryx from injecting
 * a <style> element at runtime, which would conflict with the app CSP.
 */
import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral';

const UI_FONT =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO_FONT =
  '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "SFMono-Regular", monospace';

export function createBrandTheme() {
  const theme = defineTheme({
    name: 'agent-workbench',
    extends: neutralTheme,
    tokens: {
      /* Matte Black (VISUAL_SCHEME.md §4): cold silver-gray accent, no
       * identity colours (decision A), desaturated semantics. Pairs are
       * [light (paper-white variant), dark]. */
      '--color-accent': ['#5F656E', '#C5CBD3'],
      '--color-accent-muted': ['#EDEAE2', '#1D2024'],
      '--color-on-accent': ['#F5F3EE', '#101214'],
      '--color-neutral': ['rgba(30, 33, 38, 0.06)', 'rgba(245, 243, 238, 0.08)'],

      '--color-background-body': ['#F5F3EE', '#090A0B'],
      '--color-background-surface': ['#FFFFFF', '#141619'],
      '--color-background-card': ['#FFFFFF', '#141619'],
      '--color-background-popover': ['#FFFFFF', '#151719'],
      '--color-background-muted': ['#EDEAE2', '#191C20'],
      '--color-background-inverted': ['#1E2126', '#F2F3F4'],
      '--color-overlay': ['rgba(30, 33, 38, 0.48)', 'rgba(0, 0, 0, 0.62)'],
      '--color-overlay-hover': ['rgba(30, 33, 38, 0.04)', 'rgba(245, 243, 238, 0.05)'],
      '--color-overlay-pressed': ['rgba(30, 33, 38, 0.08)', 'rgba(245, 243, 238, 0.09)'],

      '--color-text-primary': ['#1E2126', '#F2F3F4'],
      '--color-text-secondary': ['#5F656E', '#9298A1'],
      '--color-text-disabled': ['#8A8F98', '#4B5159'],
      '--color-text-accent': ['#5F656E', '#E0E4E9'],
      '--color-icon-primary': ['#1E2126', '#F2F3F4'],
      '--color-icon-secondary': ['#5F656E', '#9298A1'],
      '--color-icon-disabled': ['#8A8F98', '#4B5159'],
      '--color-icon-accent': ['#5F656E', '#C5CBD3'],
      '--color-border': ['#D8D5CC', '#292D32'],
      '--color-border-emphasized': ['#BFBBB0', '#383D44'],
      '--color-track': ['#D8D5CC', '#292D32'],
      '--color-skeleton': ['#D8D5CC', '#292D32'],
      '--color-shadow': ['rgba(30, 33, 38, 0.10)', 'rgba(0, 0, 0, 0.30)'],

      '--color-info': ['#6B8CA8', '#6B8CA8'],
      '--color-info-muted': ['#E8EFF3', '#1C2833'],
      '--color-on-info': ['#F5F3EE', '#101214'],
      '--color-success': ['#4A7D64', '#5A9A7A'],
      '--color-success-muted': ['#E3F1EA', '#1F3A2F'],
      '--color-on-success': ['#F5F3EE', '#101214'],
      '--color-warning': ['#B98A3E', '#C99A4B'],
      '--color-warning-muted': ['#FCF0DC', '#3A2E1B'],
      '--color-on-warning': ['#1E2126', '#101214'],
      '--color-error': ['#A85A52', '#A85A52'],
      '--color-error-muted': ['#F9E5E2', '#3A2321'],
      '--color-on-error': ['#F5F3EE', '#101214'],

      '--color-background-green': ['#E3F1EA', '#1F3A2F'],
      '--color-border-green': ['#4A7D64', '#5A9A7A'],
      '--color-icon-green': ['#4A7D64', '#5A9A7A'],
      '--color-text-green': ['#2F5D46', '#5A9A7A'],
      '--color-background-yellow': ['#FCF0DC', '#3A2E1B'],
      '--color-border-yellow': ['#B98A3E', '#C99A4B'],
      '--color-icon-yellow': ['#B98A3E', '#C99A4B'],
      '--color-text-yellow': ['#8A5E14', '#C99A4B'],
      '--color-background-red': ['#F9E5E2', '#3A2321'],
      '--color-border-red': ['#A85A52', '#A85A52'],
      '--color-icon-red': ['#A85A52', '#A85A52'],
      /* Dark red text is lightened vs #A85A52 (3.80:1) for WCAG AA (5.60:1). */
      '--color-text-red': ['#8F443C', '#C07A72'],
      /* Chat-bubble identity colours (user decision 2026-11-18, grill Q2/Q4):
       * the ONLY override of decision A. Pairs are [light, dark]; light
       * keeps decision A (transparent blend, body-colour names), dark uses
       * the approved preview values. Body text on all four dark fills is
       * #F2F3F4 (see chat.css §10). Avatars stay ink tiles (white glyph
       * PNGs cannot be recoloured per agent). */
      '--color-bubble-muse-fill': ['transparent', '#1B1D20'],
      '--color-bubble-muse-border': ['transparent', '#2E3237'],
      '--color-bubble-muse-name': ['#1E2126', '#C5CBD3'],
      '--color-bubble-claude-fill': ['transparent', '#241D19'],
      '--color-bubble-claude-border': ['transparent', '#5C4436'],
      '--color-bubble-claude-name': ['#1E2126', '#C08A6B'],
      '--color-bubble-dsh-fill': ['transparent', '#1A1F26'],
      '--color-bubble-dsh-border': ['transparent', '#3D4E5E'],
      '--color-bubble-dsh-name': ['#1E2126', '#7E96AC'],
      '--color-bubble-user-fill': ['#FFFFFF', '#202226'],
      '--color-bubble-user-border': ['#D8D5CC', '#34383E'],
      '--color-bubble-user-name': ['#1E2126', '#9AA0A8'],
      /* No orange family: Signal Orange is removed (VISUAL_SCHEME.md).
       * No purple/blue identity families: decision A, identity is glyph +
       * name + tag, never colour — except chat bubbles (user decision
       * 2026-11-18, grill Q2/Q4): see --color-bubble-* tokens above.
       * Nothing in gui/src referenced them. */

      '--radius-none': '0px',
      '--radius-inner': '6px',
      '--radius-element': '8px',
      '--radius-container': '12px',
      '--radius-page': '12px',
      '--radius-chat': '12px',
      '--radius-full': '9999px',

      '--font-family-body': UI_FONT,
      '--font-family-heading': UI_FONT,
      '--font-family-code': MONO_FONT,
      '--font-size-lg': '1rem',
      '--font-size-xl': '1.25rem',
      '--font-size-2xl': '1.5rem',
      '--font-size-3xl': '2rem',
    },
  });

  // Static theme: CSS is generated at build time and loaded as a stylesheet.
  theme.__built = true;
  return theme;
}

export const brandTheme = createBrandTheme();
