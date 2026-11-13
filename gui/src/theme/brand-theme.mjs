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
      '--color-accent': ['#E85D26', '#E85D26'],
      '--color-accent-muted': ['#FBE8DF', '#3A2620'],
      '--color-on-accent': ['#1E2126', '#1E2126'],
      '--color-neutral': ['rgba(30, 33, 38, 0.06)', 'rgba(245, 243, 238, 0.08)'],

      '--color-background-body': ['#F5F3EE', '#1E2126'],
      '--color-background-surface': ['#FFFFFF', '#25292F'],
      '--color-background-card': ['#FFFFFF', '#25292F'],
      '--color-background-popover': ['#FFFFFF', '#25292F'],
      '--color-background-muted': ['#EDEAE2', '#2C3138'],
      '--color-background-inverted': ['#1E2126', '#F5F3EE'],
      '--color-overlay': ['rgba(30, 33, 38, 0.48)', 'rgba(0, 0, 0, 0.62)'],
      '--color-overlay-hover': ['rgba(30, 33, 38, 0.04)', 'rgba(245, 243, 238, 0.05)'],
      '--color-overlay-pressed': ['rgba(30, 33, 38, 0.08)', 'rgba(245, 243, 238, 0.09)'],

      '--color-text-primary': ['#1E2126', '#F5F3EE'],
      '--color-text-secondary': ['#5F656E', '#A8ADB5'],
      '--color-text-disabled': ['#8A8F98', '#8A8F98'],
      '--color-text-accent': ['#C0471A', '#FF8A5C'],
      '--color-icon-primary': ['#1E2126', '#F5F3EE'],
      '--color-icon-secondary': ['#5F656E', '#A8ADB5'],
      '--color-icon-disabled': ['#8A8F98', '#8A8F98'],
      '--color-icon-accent': ['#E85D26', '#E85D26'],
      '--color-border': ['#D8D5CC', '#3A4048'],
      '--color-border-emphasized': ['#BFBBB0', '#4A515A'],
      '--color-track': ['#D8D5CC', '#3A4048'],
      '--color-skeleton': ['#D8D5CC', '#3A4048'],
      '--color-shadow': ['rgba(30, 33, 38, 0.10)', 'rgba(0, 0, 0, 0.30)'],

      '--color-info': ['#E85D26', '#E85D26'],
      '--color-info-muted': ['#FBE8DF', '#3A2620'],
      '--color-on-info': ['#1E2126', '#1E2126'],
      '--color-success': ['#2E7D5B', '#63C79B'],
      '--color-success-muted': ['#E3F1EA', '#1F3A2F'],
      '--color-on-success': ['#F5F3EE', '#1E2126'],
      '--color-warning': ['#D97706', '#F0A63C'],
      '--color-warning-muted': ['#FCF0DC', '#3A2E1B'],
      '--color-on-warning': ['#1E2126', '#1E2126'],
      '--color-error': ['#C0392B', '#F08A7E'],
      '--color-error-muted': ['#F9E5E2', '#3A2321'],
      '--color-on-error': ['#F5F3EE', '#1E2126'],

      '--color-background-green': ['#E3F1EA', '#1F3A2F'],
      '--color-border-green': ['#2E7D5B', '#63C79B'],
      '--color-icon-green': ['#2E7D5B', '#63C79B'],
      '--color-text-green': ['#25684C', '#63C79B'],
      '--color-background-yellow': ['#FCF0DC', '#3A2E1B'],
      '--color-border-yellow': ['#D97706', '#F0A63C'],
      '--color-icon-yellow': ['#D97706', '#F0A63C'],
      '--color-text-yellow': ['#9A5B00', '#F0A63C'],
      '--color-background-red': ['#F9E5E2', '#3A2321'],
      '--color-border-red': ['#C0392B', '#F08A7E'],
      '--color-icon-red': ['#C0392B', '#F08A7E'],
      '--color-text-red': ['#A93226', '#F08A7E'],
      '--color-background-orange': ['#FBE8DF', '#3A2620'],
      '--color-border-orange': ['#E85D26', '#E85D26'],
      '--color-icon-orange': ['#E85D26', '#E85D26'],
      '--color-text-orange': ['#C0471A', '#FF8A5C'],
      '--color-background-blue': ['#FBE8DF', '#3A2620'],
      '--color-border-blue': ['#E85D26', '#E85D26'],
      '--color-icon-blue': ['#E85D26', '#E85D26'],
      '--color-text-blue': ['#C0471A', '#FF8A5C'],

      '--radius-none': '0px',
      '--radius-inner': '4px',
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