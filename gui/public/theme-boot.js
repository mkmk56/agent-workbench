/* Pre-paint theme bootstrap: same logic as src/lib/theme.ts initialTheme().
 * Sets documentElement data-theme before first paint so a dark-theme user
 * never flashes the light theme (and vice versa). The main-process window
 * background is dark (#090A0B), so this must match it for dark.
 *
 * Loaded as an EXTERNAL script on purpose: the production CSP is
 * script-src 'self' with no 'unsafe-inline' (electron/main.ts
 * applySessionPolicy), so an inline <script> would be refused in the
 * packaged app and the flash would survive. A relative src keeps it
 * working under file:// (absolute /theme-boot.js would not resolve).
 * Vite copies gui/public/* to dist/ verbatim at build time.
 *
 * (F5 fix vs the first inline version: the matchMedia fallback sits
 * OUTSIDE the try, so a localStorage throw still falls back to the
 * system preference instead of leaving the first frame on light.) */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('agent-workbench.theme');
  } catch (e) {
    theme = null;
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
