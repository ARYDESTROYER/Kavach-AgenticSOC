#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 2: WCAG contrast checker (~zero-dep luminance math).
 *
 * Parses theme.css and asserts the semantic contrast axes clear their WCAG 2.x bar in
 * BOTH themes (DESIGN_STANDARD §6.3 / §1.2-1.4). Every axis resolves BOTH colors through
 * `resolveToken` (following `var(--slate-*)` aliases), so it measures the EFFECTIVE color
 * the browser paints — the same reason a "claimed AA" in-code comment can be wrong (§0).
 * Passing on the current W0-A palette proves G1 is real.
 *
 * Three bars, matched to WCAG + the standard's own methodology:
 *   1. STANDALONE TEXT (body + `*-text` tints) → ≥ 4.5:1 (WCAG AA normal text).
 *      Reference background = the ACTUAL `--card` in each theme. Semantic `*-text`
 *      tokens are additionally composited over their real 10% semantic wash, which
 *      is what Badge/Alert consumers paint; checking pure white missed regressions.
 *   2. ON-FILL `*-foreground` (badge/pill/button text ON a solid semantic fill) → ≥ 3:1.
 *      Badge/pill fills carry BOLD short text on a solid graphical fill — WCAG's
 *      3:1 large-text / UI-component bar governs (the primary-button axis is held to the
 *      stricter 4.5:1 since it is the main normal-weight CTA, and it clears it).
 *   3. NON-TEXT (focus ring, structural/interactive border, chart series, AND every
 *      severity/status/verdict SOLID FILL used as a graphic — badge chip, timeline node,
 *      gauge arc) → ≥ 3:1 (WCAG 1.4.11 graphical objects / UI components), measured on
 *      `--card`/`--background`. (`--medium` light was 2.97:1 → nudged to clear the bar.)
 *   4. GROUPED PANELS (Round 13, `.surface-panel`, the primary dashboard's modules). Every
 *      neutral step the recipe re-points inside a panel is measured against the PANEL, so
 *      nothing that is visible on the canvas vanishes into it:
 *      - TEXT → ≥ 4.5:1: body, secondary and link text on `--panel` and on the hovered
 *        row (`--panel-hover`); muted and secondary text on `--panel-muted` (secondary
 *        badges, chips); body text on the selected wash (`--panel-accent`); each semantic
 *        text step the panel swaps in (`--panel-<axis>-text`) on its 10% wash composited
 *        over the resting panel AND over the hovered row.
 *      - STRUCTURE → ≥ 3:1 (WCAG 1.4.11): `--panel-border-strong`, which the recipe makes
 *        the panel's `--input` and `--border-strong` (and, under increased contrast, its
 *        `--border`), against the panel and against the canvas its edge sits on.
 *      - SEPARATIONS, which keep the grouping and the in-panel states visible: the panel
 *        against the canvas (≥ 1.08:1; the 1.06:1 first draft read as no panel at all on a
 *        bright office display); muted against the panel (≥ 1.07:1, the canvas's own
 *        muted step, so a progress track or a `hover:bg-muted` patch never disappears);
 *        hover against the panel (≥ 1.10:1); and one notch (≥ 1.03:1, the canvas's own
 *        muted-to-hover step) from muted to hover and from hover to the selected wash, so
 *        the three states never collapse into one; the selected wash against the panel
 *        (≥ 1.10:1); and the KPI tiles' 30% hover wash of the selected step composited
 *        over the panel, held to what the SAME wash measures over the canvas, so a tile
 *        hover inside a panel is never weaker than it was on the canvas.
 *      A separation is not a WCAG text or UI-component bar: the panel is identified by its
 *      grouping, never by its edge, and increased contrast adds a ≥ 3:1 edge (theme.css).
 *
 * Usage:  node scripts/gate-contrast.mjs   (exit 0 = pass, 1 = fail)
 * Library: `checkContrast()` returns { ok, results[] } for the Vitest wiring.
 */
