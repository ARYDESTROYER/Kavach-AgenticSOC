# R12 UX synthesis: Apple-design translation, Overview, Case Manager, Remember me, report downloads

Synthesis lead output. Inputs:
- `research/dashboard-ux.md`, `research/case-ux.md`, `research/remember-me.md`;
- `diag/overview.md` (measured Overview crampedness), `diag/disposition.md` (analyst FP close root cause);
- the Apple design skill (`apple-design-SKILL.md`);
- `docs/development/ui-standard.md`, `webui/src/styles/theme.css`, `webui/tailwind.config.js`, `webui/src/soc/components/motion/*`;
- live probes of report export run for this synthesis (§5).

**`research/report-export.md` did not exist when this was written** (17:38Z; I polled for it for about 10 minutes). §5 is therefore built from my own code reading, the report diagnostic artifacts already in `diag/rep-dl/` and `research/probe/`, and two probes I re-ran against the live demo. If that brief lands later, merge it into §5. Do not replace §5 with it.

The web-search budget for this turn was exhausted before this pass. I verified citations by fetching known official URLs directly. Claims I could not verify that way are marked **[unverified]** and must be checked in a browser by the implementer.

Scope rule for everything below: presentation and the analyst layer only.
- `decide()`, `risk.py` and `signatures.py` are untouched (#3).
- Every log- or model-derived string stays a plain text node (#9).
- No new npm dependencies. `motion@12.42.2` stays lazy behind `LazyMotion`/`domAnimation`.

---

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| D1 | Apple restraint is expressed through **space, type and one material recipe**, not new chrome. Content stays flat and divider-led (ui-standard). Translucent material is reserved for **floating chrome only**: top bar, sticky dashbar/control bars, the sticky case header, sheets and popovers. | §1 |
| D2 | **Tracking follows Inter's published dynamic-metrics curve per size**, replacing today's fixed values. Today 11px is over-tracked 4× (+0.02em vs +0.005em) and 20–30px is under-tightened. | §1.5 |
| D3 | **One spring vocabulary.** Default is critically damped (`bounce: 0`, `visualDuration` 0.3s); sheets use 0.35s. Bounce is allowed only after a pointer release that carried momentum. `HOUSE_SPRING` (ζ≈0.84) is retired from click-driven motion. | §1.6 |
| D4 | Overlays **scale from their trigger** (Radix `--radix-*-transform-origin`), not from their centre. Menu and popover radius rises 3px → 10px, concentric with 6px items. | §1.3, §1.6 |
| D5 | Overview: **flat, titled bands separated by whitespace** (32px between bands, 24px column gutters). No per-instrument cards and no lattice hairlines. Width is `wide`, plus a two-column macro layout at ≥2200px. **Every datum survives** (inventory §2.10). | §2 |
| D6 | Case Manager: **the analyst's classification is the headline once a human classifies**. The AI verdict stays visible as a labelled secondary line. Every terminal path (single resolve, bulk resolve, bulk close) captures a disposition. | §3 |
| D7 | Remember me: a **persistent, server-bounded session** (admin presets 6/12/24h, default 24h, max 24h) plus a **remembered username**. The password is remembered **only by the browser's password manager**, never by the app. MFA and step-up are never bypassed. `/auth/me` must become registry-aware first. | §4 |
| D8 | Report downloads: 17 concrete fixes. Top five: an in-flight guard with visible progress, a print path that stops hiding content-bearing buttons, sane page breaks, a correct PDF filename, and deferred object-URL revocation. | §5 |

---

## 1. Apple-design translation for this app

### 1.1 Principles mapped to this console

| Apple principle (skill §) | What it means here |
|---|---|
| Response (§1) | Feedback on pointer-down (`.press-scale` already does `scale(0.97)` on `:active`, 120ms). Rows darken on `:active` instead of scaling (scaling a full-width row looks wrong). No artificial delays on menus, tabs or exports. Export/print must show progress within 100ms (§5). |
| Interruptibility (§3) | Every JS-driven transition is a spring from the current value (Motion does this by default). Never lock input during a transition. Switching cases mid-animation retargets; it does not queue. |
| Spatial consistency (§7) | The case detail pane, sheets and the report panel enter **and** exit from the right. Menus, popovers, hover cards, selects and the KPI drill-down dialog scale from their trigger. |
| Materials (§12) | One translucent material for floating chrome only. Content (tables, charts, transcripts, case evidence) is always on an opaque `canvas`/`card`. Never stack translucent on translucent. Use a scroll-edge fade instead of a hard rule under sticky chrome. |
| Typography (§15) | Size-specific tracking (Inter curve, §1.5). Inverse leading. Hierarchy from weight + size + leading together. Do not use tracked uppercase for titles (ui-standard already bans it). |
| Simplicity, not minimalism (§16) | Keep all data. Fix *hierarchy* (order, spacing, contrast) and *grouping* (proximity), and show the common path first with depth one level down. |
| Feedback: four kinds (§16) | Status (job/export progress, agent activity), completion ("Closed as false positive · Undo"), warning (token cost, shared device), error (inline, with Retry). |
| Reduced motion/transparency/contrast (§14) | All three handled, including a Safari gap for reduced transparency (§1.7). |

**Font decision.** Keep self-hosted **Inter Variable**; do not switch to `system-ui`. Apple's rule is "override only with a reason". Here the reasons are:
- the air-gapped deployment needs identical metrics on every OS;
- tabular figures;
- the `ss01`/`cv01`/`zero` disambiguation sets that protect IOC legibility (#9).

### 1.2 Spacing scale (8pt grid with 4px half-steps)

Tokens are Tailwind's default spacing. **The rule is which step is used where**; no new tokens are needed.

| Step | px | Tailwind | Use |
|---|---|---|---|
| 0.5 | 2 | `0.5` | icon-to-glyph optical nudges only |
| 1 | 4 | `1` | inside chips; label↔value in a stat; menu inset (`p-1`) |
| 2 | 8 | `2` | between related controls in a bar; list row vertical padding (compact) |
| 3 | 12 | `3` | list row vertical padding (comfortable); stat label → numeral |
| 4 | 16 | `4` | instrument inner padding at `xl`; split-pane inset (ui-standard 16–24px rail) |
| 5 | 20 | `5` | instrument inner padding at `2xl` |
| 6 | 24 | `6` | **column gutter between instruments** (`gap-x-6`); detail-pane content rail at `2xl` |
| 8 | 32 | `8` | **gap between bands** (`gap-y-8`); column gutter at `3xl` |
| 10 | 40 | `10` | gap between bands at `3xl`/`4xl` |
| 12 | 48 | `12` | page top padding on sparse identity screens only (Login, empty states) |

Rules:
1. **Dense inside, generous between.** Every vendor in `dashboard-ux.md §3.3` does this; we currently do the inverse.
2. Rhythm is set by the *container*, not by children. Use `gap-*`/`space-y-*` on the parent and never sibling margins.
3. Use `rem`-based spacing (Tailwind default) so browser zoom and text-size settings scale layout with text (Apple §15, Dynamic Type analogue).
4. Do not stack page, pane and panel padding (ui-standard "Queue and detail workspaces"): one 16–24px rail per pane.

### 1.3 Radii: a concentric system

The current scale is `--radius-sm .375rem` (6), `-md .5rem` (8), `-lg .625rem` (10) and `-xl .875rem` (14). Buttons and inputs already use `rounded-md` (8). The outlier is `overlaySurface`/`menuItem` (`lib/ui-recipes.ts:35,46`) at `rounded-[3px]`.

| Surface | Radius | Tailwind |
|---|---|---|
| Badges, chips, menu items, small toggles | 6 | `rounded-sm` (= `calc(var(--radius) - 4px)`) |
| Buttons, inputs, selects, segmented control | 8 | `rounded-md` (unchanged) |
| Menus, popovers, hover cards, tooltips, toasts | **10** (was 3) | `rounded-lg` |
| Dialogs, sheets (leading edge only), KPI drill-down, command palette | 14 | `rounded-r-xl` / `rounded-xl` |
| Bands, list rows, tables, the KPI strip, split panes | 0 (flat, divider-led) | n/a |

**Concentric rule.** inner radius = outer radius − inset.
- A 10px menu with a `p-1` (4px) inset gets 6px items.
- A 14px dialog with `p-6` holds 8px controls. 14 − 6 would be too small, so controls keep their own 8px.
- Focus rings follow the element's own radius.

This is a deliberate **ui-standard change**: "Controls are compact and squared/quiet" becomes "compact, quiet, concentric radii". Update the standard in the same candidate.

### 1.4 Materials (floating chrome only)

There is one recipe at two thicknesses, built on the existing tokens. It extends `lib/ui-recipes.ts`, next to `overlaySurface`.

```ts
// lib/ui-recipes.ts
/** Floating functional chrome (sticky bars, the case header, the top bar). Never behind data. */
export const materialBar =
  'material-surface bg-background/85 supports-[backdrop-filter]:bg-background/[0.80] ' +
  'supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-150';
/** Thick material for large floating panes (sheet header, command palette). */
export const materialThick =
  'material-surface bg-popover/95 supports-[backdrop-filter]:bg-popover/[0.88] ' +
  'supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-150';
```

```css
/* theme.css: @layer utilities */
.material-surface { position: relative; }
/* Scroll-edge effect (Apple §12): a soft fade below sticky chrome, shown ONLY while
   content is scrolled underneath. A sentinel IntersectionObserver toggles data-scrolled. */
.material-surface[data-scrolled='true']::after {
  content: ''; position: absolute; inset-inline: 0; top: 100%; height: 12px; pointer-events: none;
  background: linear-gradient(to bottom, hsl(var(--background) / 0.85), transparent);
}
```

Rules:
1. **Fill opacity is ≥ 0.80** on any material carrying text of 12px or less. I computed the worst realistic case: 30% foreground-coloured content blurred under the bar.
   - Dark: `--muted-foreground` still clears about 6:1.
   - Light: about 5.3:1.
   - At 0.72 opacity with 100% bright content beneath, muted text drops to about 3.2:1 in dark. That is why we do not go thinner.
2. **Vibrancy (Apple §12):**
   - On a material, small text uses `text-secondary-foreground` or `text-foreground` at `font-medium`, not `text-muted-foreground`.
   - Colour lives on solid chips, not on the translucent layer.
   - Apple HIG: "use vibrant colors on top of [materials]"; quaternary labels are too low-contrast on thin materials.
3. **Thicker for bigger:**
   - Bars use `blur-xl` (24px) at 0.80.
   - Sheets and the palette use `blur-2xl` (40px) at 0.88.
   - Small chips get no blur (solid).
4. **Never stack.** A popover opened from a material bar is solid `bg-popover` (it already is). Do not make `overlaySurface` translucent.
5. **Hard dividers under sticky chrome become the scroll-edge fade.** Existing `border-b` on sticky `PageHeader`/`ControlBar`/`FilterBar` (`bg-background/95 backdrop-blur`) migrates to `materialBar` + `data-scrolled`. Under `prefers-contrast: more` the hard `border-b border-border-strong` comes back (§1.7).
6. `GlassSurface` (top bar) keeps its contract. Its `quiet` material `--glass-opacity` (0.82 light / 0.96 dark) already satisfies rule 1.
7. **Materialize, don't just fade (§12).** Sheets animate opacity and translate together. Do **not** animate `backdrop-filter` radius: it is expensive and janky on large panes.

### 1.5 Typography

**Tracking.** Inter's dynamic-metrics curve is `tracking(em) = −0.0223 + 0.185 × e^(−0.1745 × px)` ([Inter dynmetrics](https://d.rsms.me/inter-website/v3/dynmetrics/)). Apple's own SF Pro table makes the same point: tracking is size-specific ([HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography); SF Pro macOS: 11pt +6/1000em, 13pt −6, 17pt −26). Values computed for our scale:

| Tailwind size | px / line-height | Today `letterSpacing` | **Proposed** | Weight guidance |
|---|---|---|---|---|
| `2xs` | 11/14 | 0.02em | **0.005em** | 500. Badges, axis ticks and timestamps **only** |
| `xs` | 12/16 | 0.01em | **0** | 400/500 |
| `sm` | 13/18 | — | **−0.003em** | 400 |
| `base` | 14/20 | — | **−0.006em** | 400 body · 500 labels |
| `md` | 15/22 | — | **−0.009em** | 400 |
| `lg` | 16/24 | — | **−0.011em** | 600 card titles |
| `xl` | 18/24 | — | **−0.014em** | 600 |
| `2xl` | 20/26 | −0.01em | **−0.017em** | 600 |
| `3xl` | 24/30 | −0.015em | **−0.020em** | 650 |
| `4xl` | 30/36 | −0.02em | **−0.021em** | 650 |
| `display` | 32/40 | −0.02em | **−0.022em** | 650 |
| KPI hero numeral | `clamp(1.875rem, 0.9rem + 1.4vw, 2.75rem)` (≈32px@1280 → 36@1536 → 41@1920 → 44 cap) | — | **−0.021em**, `leading-none`, `tabular-nums` | 600 |

Notes:
- This is a one-file change (`tailwind.config.js` `fontSize`). Class names do not change, so tests asserting classes are unaffected. Re-run the design/contrast gate and spot-check KPI strip fit at 1280 with the nav pinned: the widest plausible "12,345" at 32px is about 120px against about 131px of usable tile.
- **Leading** is already inverse (14/20 body, 30/36 display). Keep it, and use `leading-none` only on single-line numerals.
- **Minimum size.** Apple's macOS minimum is 10pt and its default is 13pt. Our floor is 11px, and only for badges, timestamps and chart ticks, which is what the `2xs` config comment already intends. Content text (legends, captions, stat subtitles, list metadata) is ≥12px. The Overview currently has 51–66 text nodes at 11px (`diag/overview.md §2`).
- Avoid light weights below 400 (HIG: "avoid Ultralight, Thin, and Light"). Use emphasis by weight, not colour.
- **Optional (P2): optical sizing.** `@fontsource-variable/inter/opsz.css` is already in `node_modules`. It has the same family name, `'Inter Variable'`, so it is a drop-in. It costs +24.6KB of woff2 (72.9KB vs 48.3KB, latin) and is not JS, so the entry budget is unaffected. With `font-optical-sizing: auto`, numerals of 32px and above get Inter Display cuts. If adopted, halve the negative tracking at ≥24px (Display already tightens spacing) **[verify visually]**.

### 1.6 Motion

The existing tokens stay: CSS `--motion-fast 120ms / base 200ms / slow 280ms`, `--motion-ease-standard`, `--motion-ease-premium`, and the global `prefers-reduced-motion` zeroing. Add Apple-style springs to `components/motion/variants.ts`. Motion's `bounce`/`visualDuration` map directly onto Apple's damping/response: `bounce: 0` is critically damped, and `visualDuration` is the time to visually reach the target ([motion.dev/docs/spring](https://motion.dev/docs/spring)).

```ts
// variants.ts: Apple-aligned springs (damping ≈ 1.0 ⇒ bounce 0; response ⇒ visualDuration)
export const SPRING_UI: Transition = { type: 'spring', bounce: 0, visualDuration: 0.3 };    // tabs, disclosure, row reflow, bulk bar
export const SPRING_PANE: Transition = { type: 'spring', bounce: 0, visualDuration: 0.35 }; // sheets, side panes, report panel
export const SPRING_MOMENTUM: Transition = { type: 'spring', bounce: 0.2, visualDuration: 0.35 }; // ONLY after a pointer release with velocity
/** @deprecated ζ≈0.84 (stiffness 320, damping 30): slight overshoot on click-driven UI. Use SPRING_UI. */
export const HOUSE_SPRING = SPRING_UI;
```

- `HOUSE_SPRING` today is `stiffness 320, damping 30, mass 1`, so ζ = 30 / (2√320) ≈ 0.84 and it overshoots slightly. It drives the Cases bulk bar (`Cases.tsx:1935`) and `verdictLandVariants`. Both are click-driven, so they get `bounce: 0`.
- `AnimatedNumber` (`mass .8, stiffness 75, damping 15`, ζ≈0.97) is already near-critical. Keep it, but **only on first load or a window change, never on a LIVE refresh** (dashboard-ux §6.7).

**Transform origin (§7).** Add the Radix origin variables to each overlay primitive, so `zoom-in-95`/`zoom-out-95` scales from the trigger:
- `ui/dropdown-menu.tsx`: `origin-[var(--radix-dropdown-menu-content-transform-origin)]`
- `ui/popover.tsx`: `origin-[var(--radix-popover-content-transform-origin)]`
- hover card, tooltip, select and context menu: their `--radix-<part>-content-transform-origin` equivalents.

The KPI drill-down dialog is not anchored by Radix. Set `style={{ transformOrigin: <tile centre relative to the dialog> }}` from the clicked tile's `getBoundingClientRect()` and fall back to centre.

**No shared-element `layoutId`.** `domAnimation` excludes layout animations (`provider.tsx` comment), and `domMax` costs bundle size. Achieve anchoring with transform-origin instead.

**Enter = exit path.**
- Sheets: `slide-in-from-right` / `slide-out-to-right` (already symmetric).
- Dialogs: `zoom-in-95` / `zoom-out-95` from the same origin.
- Row removal after a close (Case Manager Active mode): height + opacity with `SPRING_UI`, then select the next row. Under reduced motion, swap instantly and show a toast.

**Agent-activity glyph** (the user's "animating logo when the agent is working", detailed in `diag/working.md`):
- Use a 16–20px mark with transform and opacity only.
- The rhythm is a continuous rotation or arc sweep at about a **1.2–1.35s period** (match `console-progress-ring`). **Never a slow 0.2Hz "breathing" loop.** Apple §14 calls out slow oscillations near one cycle per 5s.
- On completion, cross-fade to a check or unseen dot for 200ms. This is the "completion" feedback kind.
- Under `prefers-reduced-motion`, show a static partial ring plus the visible text "Working". Mirror the state in `aria-busy` on the nav item and in an announcer message on start and finish. Do not use a live region per frame.
- ui-standard currently allows a continuous pulse only on "the newest terminal timeline marker". **Amend it** to also allow "the single agent-activity glyph while a turn is running".

**What never animates:**
- data on auto-refresh (no layout shift; numerals do not re-roll in LIVE);
- static content;
- `backdrop-filter` radius;
- anything under 2s that conveys required information. Every animated state has a text equivalent.

### 1.7 Accessibility media queries

Support matrix, from [MDN browser-compat-data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/at-rules/media.json):

| Query | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| `prefers-reduced-motion` | 74 | 63 | 10.1 |
| `prefers-contrast` | 96 | 101 | 14.1 |
| `prefers-reduced-transparency` | 118 | 113, **behind a flag** | **not supported** |

So macOS Safari users who turn on "Reduce transparency" never match the query. Add an **in-app override**:
- **Settings → Appearance → "Reduce transparency"**: System (default) / On.
- It sets `data-transparency="reduced"` on `<html>`.
- Reuse the material-pack plumbing in `theme.tsx` (`applyMaterialClass`).

```css
/* theme.css: add next to the existing reduced-transparency block */
:root[data-transparency='reduced'], :root[data-transparency='reduced'] .dark { --glass-opacity: 1 !important; }
:root[data-transparency='reduced'] .glass-surface,
:root[data-transparency='reduced'] .material-surface { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
@media (prefers-reduced-transparency: reduce) {
  .material-surface { backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
                      background-color: hsl(var(--background)) !important; }
}
:root[data-transparency='reduced'] .material-surface { background-color: hsl(var(--background)) !important; }

/* NEW: higher contrast. theme.css has no prefers-contrast handling today. */
@media (prefers-contrast: more) {
  :root, .dark { --border: var(--border-strong); }          /* hairlines become ≥3:1 structural lines */
  .material-surface { backdrop-filter: none !important; background-color: hsl(var(--background)) !important;
                      border-bottom: 1px solid hsl(var(--border-strong)); }
  .material-surface::after { display: none; }               /* no scroll-edge fade: a real rule instead */
  .text-muted-foreground { color: hsl(var(--secondary-foreground)); }
}
/* prefers-reduced-motion: the existing global zeroing stays; MotionConfig reducedMotion="user" keeps opacity
   cross-fades only. Additionally gate .press-scale/.hover-lift transforms (already gated). */
```

Re-run the WCAG gate in both themes, once with `prefers-contrast: more` emulated and once with reduced transparency emulated (Playwright `page.emulateMedia({ reducedMotion, contrast, forcedColors })`).

### 1.8 Elevation

The existing rule holds: borders for tiled or scrolled content, shadows for detached portals only (`--elev-*`, `--shadow-menu`, `--shadow-overlay`).
- Dialogs and the palette use `shadow-overlay`. Menus use `shadow-menu`.
- No resting shadows on dashboard instruments.
- `hover-lift` is allowed only on genuinely clickable standalone tiles, and it is already reduced-motion gated.
- Modal tasks dim the background with the existing scrim. A non-blocking side pane (the case detail split, the report panel overlay) gets **no scrim** (Apple §12: "separate to keep flow").

---

## 2. Overview ("Cyber Defence Center") redesign: keep every datum

### 2.1 What is wrong (measured, `diag/overview.md`)

- **Clamped on two axes at once.** Every instrument has a fixed pixel height (flow 216px, donuts 112/150px, HvA 122–160px, volume 180px), and every instrument stretches with no width cap (`PageContainer variant="fluid"` = `max-w-none`).
  - At 1280/1440 the page feels **compressed**: 12px cell padding, zero gutters, and 10 horizontal rules crossing one column in 844px.
  - At 1920/2560 it feels **sparse**: the KPI numeral fills 10% of its tile, the flow is a 7.5:1 strip, a legend label sits 470px from its count, and 30% of a 2560×1440 viewport is empty.
- **Type.** 51–66 nodes at 11px (legends, captions, subtitles, chips). About 12 competing large numerals above the fold.
- **Grammar split.** The top half is a flat hairline lattice. "Deeper analytics" is `Card` inside `DashboardGroup` inside `DashboardGroup`, with accent bars and tracked uppercase. This violates ui-standard's no-nested-cards rule.
- **Glitches:**
  - the "VERDICTS" donut centre overflows its hole ("ERDICTS" at 1280 light);
  - "Full screen" relabels to "Expand" in Detailed mode;
  - three "open" numbers (23 stock / 15 cohort / 15 flow) sit 400px apart with no visible link;
  - "last 1 day" vs "24h" wording;
  - Latest-cases IDs are hard-capped at `max-w-40` and truncate at every width;
  - Response-time cell has a ~110px void (`xl:justify-center`);
  - Deeper cards have −94px and −356px height mismatches;
  - the KPI modal shows only ~6 table rows at 1440 (4 at 1280) under ~1,000px of chrome.

### 2.2 Layout decisions

1. **Width.** Use `variant="wide"` (`max-w-[1760px] 2xl:max-w-[1920px]`, centred). `PageContainer.tsx:9-11` already prescribes this for Overview ("widen by COLUMN COUNT on ultrawide, not by stretching rows").
2. **Ultrawide.** Add `screens: { '3xl': '1920px', '4xl': '2200px' }` to `tailwind.config.js` (`theme.extend.screens`; defaults below are kept).
   - At `4xl` raise the cap to `4xl:max-w-[2400px]` and switch to a **two-column macro layout**: main column = bands 1–3; a right rail of about 460px = Human vs AI stacked over Latest cases (more rows).
   - This is Datadog's "high density mode". It removes the 7.5:1 flow strip and the empty 30%.
3. **Flat bands, not cards.**
   - Each band is a `<section aria-labelledby>` on the canvas.
   - Instruments inside a band are transparent, separated by **`gap-x-6` (24px)**, rising to `3xl:gap-x-8`.
   - Bands are separated by **`gap-y-8` (32px)**, rising to `3xl:gap-y-10`.
   - Each band has at most **one hairline: its top rule**. Remove all per-cell `border-r`/`border-b`.
   - This follows ui-standard ("transparent sections separated by border … over card-inside-card") and Apple §16 ("proximity implies relationship").
   - `dashboard-ux.md` proposed bordered cards. **Rejected**: it would re-introduce 30+ boxes and conflict with ui-standard. Gutters and type give the separation.
4. **Equal heights.** Use `items-stretch` on band grids and `h-full flex flex-col` on instruments. Charts and lists get `flex-1`, and lists cap at N rows with "View all".
5. **The flow floor holds.** With no cell padding and a 24px gutter at 1280 with the nav pinned: (982 − 24) × 8/12 ≈ **638px ≥ 608** (`NoiseFunnel` `@[38rem]/noise`).
   - Do **not** add `p-5` to the flow cell at `xl`; it would drop to about 598px and the graph would disappear.
   - Re-verify with the nav both pinned (240px) and collapsed (64px) at 1280, 1366 and 1440.

### 2.3 Bands, top to bottom

| Band | Title (sentence case, `text-[15px] font-semibold tracking-[-0.009em]`) + 13px muted caption | Contents (all existing) | Right side of band header |
|---|---|---|---|
| 0 | *(page header + sticky **dashbar**)* | Title "Cyber Defence Center" (boot-smoke anchor, unchanged), TimeRangePicker, auto-refresh select, RefreshButton; AutomationNudge / LoadError / EmptyState as today | "Updated 12s ago" (`tabular-nums`) |
| 1 | *(no title; the page title introduces it)* | KPI strip, 6 tiles | — |
| 2 | **Alert flow** · "How alerts became outcomes · {window}" | Noise reduction flow (8 col) · Human vs AI (4 col) | "Updated …" |
| 3 | **Cases and response** · "{window} · p50 · server-computed" | Case state (5) · Response time (3) · Latest cases (4) | "View all cases →" |
| 4 | **Deeper analytics** (one persisted disclosure; no nesting) | sub-band "Efficiency and cost" + sub-band "What's driving volume" | inline summary while collapsed (§2.6) |

**Dashbar.**
- The control row becomes a sticky `materialBar` (`sticky top-[var(--header-h)] z-20`) with the scroll-edge fade.
- `page-hero` itself must **not** become a card (test `overview.render.test.tsx:251`). Wrap only the meta controls, or render a `ControlBar`.
- Use one global refresh plus per-band freshness stamps. Slices load independently, so this is more honest (Sentinel shows "the last refresh time … at the top of each section").

**Band 1: KPI strip.**
- Keep the continuous 6-cell strip and its `nth-child` divider math. The cell count is unchanged, so the math stays valid.
- Wrap it in nothing (flat). Its bottom rule is no longer band 2's top edge, because there is a 32px gap now. **Amend ui-standard** ("no vertical gap and no second hairline between them").
- Density: a new middle step between `compact` and `default`, `px-4 py-3` at `xl` and `px-5 py-4` at `2xl`, about 120px tall. The numeral uses the clamp from §1.5.
- Labels are 13px medium muted. Context is 13px muted. Both stay on their own lines (ui-standard: never beside the numeral).
- Help (?), ↗ and hover trend are unchanged. Critical is red only when non-zero.

**Band 2: Alert flow.**
- **Noise flow:**
  - remove the flat variant's inner `border-y`;
  - inline height becomes `clamp(240px, 18vw, 340px)`. `SIMPLE_INLINE_HEIGHT` must follow the measured wrapper height, because the viewBox uses `meet`;
  - stage tags go to sentence case at 12px (no uppercase tracking);
  - the button label is "Full screen" in both modes;
  - "√ scale" becomes plain muted text plus (?);
  - "15 open cases → Review" becomes a text button with a count, still a tab stop;
  - **add the Google SecOps headline number** "Alert reduction X%", computed only when alerts and cases come from the same measured window; otherwise an em dash with a reason.
- **Human vs AI:** totals at 24px numerals with 13px labels. The chart is `flex-1` so it matches the flow height. The caption line is kept.

**Band 3: Cases and response** (5 / 3 / 4 at `xl`).
- **Case state:**
  - Open and Resolved snapshots sit **side by side** when the cell is ≥560px (container query `@[35rem]`) and stack otherwise.
  - Donuts are 128px.
  - The legend is `max-w-[15rem]` with count and % right after the label. This fixes the 470px gap.
  - TrendChip is borderless tinted text.
  - Add one quiet cross-reference line using existing values: "of 23 open now (any arrival date) · 38 resolved". The three "open" figures then read as related, not contradictory.
  - Keep the donut, which was operator-prototyped. Any switch to a stacked severity bar is a P2 option, not a requirement.
- **Response time:**
  - Rename the visible section title "MTTD / response" to "Response time"; the stat labels keep "MTTD" and "Respond".
  - Top-align both stats with 24px between them (remove `xl:justify-center`).
  - "Detail →" is kept.
  - Add MTTD/Respond **p90 beside p50** when the posture API returns it; otherwise show nothing new.
- **Latest cases:**
  - Row count fills the band: 5 at 1280, 6 at 1440, 8 at ≥1920. This adds rows and removes none. Update the "do not raise above 5" comment and the `.slice(0, 5)` (`Overview.tsx:1499-1517`).
  - Remove `max-w-40` on the ID.
  - Title 14px, metadata 12px, status badge stays 11px.
  - **Terminal rows show the analyst outcome** per §3.1 ("Closed · False positive").

### 2.4 Type ladder (Overview)

| Role | Size/leading | Weight | Tracking |
|---|---|---|---|
| Page title | 28/34 at `2xl`, 24/30 below | 650 | −0.021em |
| Band title | 15/20 | 600 | −0.009em |
| Band caption, KPI label, KPI context | 13/18 | 400–500 muted | −0.003em |
| KPI numeral | clamp 32→44 | 600 | −0.021em, `tabular-nums leading-none` |
| Instrument numerals (donut centre, MTTD, HvA totals) | 24–28 | 600 | −0.020em |
| Lists, legends, stage labels | 13–14 | 400/500 | per §1.5 |
| Metadata (IDs, ages) | 12; mono only for IDs | 400 | 0 |
| 11px | badges, axis ticks, timestamps **only** | 500 | +0.005em |

No colour is added for emphasis. Numerals are neutral ink.

### 2.5 Chrome reduction (keep controls, drop boxes)

Target: **≤20 bordered elements** in the collapsed view (34 today), and **≤4 horizontal rules** crossing any column (10 today).
- Remove: TrendChip border, "√ scale" chip, Review button border, inner flow `border-y`, per-cell lattice hairlines.
- Keep: the Partial-coverage callout's single left rule (it carries meaning), and the SegmentedControl.

### 2.6 Deeper analytics

- **One** disclosure keeps the label "Deeper analytics" (test anchors). It is collapsed on the first visit, and its open/closed state is **persisted per user**: `UserPrefsStore` if available, else a try/catch `localStorage['soc.overview.deeperOpen']` (new keys use the `soc.*` prefix).
- **Collapsed header shows an inline summary** of existing values, so nothing hides behind an unlabelled fold: "MTTA 14m · MTTR 2h · Dwell 3h · $3.12 spend · 1 silent source · top signature: X".
- The inside is flat. **No `<Card>`, no accent bars (`KpiTile variant="bar"`), no nested collapsibles.**
  - Sub-band "Efficiency and cost": MTTA · MTTR · Dwell · LLM spend as a **second continuous strip** (same `KpiTile` strip grammar, 4 cells, own divider math). Then Ingest coverage (4 col: hero n/m, bar, three stats in one row) | Case volume (8 col, chart `flex-1`, **columns per bucket** with gaps for unmeasured buckets, per the hover-trend rule).
  - Sub-band "What's driving volume": Case workload state (4) | Case outcomes (4) | Top signatures (4), with Top entities sharing a row or `Top signatures 6 | Top entities 6` at `3xl`. Equal heights.
- **"VERDICTS" overflow fix:** the centre shows the numeral plus a sentence-case "verdicts" at 12px **below** it, with the hole sized for it. Use one legend position for every donut (Carbon: legends in the same position).
- Add the honesty label **"AI-verdict" FP** where the outcomes donut and the FP KPI context say "verdicted". This links to §3.1: analyst-adjudicated FPs are not counted there.

### 2.7 KPI drill-down modal

- Chrome text goes 11px → 12–13px.
- **Trend chart (60%) and the 4 stats (40%, as a 2×2 with no card borders) go on one row.** This frees 120–150px, so about 10 table rows are visible at 1440 instead of 6.
- The four stat boxes stop being bordered cards inside a bordered modal.
- The footer keeps "Showing N of N · complete page of M" visible. The long scope/range disclosure moves behind "About these rows". The honesty review must confirm partial evidence remains visible text.
- Widen the Case column, or show `case_number`.
- The dialog scales from the clicked tile (§1.6).

### 2.8 Breakpoint table

These approximate content widths combine both briefs (nav pinned 240 / collapsed 64, 10px scrollbar, shell gutter):

| Viewport | Pinned | Collapsed | Layout |
|---|---|---|---|
| 1280 (`xl`) | ~982–998 | ~1174 | strip 6 across; flow 8 / HvA 4 (no cell padding); band 3 = 5/3/4; `gap-x-6` |
| 1440 | ~1158 | ~1334 | same; snapshots side by side when the cell is ≥560 |
| 1536 (`2xl`) | ~1254 | ~1430 | instrument padding `p-5`; numerals larger via the clamp |
| 1920 (`3xl`) | ~1638 | ~1814 | `gap-x-8`, `gap-y-10`; Latest cases 8 rows; Deeper sub-bands side by side (Efficiency 5 · Volume 7) |
| ≥2200 (`4xl`) | — | — | cap 2400; **two-column macro**: main (bands 1–3) + 460px rail (HvA over Latest cases) |

### 2.9 Motion and material on Overview

- The dashbar uses `materialBar` and the scroll-edge fade.
- Bands reveal with `Stagger` at no more than 40ms per item and under 300ms in total, **first load only**.
- LIVE refresh replays only the existing one-shot noise sweep. Numerals do not re-roll and layout never animates.
- Tiles get `.press-scale` (gated) and the drill-down scales from the tile.

### 2.10 Data inventory: every item must survive (checklist for review)

- **Masthead:** title; TimeRangePicker; auto-refresh select; RefreshButton; AutomationNudge; LoadError+Retry; EmptyState (Connect a source / Start demo).
- **KPI strip ×6** (Total Cases · Total Critical · Open Cases · False Positive Rate · Resolved/Closed · Auto Closed). Each tile keeps:
  - label, count-up numeral, context line, `sub` state, `bound` mark;
  - help (?) with Ask-about-this, ↗;
  - hover trend where an honest series exists (none on Critical and Open);
  - drill-down modal.
- **Noise flow:**
  - title, help, Simple/Detailed, Full screen, hide toggle;
  - partial/warming/unavailable/integrity notices;
  - all stages with count and %, including the optional analyst-policy and Awaiting-review cohorts;
  - stage hover cards; √ scale + rule; "N open cases → Review" with bound mark; narrow stage rail; refresh sweep;
  - Detailed mode: headline, loss badge, six-stage rail, excluded spur;
  - full-screen dialog.
- **Human vs AI:** totals ×3 with share; stacked bars per bucket with ticks; caption; bounded/stale/unavailable lines; alerts-ingested tally.
- **Snapshots ×2:** title, caption, TrendChip, donut + centre total, 5-severity legend with count and %, CTA deep link, hover trend.
- **Response:** MTTD and Respond, each with value/—, definition line, samples/reason, help and hover trend; "Detail →".
- **Latest cases:** rows (title, ID, age, status), hover card, opens CaseDetail sheet, "View all", "Queue clear".
- **Deeper:**
  - MTTA, MTTR, Dwell, LLM spend (tokens · calls, retry, link, hover trend);
  - Ingest coverage (reporting/enabled, configured, bar, Events/min, Triaged 24h, Silent, alarm/all-clear, not-reported state);
  - Case volume; Case workload state (count, per-status bars → filter);
  - Case outcomes (donut, 4-verdict legend);
  - Top signatures and Top entities (≤8 rows, rank, count, bar, %).
- **KPI modal:**
  - breadcrumb, completeness badge, population sentence, Export listed, Close;
  - 6-metric switcher;
  - filters (search, severity, status, source, sort, range);
  - partition block; trend with first/peak/latest/buckets; "Over the N cases" sentence; 4 stats;
  - 7-column table; footer + drill-through + scope + range caveat.
- **New, additive only:** per-band "Updated …", Alert reduction %, p90 timing, cross-reference line, inline Deeper summary.

### 2.11 Contract changes, tests, acceptance

- **ui-standard amendments** (same candidate):
  - "Operational metric surfaces": a dashboard strip may use the new `comfortable` density; a band gap replaces "no vertical gap/no second hairline".
  - Bands are flat with a 24/32 gutter grammar.
  - Radii (§1.3), materials (§1.4), and the agent-activity glyph exception (§1.6).
- **Tests to update deliberately (never delete):**
  - `overview.render.test.tsx` (strip classes, compact `px-3 py-2`, snapshot `w-28`/`text-3xl`, page-hero not `bg-card`);
  - `overview.commandcenter.test.tsx` (noise rail classes, tile `bg-transparent`);
  - `overview.kpimodal.a11y.test.tsx`;
  - `overview.a11y.test.tsx`.
  - Keep testids (`kpi-strip`, `hero-row`, `kpi-*`, `human-vs-ai*`, `noise-*`), section `aria-label`s and h2 order.
- **Measurable acceptance** (Playwright at 1280/1440/1920/2560 × light/dark × nav pinned/collapsed):
  - no 11px text outside badges, ticks and timestamps;
  - ≤4 rules crossing the flow column;
  - ≤20 bordered elements collapsed;
  - flow container ≥608px at 1280 pinned;
  - equal row heights within ±2px per band;
  - empty viewport below content ≤10% at 2560×1440;
  - KPI modal shows ≥9 rows at 1440;
  - zero horizontal document overflow;
  - the inventory checklist (§2.10) asserted by a DOM test that queries each datum's label.

---

## 3. Case Manager redesign: keep every datum

### 3.1 The headline rule: analyst classification beats AI verdict once a human classifies (P0)

**Root cause of the SOC analyst's screenshot** (`diag/disposition.md`). There are two defects.
1. **Persistence, on their build (0.1.12).** The Close dialog posts `disposition`, but the 0.1.12 backend applies it only for `set_disposition`/`confirm_fp`. The close therefore keeps the `UNDETERMINED` that `case_manager.apply()` mapped from NEEDS_HUMAN.
   - Fixed on Testing in `b957dfc` (`_DISPOSITION_ACTIONS = {"set_disposition","close"}`), but that commit is **not in any shipped tag**.
   - Workaround on 0.1.12 today: Take Action → **Set disposition**.
2. **Presentation, still on HEAD.** `decisionHeadline(c.verdict, c.status)` (`OverviewPanel.tsx:132-156`) builds "Needs human review — closed" from the AI verdict even after an analyst recorded False positive.
   - Several surfaces (hover card, Cases verdict column and needs-human pill, "Code decided" copy, `autoCloseSummary`, recommended action) also read only the AI verdict.

**Competitor consensus** (`case-ux.md §2.1`): status answers "where is the work", classification answers "what was it", and the AI verdict answers "what did the machine think".
- After a human resolves, the **classification is the outcome of record**: Defender Classification, Sentinel Classification (mandatory), XSIAM "Resolved – False Positive", SecOps Reason + Root cause, Splunk Disposition, TheHive closing status.
- The AI verdict stays as a labelled recommendation. Splunk: "The agent never changes any fields on your behalf … you remain in control of the final disposition".

**One pure helper** lives in `webui/src/soc/components/outcome.ts` and is unit-tested. It mirrors the backend `analyst_outcomes.is_classification_entry`, so the Console and the ground-truth authority cannot disagree:

```ts
export type OutcomeSource = 'analyst' | 'analyst_policy' | 'analyst_unrecorded' | 'agent_auto' | 'pending';
export interface CaseOutcome {
  source: OutcomeSource;
  disposition: Disposition | null;   // analyst value when source==='analyst'
  by?: string; at?: string;          // from the classification history entry
  aiVerdict: Verdict | null; aiConfidence: number | null;
  agreement: 'agrees' | 'overrides' | 'resolved' | null; // NEEDS_HUMAN → concrete outcome = 'resolved', not 'overrides'
}
export function caseOutcome(c: Case): CaseOutcome;
```

Precedence. The first match wins:

| # | Condition | Headline (h2, sentence case) | Secondary line (muted, Bot glyph + AI tag) |
|---|---|---|---|
| 1 | `decision_by === 'analyst'` **and** a classification entry exists. Scan `history` newest-first for `event==='analyst_action'` with `action ∈ {set_disposition, confirm_fp}` or a non-empty `classified_disposition`. | Status-aware outcome: "Closed as false positive" / "Resolved: true positive" / "Closed as benign" / "Closed as duplicate" / "Classified as suspicious: investigating" | "Classified by {by} · {relative at}" · "AI assessed: Needs human review · 98% confidence" |
| 2 | `decision_by === 'analyst_policy'` | "Closed by analyst policy (declared benign)" | policy name · AI line as above |
| 3 | terminal **and** `decision_by === 'analyst'` **and** no classification entry | "Closed by analyst: outcome not recorded" plus an inline **Set disposition** button | AI line |
| 4 | agent auto-close (`isAutoClosedByAI`) | "Auto-closed as false positive" plus the AI tag and the objection window | policy line |
| 5 | otherwise (open, pending, system routing) | the current `decisionHeadline` output, **explicitly attributed**: "AI assessment: Needs human review — on hold" | — |

Rules:
- **The disposition value alone is never evidence.** A model-derived `true_positive` echoed by an undeclared close must not render as the analyst's call. That is why rows 1 and 3 require the classification entry.
- Three visual grammars, never mixed:
  - **Status** = glyph + sentence-case text, no fill;
  - **Outcome** = filled semantic `DispositionBadge` with a new **`'analyst'` provenance tag** (add `'analyst'` to `Provenance` in `lib/types.ts` near line 4170 and to `ProvenanceTag` meta);
  - **AI verdict** = outline badge with Bot icon and `ProvenanceTag kind="ai"`.
- After a human classification, relabel the Confidence meter "AI confidence (at assessment)".
- Optional, additive and #3-safe: a backend read-time projection `analyst_outcome` on the Case response, computed by the same `_confirmation` core. No migration.

**Apply the helper on every surface:**
- **Overview tab** decision band and the sheet brief.
- **Embedded header** meta row (§3.3).
- **Queue row**: terminal rows say "Closed · False positive", not just "Closed".
- **CaseHoverCard**: outcome badge next to the AI verdict.
- **Cases list:**
  - show **Disposition** by default (remove it from `CASES_DEFAULT_HIDDEN`), or add an "Outcome" column that shows the analyst value, else the AI verdict with its provenance icon;
  - the **needs-human pill counts only active cases** (`Cases.tsx:201`, `needsHumanCase` → `isActiveCase(c) && …`).
- **"Code decided" lane:** when terminal and `decision_by==='analyst'`, title it "Analyst resolved". The copy becomes "Closed by an analyst (human lifecycle action). The deterministic policy did not close this case", which removes the contradiction with "Authority: Analyst".
- **`autoCloseSummary`:** returns `null` when a human closed the case.
- **Recommended action** on terminal cases: retitle "AI recommendation at triage" and demote it below the facts grid.
- **Grading** (`grading.tsx:169`): NEEDS_HUMAN → any concrete disposition = **"resolved"** (no comparison), as `duplicate` is handled today, so agent-effectiveness stops counting it as "disagree".
- **FP-rate honesty:** keep `false_positive_rate` byte-identical, because it is a shipped series. Label it "AI-verdict" in its context line and help. Optionally add `analyst_confirmed_false_positive_cases` (from `analyst_confirmed_outcome`) in the drill-down.

### 3.2 A classification is captured on every terminal path (P0)

- **Ship the persistence fix.** `b957dfc` must be in the 0.1.13 promotion (or a patch). Existing regressions cover it: `test_g1_ground_truth_intake.py:119` and `:152`.
- **Single resolve:**
  - add `'disposition'` to `ALL_ACTIONS.resolve.fields`;
  - backend: add `resolve` to `_DISPOSITION_ACTIONS` (analyst layer, `_perform_case_action`);
  - require a disposition when the action lands on a terminal status.
- **Bulk Resolve and a new bulk Close…** open one dialog with the **required disposition** (opens empty; G1) plus optional resolution and note, as SecOps does.
  - The `case_lifecycle` job payload carries `disposition` and `disposition_declared: true` only when the picker was operated.
  - Per-record partial failures stay retryable (ui-standard).
- **"Undetermined" is an explicit analyst choice** (Sentinel/Splunk parity), never a silent default.
- **Reconcile prompt.** If the grading "What actually happened?" is binary and conflicts with an auto-`undetermined` disposition, show an inline prompt: "You graded this a false positive. Record it as the case disposition?" with buttons **Record** / **Not now**. Never write silently.
- Close dialog:
  - promote the existing "AI said X → you're recording Y" chip to a two-column compare line;
  - map Defender's classification → determination onto the existing `resolution` select;
  - the primary button is **"Close & next"** (Active mode advances to the next case); the secondary is "Close".

### 3.3 Header anatomy (P1)

- The header is **sticky inside the detail pane** (`sticky top-0 z-10`) using `materialBar` and the scroll-edge fade, with a solid fallback (§1.7).
- **Line 1:** title, `text-xl font-semibold`, tracking −0.014em, `line-clamp-2`, full title on hover/focus.
- **Line 2 meta row** (`text-xs`, wraps, `@container/case-header` collapses labels to icons below 520px):
  - display ID + copy;
  - severity badge;
  - **status** (glyph + text);
  - **outcome** (§3.1; omitted while pending);
  - **assignee** monogram with a Radix `Popover` for quick reassign;
  - **tags** (first 2 + "+n" popover);
  - **age and SLA** ("Open 3h · Ack 12m"; from `detected_at`/`acknowledged_at`/`first_response_at`);
  - Sample/Demo badge.
- **Right side:**
  - **one primary contextual button** from `actionPlanForStatus().primary` ("Acknowledge", "Close…", "Reopen");
  - Take Action menu (all existing items, unchanged);
  - Share;
  - close (xl).
- Keep the Take Action grouping: *Case actions* / *Investigation* / *Share & export*.

### 3.4 Queue (P1)

- **Keep the two-line row grammar** (ui-standard). Fix the truncation priority seen at the default 400px pane (`diag-cm-dark-1440-overview.png`: "case-dfe…", "Micros…"):
  - severity word, Risk N and status are `shrink-0` and never truncate;
  - the display ID shrinks second (`min-w-0 truncate`, shrink 1);
  - the secondary fact shrinks first (`shrink-[3]`) and is hidden below a container width of 360px. It remains in the hover/focus detail and the case header, so it is not lost.
- Terminal rows show the outcome word (§3.1). Add an assignee monogram (20px) before the age. At most one new element per line.
- **Keyboard** (Defender ↑/↓ parity), with each change announced via the shell announcer:
  - `J`/`K` and `↑`/`↓` on the focused list move selection and open;
  - `Enter` opens;
  - `X` toggles the checkbox;
  - `Shift+X` range-selects.
- **Wayfinding:** the queue header shows position ("3 of 23 active").
- **Density toggle** (Comfortable / Compact) via `SegmentedControl`, persisted per user (SecOps Default/Compact parity). Compact is a single line: title, severity, status, outcome.
- **Default pane width** 400 → 440 at `2xl` (bounds 320–680 unchanged). The separator keeps its keyboard contract.
- **Close & next:** the row animates out (`SPRING_UI`; instant swap plus a toast under reduced motion) and the next row is selected and focused.

### 3.5 Overview tab: reorder and surface hidden fields

New order (all existing items kept):
1. **Outcome band** (§3.1).
2. **Key facts grid** (new, `grid-cols-2 @[40rem]:grid-cols-4`, label 12px muted / value 14px). It contains Impact, Priority, Urgency band, Assignee, Tags, Detected / Acknowledged / First response, Source, Detection source, Origin surface and Source id.
   - This surfaces every field in `case-ux.md §3.6` that is currently not rendered.
   - It reuses the unused `components/CaseTriageHeader.tsx` chips (Risk / Severity / Impact / Priority with input help tips) instead of new code.
3. Recommended action (demoted wording when terminal).
4. Signal profile (Risk meter "Deterministic case input", Confidence meter, the 5 risk factors with help).
5. Investigation inputs.
6. Provenance row (Source says / Agent found / Code decided-or-Analyst resolved).
7. Entity row (Primary entity, Attack story, Entity relationship).
8. Baseline signature, Evidence checklist, Reproduce investigation, Investigation error.
9. Collapsibles: Related cases; Provenance & audit, which **adds `history[].classified_disposition` (who classified, when)** and `notifications_sent` to the status timeline.

- Signal profile labels drop tracked uppercase ("RISK SCORE" becomes "Risk score"); Testing already did this in `05a40d1`.
- **Tab labels carry counts:** Investigation (tools run), Threat context (IOCs), Collaboration (messages · open tasks).
- **Activity feed filter:** All / Human / AI / System (Defender Activities, SecOps Case Wall).
- **Case chat must not lose its transcript on a tab switch** (`diag/working.md`: Radix Tabs unmount the panel and transcript characters went from 2,517 to 0). Either `forceMount` the Chat panel with `hidden`, or adopt the external turn store from the working-indicator work.

### 3.6 Apple specifics for this surface

- **Response:** rows darken on `:active`; buttons use `.press-scale`.
- **The four feedback kinds:**
  - status: job progress in the bulk banner;
  - completion: toast "Closed as false positive · Undo", where Undo runs Reopen with the prior status, available for 8s;
  - warning: the reinvestigate token cost;
  - error: inline with Retry.
- **Spatial:** the detail pane, sheets and the report panel enter and exit right. Menus scale from their trigger.
- **Interruptibility:** switching cases mid-transition retargets from the current value; input is never locked. The split resize stays 1:1 with pointer capture.
- **Typography:** title −0.014em; meta row 12px at 0 tracking; no tracked caps.
- **Materials:** only the sticky header is translucent. Tabs and evidence are opaque.

### 3.7 Nothing-lost checklist, tests and guardrails

- **Queue:**
  - scope line; Active/All; refresh; search across 10 fields; severity/status filters; 4 sorts; clear; select-visible;
  - row rail, title, age, severity, risk, ID, fact, status;
  - 8 bulk actions + job banner; resize persistence; mobile back path.
- **Header:**
  - title, ID+copy, severity, demo badge, Share;
  - every Take Action item: lifecycle per status, reinvestigate (model + cost), playbook, refresh, ask, new tab, JSON, Markdown, notify, campaign;
  - close.
- **Overview:** every item in `case-ux.md §3.3`. **Tabs:** `§3.4` in full. **Dialogs:** `§3.5`. **Newly surfaced:** `§3.6`.
- **Tests:**
  - `caseOutcome` table tests: each precedence row; undeclared close → row 3; model-echoed disposition is not analyst; NEEDS_HUMAN→FP = `resolved`;
  - `OverviewPanel` keeps its AI-only cases and adds the classified-FP, undeclared-close and agent-auto-close cases;
  - Cases needs-human pill excludes terminal cases;
  - hover card shows the outcome;
  - bulk Resolve sends `disposition` + `disposition_declared`;
  - backend `resolve` applies the disposition;
  - J/K navigation and its announcement;
  - Close & next focus;
  - axe on header and meta row.
- **Guardrails:**
  - #3: nothing here calls `decide()`; outcome precedence is presentation, and disposition-on-resolve is the existing analyst layer.
  - #9: all strings are plain text.
  - G1: pickers open empty.

**Draft one-liner for the SOC analyst.** Send it only after the fixes ship in the build he uses: *"Fixed: when you close a case and pick a disposition (e.g. False positive) it now actually saves — the old build silently kept 'Undetermined' — and a closed case's headline now shows your classification ('Closed as false positive', by you, when) with the AI's original verdict kept underneath as a secondary 'AI assessed' line."*

---

## 4. Remember me: the recommended design (one option)

**Decision.** Use a **persistent, server-bounded remembered session** plus a **remembered username**. The password is remembered **only by the browser's password manager**.
- Rejected: storing the password in app storage (localStorage, IndexedDB or a readable cookie). OWASP says "Do not store … any credential in localStorage" and treats a third-party app storing "the user/password combo" as unsafe. NIST SP 800-63B-4 §5.1 says "remember my browser" features "SHALL NOT be used instead of authentication".
- Rejected: a "trust this device for MFA" option.

Detailed spec: `remember-me.md §4` (policy fields, cookie helper, `_remember_decision`, MFA/SSO wiring, tests 1–19 + webui 1–12). Summary and the two adjustments I make:

1. **What the checkbox does.**
   - **Checked:** a persistent `tlsoc_token` cookie with `Max-Age` = the policy duration. The JWT `exp` is the same, and the row carries `remember: true`.
   - **Default: 24h.** Admin presets are **6h / 12h / 24h**, with 24h the maximum (NIST AAL2 overall-timeout ceiling; Cortex and Google Cloud also cap at 1–24h). An optional remembered-idle limit defaults to off.
   - **Unchecked:** a non-persistent session cookie plus the existing server idle and absolute limits. This is a behaviour change, recorded under CHANGELOG "Changed". **The server registry is always authoritative.**
   - The user's "once a day or once every 6 hours" maps to the default 24h and the admin's 6h preset.
2. **Re-authentication.** After expiry the user runs the full password + MFA flow. `require_fresh_auth` (10-minute sudo) still gates sensitive actions inside a remembered session. Remember-me never bypasses MFA; the `rm` claim travels in the **signed** pending token.
3. **Username and password.**
   - After a **successful** sign-in with the box checked, store `localStorage['soc.login.rememberedUsername']`. On return, open the password step with the username chip, focus the password field and pre-check the box. Offer "Use a different account" and a "Forget this device" action.
   - For the password, add a hidden `autocomplete="username"` field inside the password-step form. The form currently lacks it, and Chromium documents it as required for two-step sign-in. In Chromium only, call `navigator.credentials.store(new PasswordCredential(...))`, feature-detected, fire-and-forget.
   - Add a Vitest that spies `Storage.prototype.setItem` to prove the password is never persisted.
4. **Warning on check.**
   - Use the existing `ConfirmDialog` (Radix AlertDialog) in a *warning* tone: amber `ShieldAlert`, not red.
   - Title: "Keep this device signed in?"
   - Body: the shared-device copy from `remember-me.md §4.6`, which names the duration and the username.
   - Buttons: **Keep me signed in** / **Cancel**, with **Cancel focused by default**.
   - Acceptance is remembered per device (`soc.login.rememberAck`), so the dialog does not nag.
   - Apple fit: the confirmation is justified because the risk is real and irreversible on a shared machine (§16 Agency, Responsibility). The whole row is a 44px hit target with press feedback.
5. **Admin control.** Add a "Remember me" group in **Settings → Security → Session policy**:
   - enable;
   - duration presets (`SegmentedControl` 6/12/24h, custom 1–24h);
   - remembered idle;
   - excluded roles;
   - allow-on-plain-HTTP.

   The login page learns the policy from the existing public `GET /api/setup/status` (`remember_me{enabled, duration_seconds, insecure_blocked}`), so there is no new public path. Fix the `SessionPolicyEditor` `DEFAULTS` drift at the same time.
6. **Adjustment 1: visibility.** `remember-me.md` hides the checkbox when it is disabled or on insecure transport. Instead, **show it disabled, with a one-line reason**:
   - disabled: "Turned off by your administrator";
   - insecure: "Available when the console is served over HTTPS".

   The operator explicitly asked for the feature. Silently hiding it on a plain-HTTP LAN deployment reads as "not implemented", and Apple wayfinding says to explain, not hide. Hide it only when `auth_enabled` is false.
7. **Adjustment 2: the server reason surfaces.**
   - When the server returns `remembered:false` (`role_excluded`, `insecure_transport`), show a one-line toast after entry: "Remember me isn't available for your role. You'll stay signed in until you close the browser."
   - Remove the remembered username in that case.
8. **Prerequisite bug fix (P0).**
   - Problem: `/auth/me` ignores the session registry. Verified live: after a revoke, `/api/cases` returns 401 while `/auth/me` returns `authenticated:true`, so the SPA is stuck in a console where every call 401s. Longer sessions make this routine.
   - Fix: run the registry check, clear the cookie, and return `reason` (`revoked | idle_expired | absolute_expired | tv_mismatch`).
   - The login page then shows a calm notice ("For your security, you were signed out after 24 hours").
9. **Sessions UI.** Add a "Remembered · until {time}" badge and an "Expires" column on Account → Sessions.
10. **Docs.** Add a "Session lifetimes" table in `docs/operations/security.md` as the ASVS 7.1.1 record of the NIST deviation (a persistent cookie at most 24h). Also document `AUTH_COOKIE_SECURE=true` for HTTPS deployments.

---

## 5. Report download: fixes list

**Evidence** (live demo, Testing HEAD, re-run for this synthesis):
- **Double-export probe** (`research/probe/dbl_probe.mjs`, every `/api` call +600ms):
  - each library-row export took **~4.2s with no busy feedback** (`aria-busy` 0, no status text);
  - two clicks produced **two identical downloads** (4158ms and 4167ms);
  - the anchor was **detached** and the object URL was **revoked 0–1ms after `click()`**.
- **Print probe** (`research/probe/print_probe.mjs`) at the instant `window.print()` runs:
  - `document.title` was **"Agentic SOC"**;
  - `body` was `overflow:hidden` with `data-scroll-locked` (the Radix menu lock was still active);
  - **12 content-bearing `<button>`s** were inside the print root and are hidden by the print CSS: "Contents (4 sections)", "Summary", "Open work", "Key metrics", "Next steps", and the table headers Campaign / Status / Cases / Severity / First seen / Last seen / Shared entities;
  - **18 `content-visibility:auto`** elements;
  - in the simulated non-blocking `afterprint` mode, the root was **gone one tick later**.
- **PDF output** (`diag/rep-dl/pdfpng/*`, 12 A4 pages for 4 items):
  - empty "1. 2. 3. 4." list;
  - "Open work" and "Key metrics" headings with nothing under them;
  - campaign table with no header row and very tall empty rows;
  - KPI numeral "19" rendered as **"1.."**;
  - the "01/10" table-toggle glyph printed on every block;
  - near-empty pages (p-04 about one-third used, p-05 three lines).
- **Ctrl/Cmd+P on the report document view** (`probe/ctrlp-docview-printmedia.png`) prints the console chrome (sidebar, top bar, dark theme), cropped to the scroll container.
- **Markdown output** contains `Network &amp; Linux` and over-escaped `\(unassigned\)`.

**Competitor bar.**
- XSIAM *Reports*: a "Generated Reports" history you can re-download; reports laid out on **A4 pages**; **CSV per widget**, attached separately or zipped with the PDF.
- Splunk ES AI reports save as **Attach as file / Add as note / Download as PDF**.

Sources: [XSIAM Reports](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/manage-dashboards-and-reports/reports.md), [XSIAM create report template](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/create-reports/create-a-report-template-from-scratch.md), [Splunk generate a report with the AI Assistant](https://help.splunk.com/splunk-enterprise-security-8/user-guide/8.2/mission-control/summarize-findings-and-investigations-with-the-ai-assistant/generate-a-report-with-the-ai-assistant).

| ID | Pri | Symptom (evidence) | Fix (file) | Test |
|---|---|---|---|---|
| R1 | P0 | 4.2s silent wait; double click → 2 files | **In-flight guard + visible progress.** One `exporting: ReportExportFormat \| null` state per report (panel, library detail, library row). While set, disable the Export trigger and items, put button-level progress on the Export button (`aria-busy`, fixed icon slot, per ui-standard "Button-level progress remains local"), and announce "Preparing Markdown…" then "Markdown downloaded: {filename}". Ignore re-entry. (`ReportPanel.tsx:524`, `ReportsLibrary.tsx:231,446`) | Two rapid selects → exactly 1 `downloadText` call; `aria-busy` true during the export |
| R2 | P0 | `void doExport(...)` in the panel and library detail has no `try/catch`. A stale-deploy chunk 404 on `import('./export/run')` or a `loadReportSourceContext` rejection becomes a silent unhandled rejection (the library row path already catches) | Wrap both in `try/catch → setActionError/setNotice(reportErrorMessage(err, 'The report could not be exported.'))` plus a Retry action. On a chunk-load error, use copy that suggests reloading | Mock a rejected import → visible error + announce |
| R3 | P1 | Every export re-reads the report and **all source conversations** | Warm on **menu open** (`onOpenChange(true)`): `import('./export/run')` and, for non-JSON formats, start `loadReportSourceContext`. Cache by `report.id@version` in a module `Map`; reuse the doc view's already-loaded `useSourceTurns` | Second export of the same version makes 0 conversation reads |
| R4 | P0 | Detached anchor; object URL revoked synchronously | `downloadText`: `document.body.appendChild(a)`, `a.click()`, `a.remove()`, then **`setTimeout(() => URL.revokeObjectURL(url), 40_000)`**, as FileSaver.js does ("setTimeout(… revokeObjectURL …, 4E4) // 40s", [FileSaver.js](https://raw.githubusercontent.com/eligrey/FileSaver.js/master/src/FileSaver.js)). Keep the feature detection | Fake timers: no revoke before 40s; anchor attached during the click |
| R5 | P0 | PDF default name "Agentic SOC.pdf" (title at print = "Agentic SOC") | In `printDocument`, set `document.title = exportFileName('report', doc.title, 'pdf').replace(/\.pdf$/, '')` before `print()` and restore it in the cleanup. (The browser uses the title as the suggested PDF name; observed in the probe.) | Title equals the stem during print and is restored after |
| R6 | P0 | Print CSS `#root button { display:none }` hides **content**: TOC list (empty "1.–4."), section toggles ("Open work", "Key metrics" orphaned), sortable table headers (headerless table) | Hide only `[data-print-hide]`. In `staticMode` (already threaded through `BlockCard`): render the ReportView TOC as a plain `<ol>` of text, or omit it in print; force every collapsible open (`forceMount`); render sortable header buttons as plain text `<th>`; render case-link buttons as text. Mark the block menu, add-to-report and view toggles `data-print-hide` | Print-root DOM: no hidden element contains text content; every `th` and `li` has text |
| R7 | P1 | "01/10" table-toggle glyph prints on every block | Mark that control `data-print-hide` and do not render it in `staticMode` | Snapshot of the static block has no toggle |
| R8 | P0 | 12 pages for 4 items; near-empty pages | Replace `break-inside: avoid` on whole `.report-block`. Apply it only to small atoms: `figure`, KPI grids, `tr`, `[role=note]`, `li`. Add `h4,h5,h6,.report-item-header { break-after: avoid }`, `p { orphans:3; widows:3 }`, `thead { display: table-header-group }` (repeated headers). Keep `@page { size: A4; margin: 14mm 12mm }` (XSIAM is also A4) | Print-emulated `page.pdf()`: page count ≤ 8 for the fixture; no page under 25% filled except the last |
| R9 | P0 | KPI "19" printed as "1.." | Never truncate numerals. In `KpiGroupView`, put the delta chip on its own line in `staticMode`/print and let chips wrap; remove `truncate` from value spans | Print-root measure: no `.truncate` numeral is clipped |
| R10 | P1 | Body still `overflow:hidden` + `data-scroll-locked` from the closing Radix menu at print time. Chromium tolerated it in our test; some engines clip printing to one page when the root overflow is hidden **[unverified]** | Start print only after the menu has fully closed: run the action from `onCloseAutoFocus`, or `await` two rAFs plus a check that `document.body.dataset.scrollLocked` is absent. Add `html, body { overflow: visible !important; height: auto !important }` to `PRINT_CSS` | Probe: at `print()` time `bodyLocked === false` |
| R11 | P1 | If `afterprint` fires before the snapshot (non-blocking `print()`), the root unmounts in the same tick and the PDF comes out blank (simulated). MDN: `afterprint` fires "after the associated document has started printing or the print preview has been closed" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/afterprint_event)) | Unmount on `afterprint` **only after a 1s grace** and when `matchMedia('print').matches === false`. Keep the 60s fallback | Simulated immediate `afterprint` → root still present at +500ms |
| R12 | P1 | Ctrl/Cmd+P on the document view prints the console chrome, dark, cropped | On the report document view, register a `beforeprint` listener that mounts the same print root synchronously (`flushSync`; the BlockCard chunk is preloaded on view mount) and an `afterprint` cleanup. Add an app-level `@media print` fallback: hide `[data-app-chrome]` (nav, top bar) and un-fix `html, body, #root` heights | `emulateMedia('print')` on the doc view → no nav in the PDF |
| R13 | P2 | 18 `content-visibility:auto` nodes in the print root. MDN notes skipped rendering for off-screen `auto` content | Add `#print-root * { content-visibility: visible !important }` to `PRINT_CSS` | Grep print CSS |
| R14 | P1 | Markdown shows `&amp;` and `\(…\)` | `mdText` (`export/markdown.ts:26-30`): escape `&` **only when it starts a character reference** (`/&(?=#?[a-z0-9]+;)/gi`). Drop the `(`/`)` escapes (`[`/`]` are already escaped, so links cannot form) and escape `!` only before `[`. **Keep** `<` / `>` escaping (#9: no raw HTML from log or model text) | Existing #9 markdown tests stay green; new: `Network & Linux` round-trips; `<script>` is still escaped |
| R15 | P1 | Multi-table CSV opens in Excel without encoding info (the data contains "—") | Prefix the CSV export with a UTF-8 BOM (`'﻿'`) so Excel decodes UTF-8 **[unverified here; well-known Excel behaviour, verify on Windows Excel]**. Keep the `#` section rows. P2: "CSV (one file per table)" as a store-only ZIP built with an in-repo ~80-line writer (no dependency), as XSIAM does | First bytes `EF BB BF` |
| R16 | P2 | No report history or re-download after export (XSIAM "Generated Reports") | Optional: record export events (format, filename, at, by) on the report's KV doc and list them in the library detail. Server-side generation as a durable Job artifact (the jobs runner already serves verified ZIP artifacts) is a later option; server-side PDF is out of scope (no headless-browser dependency) | — |
| R17 | P1 | Success is only announced to screen readers | Show a visible toast on success with the filename and, for Print, "Print dialog opened. Choose Save as PDF". Errors stay inline with Retry | Toast rendered with the filename |

Order of work: **R4 → R1/R2 → R5/R6/R8/R9 → R10/R11/R12 → R3/R7/R14/R15/R17 → R13/R16.** R4 is shared by every console export (KPI drill-down, block exports, Cases, conversation export), so it fixes those too.

---

## 6. Conflicts between source briefs, resolved

| Topic | Brief A | Brief B | Resolution |
|---|---|---|---|
| Overview instrument chrome | `dashboard-ux`: bordered `rounded-xl` cards with `gap-4` | `diag/overview`: flat bands, gutters, ≤1 hairline per band | **Flat bands** (ui-standard; Apple proximity). Cards would add 30+ borders back |
| Overview width | `dashboard-ux`: keep `fluid` + `3xl`/`4xl` screens, cap at 2400 | `diag/overview`: `wide`, two-column at ≥2200 | **`wide` + `4xl:2200` macro layout with a 2400 cap** (both satisfied) |
| Deeper analytics | `dashboard-ux` Option A: two separate disclosures, open | `diag/overview`: one disclosure, collapsed, persisted | **One persisted disclosure with an inline summary; flat sub-bands inside** (keeps the test anchor, no nesting) |
| KPI numeral size | 36px at `2xl` | `clamp(2.25rem, …)` | **`clamp(1.875rem, 0.9rem + 1.4vw, 2.75rem)`**: fits a 131px tile at 1280 pinned |
| Outcome helper | `case-ux` `caseOutcome` (agent/analyst/pending) | `disposition` `analystOutcome` (requires a classification entry and `decision_by` analyst) | **`caseOutcome` with the five-row precedence**, gated on the classification entry exactly as the backend ground-truth authority does |
| Remember-me checkbox when unavailable | hide | — | **Show disabled with a reason** (explicit operator ask; wayfinding) |
| Overlay radius | ui-standard "squared" (3px menus) | Apple concentric | **10px menus / 6px items**; ui-standard amended |

---

## 7. Sources

**Fetched and verified in this pass:**
- Apple HIG Materials: https://developer.apple.com/design/human-interface-guidelines/materials (JSON: developer.apple.com/tutorials/data/design/human-interface-guidelines/materials.json)
- Apple HIG Typography (macOS 13pt default, 10pt minimum; SF Pro tracking table; avoid light weights): https://developer.apple.com/design/human-interface-guidelines/typography
- Inter dynamic metrics: https://d.rsms.me/inter-website/v3/dynmetrics/
- Motion spring (`bounce`, `visualDuration`): https://motion.dev/docs/spring
- MDN browser-compat-data, media features: https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/at-rules/media.json
- MDN `afterprint`: https://developer.mozilla.org/en-US/docs/Web/API/Window/afterprint_event
- MDN `content-visibility`: https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility
- FileSaver.js (40s revoke): https://raw.githubusercontent.com/eligrey/FileSaver.js/master/src/FileSaver.js
- Palo Alto XSIAM Reports and report template docs (captured in `research/pan-rep/`, URLs in §5)

**Carried from the input briefs** (cited there in full):
- dashboard: XSIAM Command Center, Google SecOps SOAR dashboards, Sentinel Overview, Defender XDR, Splunk ES 8, Qualys, Elastic, CrowdStrike, PatternFly, Carbon, Grafana, Datadog, NN/g, Few;
- case: Cortex XSIAM/XSOAR resolve, Google SecOps close case + Gemini summary, Defender incidents/classification, Sentinel triage, Splunk dispositions + AI Analysis, Elastic cases, TheHive close;
- remember me: NIST SP 800-63B-4 (https://pages.nist.gov/800-63-4/sp800-63b.html), OWASP ASVS 5.0 V7/V3, OWASP Session Management and Authentication cheat sheets, Chromium form-styles guide, MDN `PasswordCredential`, Entra KMSI, Google Workspace/Cloud session length, Cortex security settings, LogScale session management.

**Repo evidence:**
- `webui/src/styles/theme.css`, `webui/tailwind.config.js`, `webui/src/soc/components/motion/{variants,provider,AnimatedNumber}.ts(x)`;
- `webui/src/lib/ui-recipes.ts:34-46`, `webui/src/soc/components/{PageContainer,GlassSurface}.tsx`;
- `webui/src/lib/download.ts`, `webui/src/soc/chat/report/{ReportPanel,ReportsLibrary,ExportMenu}.tsx`, `webui/src/soc/chat/report/export/{run.ts,print.tsx,markdown.ts}`;
- `webui/src/soc/chat/blocks/renderers/ReportView.tsx:82-100`, `webui/src/soc/pages/CaseManager.tsx:88-91`;
- `diag/overview.md`, `diag/disposition.md`, `diag/working.md`;
- `research/probe/*`, `diag/rep-dl/*`, and screenshots in `shots/` plus `r12/{1..5}`.
