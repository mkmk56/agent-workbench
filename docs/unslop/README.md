# Agent Workbench GUI unslop pass

Branch: `gui/unslop` (from `gui/v0.1`, not merged).
Process: [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky, CC BY 4.0.

Screens captured from the running Electron app at 1440 × 900 (Windows 150% scale):
tasks, dispatch, settings, about, task detail (completed / failed / running),
HUD hover card, and a dark-theme tasks view.

- `before/` — baseline on `gui/v0.1`
- `after/` — final state on `gui/unslop`

`docs/UI_UX_SPECIFICATION.md` does not exist in this repo. The direction follows
`docs/DESIGN_SYSTEM.md`, `docs/BRAND_GUIDELINES.md` and `docs/AGENT_HUD_SPEC.md`.

## Scope

Light slop. The app already has a real brand and no purple gradients, glows,
glass or emoji. The work was a craft pass: spacing rhythm, quieting repeated
status chrome, one type scale, one icon size, copy that speaks to the operator,
and a readable task table. Features, routes, content order and engine/IPC code
were not changed.

## Direction

- **Product.** A local task console where one operator dispatches, watches and
  collects work from several coding agents.
- **Character.** Exact, watchful, a little warm.
- **World.** A dispatch desk: ink on paper, one signal-orange node marking the
  task that is moving.
- **Moments.** The HUD capsule with its agent rings and paper-plane flight, and
  the conclusion card that closes a finished task.
- **Signature.** The 6px convergence node from the Converge icon, reused as the
  live status dot and the mark on the selected executor.

## Audit (signs found)

- Colored 3px left rails on every conclusion card, so status color spread across
  the whole stream instead of marking one thing — `gui/src/styles/conversation.css`.
- Selection color used as a large orange fill on the active nav row and the
  selected executor card — `brand.css`.
- Double border on the selected executor card (`border` + `box-shadow`) —
  `brand.css`.
- 10px text in the conclusion source, card meta, context note, log stream label,
  keycaps and about license — `conversation.css`, `brand.css`.
- Too many type sizes (10–24px) and 600 on almost every control, so weight did
  the work of hierarchy — `brand.css`, `astryx-overrides.css`.
- Icon sizes 9/12/14/15/16 with mixed 1.75/2 strokes — every page, `ui/astryx.tsx`.
- Off-grid spacing: 34px nav rows, 30px logo, 22px topbar rule, 14px button
  padding, 18px inline margin, 10px HUD popover gaps — shared CSS and About.
- Table first column clipped the long task ID and did not ellipsize the title —
  `TasksPage.tsx`, `task-meta` in `brand.css`.
- Mixed time formats in one cell (relative + absolute) — `TasksPage.tsx`.
- Duplicate identity: task title already `任务 #id`, then `#id` again below it —
  `TasksPage.tsx`.
- Duplicate status: detail subtitle repeated the engine state already shown in
  the badge; failure card read `FAILED · 失败` — `TaskDetailPage.tsx`,
  `lib/labels.ts`.
- Developer-facing copy in operator surfaces (`task_start`, `agent_info`,
  “本次接入范围”, “task_send 会…”) — Dispatch, Settings, Task Detail.
- Task detail split gave the raw log panel only ~420px, so JSON broke every few
  words — `conversation.css`.
- About page capped at 760px inside a 1440px shell, leaving a dead right half —
  `brand.css`.
- HUD arrival flash scaled to 1.22 over 400ms with default easing — `hud.css`.
- Duplicate engine/executor status blocks (topbar, sidebar footer, rail, dispatch
  rail). Content was kept; the repeated blocks were made quiet instead of loud.

No purple-blue gradients, gradient text, glow, colored shadows, glass, blobs,
emoji, uppercase tracked labels, `transition-all`, `hover:scale` or parallax
were present.

## Pass notes

1. **Spacing** — 4px rhythm across shell, nav, table, cards, log rows and
   settings; 56px topbar, 240px nav, 48px table rows, 16px card padding, 24px
   page-head gap. Removed 34px/30px/22px/18px one-offs.
2. **Color** — kept Ink / Paper / Signal Orange. Removed colored card rails and
   orange selection fills; accent now marks the primary action, the selected
   executor node and live status only. Success status text is quiet with a green
   dot; warning/error keep their color.
3. **Icons** — lucide only, 16px and 1.5 stroke across the app; dropped file-chip
   icons that added nothing. HUD status glyphs keep their small badge role.
4. **Copy** — rewrote implementation notes into operator language; removed
   duplicate IDs, duplicate engine state and `FAILED · 失败`; one time format per
   cell; short task IDs in the table with the full ID in the tooltip.
5. **Type** — removed all 10px text, set controls to 500, kept 600 for page and
   card titles; tabular figures globally; removed negative tracking from the
   20px detail title.
6. **Layout** — task title column 42%, one meta line; task detail 0.9/1.1 split
   so logs get ~600px; About widened to 960px; settings save bar given room.
7. **Details** — selected state is one accent hairline plus a 6px node, not a
   double border; file chips and keycaps squared; nested radii stay 8 → 4.
8. **Visuals** — no generated image was needed. This is an app screen; its
   moments are the HUD, the paper-plane canvas and the conclusion card, not a
   hero illustration. No image prompt written.
9. **Motion** — one easing curve (`cubic-bezier(0.22, 1, 0.36, 1)`), live-only
   loops kept (working ring, indeterminate progress), HUD arrival flash reduced
   to 240ms / 1.12 scale.

## Verification

`npm run typecheck` and `npm run build` pass in `gui/`. No engine, IPC or feature
code was changed.