import { parseThemeCss, resolveTokenRgb, contrastRatio } from './lib/theme-css.mjs';

const AA_TEXT = 4.5;
const AA_NONTEXT = 3.0;
const AA_ONFILL = 3.0; // bold badge/pill text on a solid fill = large-text/UI-component bar
/** Standalone tint/body text tokens — measured on the actual theme card (bar 1). */
const TEXT_AXES = [
  '--foreground',
  '--card-foreground',
  '--popover-foreground',
  '--muted-foreground',
  '--secondary-foreground',
  '--critical-text',
  '--high-text',
  '--medium-text',
  '--low-text',
  '--info-text',
  '--success-text',
  '--warning-text',
  '--danger-text',
];

/** Semantic axes rendered as small text over a 10% same-axis wash. */
export const TEXT_WASH_AXES = ['critical', 'high', 'medium', 'low', 'info', 'success', 'warning'];
const TEXT_WASH_ALPHA = 0.1;

/** On-fill `<axis>-foreground` on `<axis>` fill (bar 2 = 3:1; primary held to 4.5). */
const ON_FILL_AXES = [
  { axis: 'primary', bar: AA_TEXT }, // main CTA — normal-weight; clears 4.5 both themes
  { axis: 'critical', bar: AA_ONFILL },
  { axis: 'high', bar: AA_ONFILL },
  { axis: 'medium', bar: AA_ONFILL },
  { axis: 'low', bar: AA_ONFILL },
  { axis: 'info', bar: AA_ONFILL },
  { axis: 'success', bar: AA_ONFILL },
  { axis: 'warning', bar: AA_ONFILL },
  { axis: 'accent', bar: AA_ONFILL },
];

/** Non-text graphical/UI axes on card/background (bar 3 = 3:1). */
const NON_TEXT_AXES = [
  { name: 'ring on background', fg: '--ring', bg: '--background' },
  { name: 'ring on card', fg: '--ring', bg: '--card' },
  { name: 'border-strong on card', fg: '--border-strong', bg: '--card' },
  { name: 'input on card', fg: '--input', bg: '--card' },
  { name: 'chart-1 on card', fg: '--chart-1', bg: '--card' },
  { name: 'chart-2 on card', fg: '--chart-2', bg: '--card' },
  { name: 'chart-3 on card', fg: '--chart-3', bg: '--card' },
  { name: 'chart-4 on card', fg: '--chart-4', bg: '--card' },
  { name: 'chart-5 on card', fg: '--chart-5', bg: '--card' },
  { name: 'chart-6 on card', fg: '--chart-6', bg: '--card' },
  { name: 'chart-7 on card', fg: '--chart-7', bg: '--card' },
  { name: 'chart-8 on card', fg: '--chart-8', bg: '--card' },
];

/**
 * Severity / status / verdict SOLID FILLS (the `--<axis>` base token, NOT its `-text`
 * tint) used as a NON-TEXT graphic — a badge chip, a StageTimeline node, a gauge arc,
 * a severity dot. These carry meaning through color alone as a graphical object, so
 * WCAG 1.4.11 (3:1 vs the adjacent `--card`) governs. Distinct from the on-fill bar,
 * which measures the TEXT painted on top of the fill. Every distinct base token behind
 * palette.ts SEVERITY_COLOR / STATUS_COLOR / VERDICT_COLOR: severity red→…→blue-grey,
 * status green (success), status/verdict amber (warning).
 */
export const SEMANTIC_FILL_AXES = TEXT_WASH_AXES;

/** Text measured on a grouped panel (bar 4: AA normal text), at rest and on a hovered row.
 *  `--primary` is the default brand's link colour ("Review →", "View all", a case id); a
 *  custom brand is the operator's own. */
export const PANEL_TEXT_AXES = ['--foreground', '--muted-foreground', '--secondary-foreground', '--primary'];
/** Text measured on the panel's muted step: secondary badges and the flow's count chip
 *  (muted text), and a ghost link button's hover (`hover:bg-muted`, primary text). */
export const PANEL_MUTED_TEXT_AXES = ['--muted-foreground', '--secondary-foreground', '--primary'];
/** The panel against the canvas it sits on. */
export const PANEL_SEPARATION = 1.08;
/** The panel's muted step against the panel (the canvas's own muted step is 1.07:1). */
export const PANEL_MUTED_SEPARATION = 1.07;
/** The in-panel hover (and the selected wash) against the panel. */
export const PANEL_HOVER_SEPARATION = 1.1;
/** One notch between neighbouring in-panel states: muted → hover → selected. */
export const PANEL_STEP_SEPARATION = 1.03;
/** The KPI tiles' hover wash: `hover:bg-accent/30` (KpiTile). */
export const KPI_HOVER_WASH_ALPHA = 0.3;

/** Alpha-composite a foreground wash over an opaque card (sRGB CSS compositing). */
function composite(fg, bg, alpha) {
  return fg.map((channel, i) => channel * alpha + bg[i] * (1 - alpha));
}

function push(results, theme, name, kind, bar, fg, bg) {
  if (!fg || !bg) {
    // A required contrast pair that does not resolve is itself a failure (the token
    // drifted / became a non-color) — surface it, never silently skip.
    results.push({ theme, name, kind, bar, ratio: null, pass: false });
    return;
  }
  const ratio = contrastRatio(fg, bg);
  results.push({ theme, name, kind, bar, ratio: Math.round(ratio * 100) / 100, pass: ratio >= bar });
}

/**
 * @returns {{ ok: boolean, results: {theme, name, kind, bar, ratio, pass}[] }}
 */
export function checkContrast() {
  const { light, dark } = parseThemeCss();
  const themes = [
    ['light', light],
    ['dark', dark],
  ];
  const results = [];
  for (const [theme, map] of themes) {
    const card = resolveTokenRgb('--card', map);
    // Bar 1 — standalone text on the actual theme card.
    for (const t of TEXT_AXES) {
      push(results, theme, `${t.slice(2)} (text)`, 'text', AA_TEXT, resolveTokenRgb(t, map), card);
    }
    // Bar 1 (cont.) — the real Badge/Alert wash, not an idealised white paper.
    for (const axis of TEXT_WASH_AXES) {
      const fill = resolveTokenRgb(`--${axis}`, map);
      const wash = fill && card ? composite(fill, card, TEXT_WASH_ALPHA) : null;
      push(
        results,
        theme,
        `${axis}-text on ${axis}/10 wash`,
        'text-wash',
        AA_TEXT,
        resolveTokenRgb(`--${axis}-text`, map),
        wash,
      );
    }
    // Bar 2 — on-fill `-foreground` on the fill.
    for (const { axis, bar } of ON_FILL_AXES) {
      push(
        results,
        theme,
        `${axis}-foreground on ${axis}`,
        'on-fill',
        bar,
        resolveTokenRgb(`--${axis}-foreground`, map),
        resolveTokenRgb(`--${axis}`, map),
      );
    }
    // Bar 3 — non-text graphical/UI axes.
    for (const { name, fg, bg } of NON_TEXT_AXES) {
      push(results, theme, name, 'nontext', AA_NONTEXT, resolveTokenRgb(fg, map), resolveTokenRgb(bg, map));
    }
    // Bar 3 (cont.) — semantic base fills as a graphic on the card (WCAG 1.4.11).
    for (const axis of SEMANTIC_FILL_AXES) {
      push(
        results,
        theme,
        `${axis} fill on card`,
        'nontext',
        AA_NONTEXT,
        resolveTokenRgb(`--${axis}`, map),
        resolveTokenRgb('--card', map),
      );
    }
    // Bar 4 — grouped panels (`.surface-panel`).
    const panel = resolveTokenRgb('--panel', map);
    const panelHover = resolveTokenRgb('--panel-hover', map);
    const panelMuted = resolveTokenRgb('--panel-muted', map);
    const panelAccent = resolveTokenRgb('--panel-accent', map);
    const canvas = resolveTokenRgb('--canvas', map);
    for (const t of PANEL_TEXT_AXES) {
      push(results, theme, `${t.slice(2)} on panel`, 'panel-text', AA_TEXT, resolveTokenRgb(t, map), panel);
      push(results, theme, `${t.slice(2)} on panel-hover`, 'panel-text', AA_TEXT, resolveTokenRgb(t, map), panelHover);
    }
    for (const t of PANEL_MUTED_TEXT_AXES) {
      push(results, theme, `${t.slice(2)} on panel-muted`, 'panel-text', AA_TEXT, resolveTokenRgb(t, map), panelMuted);
    }
    push(results, theme, 'foreground on panel-accent', 'panel-text', AA_TEXT, resolveTokenRgb('--foreground', map), panelAccent);
    for (const axis of TEXT_WASH_AXES) {
      const fill = resolveTokenRgb(`--${axis}`, map);
      const text = resolveTokenRgb(`--panel-${axis}-text`, map);
      for (const [surface, ground] of [
        ['panel', panel],
        ['panel-hover', panelHover],
      ]) {
        const wash = fill && ground ? composite(fill, ground, TEXT_WASH_ALPHA) : null;
        push(
          results,
          theme,
          `panel-${axis}-text on ${axis}/10 wash over ${surface}`,
          'panel-text-wash',
          AA_TEXT,
          text,
          wash,
        );
      }
    }
    // The panel's structural line: its `--input` / `--border-strong` (and increased
    // contrast's `--border`) against the panel, and its edge against the canvas.
    const structural = resolveTokenRgb('--panel-border-strong', map);
    push(results, theme, 'panel-border-strong (input) on panel', 'panel-nontext', AA_NONTEXT, structural, panel);
    push(results, theme, 'panel-border-strong (edge) on canvas', 'panel-nontext', AA_NONTEXT, structural, canvas);
    const separations = [
      ['panel vs canvas', PANEL_SEPARATION, panel, canvas],
      ['panel-muted vs panel', PANEL_MUTED_SEPARATION, panelMuted, panel],
      ['panel-hover vs panel', PANEL_HOVER_SEPARATION, panelHover, panel],
      ['panel-hover vs panel-muted', PANEL_STEP_SEPARATION, panelHover, panelMuted],
      ['panel-accent vs panel', PANEL_HOVER_SEPARATION, panelAccent, panel],
      ['panel-accent vs panel-hover', PANEL_STEP_SEPARATION, panelAccent, panelHover],
    ];
    for (const [name, bar, a, b] of separations) push(results, theme, name, 'separation', bar, a, b);
    // The KPI hover wash, never weaker inside a panel than over the canvas.
    const accent = resolveTokenRgb('--accent', map);
    const onCanvas =
      accent && canvas ? contrastRatio(composite(accent, canvas, KPI_HOVER_WASH_ALPHA), canvas) : null;
    push(
      results,
      theme,
      'panel-accent/30 over panel (KPI hover)',
      'separation',
      onCanvas == null ? Infinity : Math.floor(onCanvas * 100) / 100,
      panelAccent && panel ? composite(panelAccent, panel, KPI_HOVER_WASH_ALPHA) : null,
      panel,
    );
  }
  return { ok: results.every((r) => r.pass), results };
}

function main() {
  const { ok, results } = checkContrast();
  const failures = results.filter((r) => !r.pass);
  if (ok) {
    console.log(`✓ contrast: all ${results.length} semantic axes clear their WCAG bar in both themes.`);
    process.exit(0);
  }
  console.error(`✗ contrast: ${failures.length} axis/axes below the WCAG bar:`);
  for (const r of failures) {
    const got = r.ratio == null ? 'unresolved' : `${r.ratio}:1`;
    console.error(`   [${r.theme}] ${r.name} — need ≥${r.bar}:1 (${r.kind}), got ${got}`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
