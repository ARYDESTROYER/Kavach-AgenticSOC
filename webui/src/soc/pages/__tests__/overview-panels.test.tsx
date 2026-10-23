/**
 * Overview grouped panels (Round 13): the look the operator chose from the four preview
 * options ("Grouped surfaces"), now the page's one and only look.
 *
 * Three contracts:
 *   1. THE TOKENS AND THE RECIPE (theme.css). `--panel` and its in-panel steps exist in both
 *      themes; `.surface-panel` paints the panel with no border, no resting shadow, no
 *      blur and no motion, never redefines an operator-writable brand token, and gives the
 *      borderless surface a solid edge under increased contrast and forced colours.
 *   2. THE GATE. The contrast gate measures the panel: AA text on it and on its hovered
 *      row in both themes, the semantic text on its badge wash (resting and hovered), a
 *      ≥3:1 structural line on it, and the separations that keep the panel and its muted,
 *      hover and selected steps visible (the measured figures are recorded here, so a token
 *      change has to restate them). Increased contrast is measured INSIDE the panel too.
 *   3. THE PAGE. Every module, the KPI strip and the Deeper analytics header sit on a
 *      panel, never one inside another; band titles stay outside the panels; the modules
 *      keep their rhythm without sibling margins; the preview switch is gone, so a visit
 *      with `?separation=` in the URL simply shows the normal page.
 *
 * jsdom applies no stylesheet, so the CSS text is the contract for 1 (the design gates read
 * the same file the same way); 3 asserts the classes the page renders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  THEME_CSS_PATH,
  WEBUI_ROOT,
  contrastRatio,
  parseThemeCss,
  relLuminance,
  resolveToken,
  resolveTokenRgb,
} from '../../../../scripts/lib/theme-css.mjs';
import {
  KPI_HOVER_WASH_ALPHA,
  PANEL_HOVER_SEPARATION,
  PANEL_MUTED_SEPARATION,
  PANEL_MUTED_TEXT_AXES,
  PANEL_SEPARATION,
  PANEL_STEP_SEPARATION,
  PANEL_TEXT_AXES,
  TEXT_WASH_AXES,
  checkContrast,
} from '../../../../scripts/gate-contrast.mjs';
import { ALLOWED_TOKENS } from '../../theme-tokens';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../Metrics.posture.api', async () => ({
  ...(await vi.importActual<typeof import('../Metrics.posture.api')>('../Metrics.posture.api')),
  fetchPosture: fetchPostureMock,
}));

const { listCasesMock, getMetricsMock, usageMock, noiseMock, coverageMock, trendsMock } =
  vi.hoisted(() => ({
    listCasesMock: vi.fn(),
    getMetricsMock: vi.fn(),
    usageMock: vi.fn(),
    noiseMock: vi.fn(),
    coverageMock: vi.fn(),
    trendsMock: vi.fn(),
  }));

const { useOptionalPrefsMock, putUserMock } = vi.hoisted(() => ({
  useOptionalPrefsMock: vi.fn((): unknown => null),
  putUserMock: vi.fn(),
}));
vi.mock('@/soc/prefs', async () => ({
  ...(await vi.importActual<typeof import('@/soc/prefs')>('@/soc/prefs')),
  useOptionalPrefs: useOptionalPrefsMock,
}));

vi.mock('@/lib/api', async () => ({
  ApiError: (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).ApiError,
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
    sourcesCoverage: coverageMock,
    metricsTrends: trendsMock,
    prefs: { putUser: putUserMock },
  },
}));

vi.mock('@/soc/components/StartDemoButton', () => ({
  StartDemoButton: () => <button type="button">Start demo</button>,
}));

import Overview from '../Overview';
import type { PostureResponse } from '../Metrics.posture.api';
import type { Case, Metrics, NoiseReduction, SourceCoverage } from '@/lib/types';

const css = fs.readFileSync(THEME_CSS_PATH, 'utf8');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const PANEL_TEXT_TOKENS = TEXT_WASH_AXES.map((axis) => `--panel-${axis}-text`);

/** The grouped-panel block of theme.css: from its header comment to the print rules. */
function panelBlock(): string {
  const start = css.indexOf('/* ---- Grouped panels (Round 13; ui-standard "Dashboard bands") ---');
  const end = css.indexOf('/* ---- Printing a console page', start);
  expect(start, 'grouped panel block').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** The `{ … }` body after `header` (brace-balanced). */
function bodyAfter(source: string, header: string): string {
  const at = source.indexOf(header);
  expect(at, `missing: ${header}`).toBeGreaterThan(-1);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${header}`);
}

describe('grouped panel tokens (theme.css)', () => {
  const { light, dark } = parseThemeCss();

  it('declares the panel, its in-panel steps and its semantic text in BOTH themes', () => {
    for (const token of [
      '--panel',
      '--panel-muted',
      '--panel-hover',
      '--panel-accent',
      '--panel-border-strong',
      ...PANEL_TEXT_TOKENS,
    ]) {
      for (const [theme, map] of [['light', light], ['dark', dark]] as const) {
        expect(map.has(token), `${token} in ${theme}`).toBe(true);
        expect(resolveTokenRgb(token, map), `${token} resolves in ${theme}`).not.toBeNull();
      }
    }
  });

  it('is a step DEEPER than the canvas in light and a step LIGHTER in dark', () => {
    const lum = (token: string, map: Map<string, string>) => relLuminance(resolveTokenRgb(token, map)!);
    expect(lum('--panel', light)).toBeLessThan(lum('--canvas', light));
    expect(lum('--panel', dark)).toBeGreaterThan(lum('--canvas', dark));
  });

  it('never makes an operator-writable brand token a panel token', () => {
    for (const token of ALLOWED_TOKENS) expect(token.startsWith('--panel')).toBe(false);
  });
});

describe('the .surface-panel recipe (theme.css)', () => {
  const block = panelBlock();
  const code = stripComments(block);
  const recipe = bodyAfter(code, '.surface-panel {');

  it('paints the --panel fill with the 14px (rounded-xl) corner', () => {
    expect(recipe).toMatch(/background-color:\s*hsl\(var\(--panel\)\);/);
    expect(recipe).toContain('border-radius: calc(var(--radius) + min(var(--radius), 4px));');
    // The same step as Tailwind's `rounded-xl`, so the brand "Square" preset squares it.
    const tailwind = fs.readFileSync(path.join(WEBUI_ROOT, 'tailwind.config.js'), 'utf8');
    expect(tailwind).toContain("xl: 'calc(var(--radius) + min(var(--radius), 4px))'");
  });

  it('moves the neutral steps and the semantic text with the panel', () => {
    expect(recipe).toMatch(/--card:\s*var\(--panel\);/);
    // Tracks, `hover:bg-muted` and secondary badges: the canvas's muted step was LIGHTER
    // than the light panel (1.02:1) and all but equal to the dark one (1.01:1).
    expect(recipe).toMatch(/--muted:\s*var\(--panel-muted\);/);
    expect(recipe).toMatch(/--secondary:\s*var\(--panel-muted\);/);
    expect(recipe).toMatch(/--hover:\s*var\(--panel-hover\);/);
    expect(recipe).toMatch(/--accent:\s*var\(--panel-accent\);/);
    // The control edge: the root's 2.85:1 against the light panel was below WCAG 1.4.11.
    expect(recipe).toMatch(/--border-strong:\s*var\(--panel-border-strong\);/);
    expect(recipe).toMatch(/--input:\s*var\(--panel-border-strong\);/);
    for (const axis of TEXT_WASH_AXES) {
      expect(recipe).toMatch(new RegExp(`--${axis}-text:\\s*var\\(--panel-${axis}-text\\);`));
    }
  });

  it('has no border, no resting shadow, no blur, nothing translucent and no motion at rest', () => {
    expect(recipe).not.toMatch(/(^|[\s;])border(-width|-style|-color)?\s*:/);
    expect(code).not.toMatch(/box-shadow\s*:/);
    expect(code).not.toMatch(/backdrop-filter\s*:/);
    expect(code).not.toMatch(/\b(transition|animation)(-[a-z]+)?\s*:/);
    expect(code).not.toMatch(/(^|[\s;])opacity\s*:/);
  });

  it('never redefines an operator-writable token, so a custom brand reaches every panel', () => {
    expect(ALLOWED_TOKENS.has('--primary')).toBe(true);
    for (const token of ALLOWED_TOKENS) {
      expect(code, token).not.toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it('gives the borderless surface a solid 1px structural edge under increased contrast', () => {
    const more = bodyAfter(code, '@media (prefers-contrast: more)');
    expect(bodyAfter(more, '.surface-panel {')).toMatch(/border:\s*1px solid hsl\(var\(--border-strong\)\);/);
    // The global increased-contrast block stays the FIRST one in the file: the measured
    // foundations spec reads the first `prefers-contrast: more` block as the theme override.
    expect(css.indexOf('@media (prefers-contrast: more)')).toBeLessThan(css.indexOf(block));
    // A custom property inherits its RESOLVED value, so the global block's
    // `--border: var(--border-strong)` reached the panel as the ROOT's step: the panel
    // re-points it at its own.
    expect(bodyAfter(more, '.surface-panel {')).toMatch(/--border:\s*var\(--panel-border-strong\);/);
  });

  it('keeps a system-colour edge and plain strip rules under forced colours', () => {
    const forced = bodyAfter(code, '@media (forced-colors: active)');
    const rule = bodyAfter(forced, '.surface-panel {');
    expect(rule).toMatch(/border:\s*1px solid CanvasText;/);
    expect(rule).toMatch(/--panel-inset-rule:\s*none;/);
  });

  it('is exposed through Tailwind as the `panel` colour', () => {
    const tailwind = fs.readFileSync(path.join(WEBUI_ROOT, 'tailwind.config.js'), 'utf8');
    expect(tailwind).toContain("panel: 'hsl(var(--panel) / <alpha-value>)'");
  });

  it('leaves nothing of the preview switch behind', () => {
    expect(css).not.toMatch(/data-ov|ov-sep|--ov-/);
    const overview = fs.readFileSync(path.join(WEBUI_ROOT, 'src/soc/pages/Overview.tsx'), 'utf8');
    expect(overview).not.toMatch(/data-ov|separation|readSeparationPreview/i);
    expect(fs.existsSync(path.join(WEBUI_ROOT, 'src/soc/pages/overview-separation.ts'))).toBe(false);
  });
});

/** Every custom property declared directly in a rule body (comments stripped). */
function declsIn(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const flat = stripComments(body);
  for (const m of flat.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    map.set(m[1], m[2].replace(/\s*!important\s*$/, '').trim());
  }
  return map;
}

describe('increased contrast INSIDE a panel (measured)', () => {
  const { light, dark } = parseThemeCss();
  // The global block (the FIRST `prefers-contrast: more` rule) and the panel's own.
  const globalMore = bodyAfter(css, '@media (prefers-contrast: more)');
  const code = stripComments(panelBlock());
  const recipe = declsIn(bodyAfter(code, '.surface-panel {'));
  const panelMore = declsIn(bodyAfter(bodyAfter(code, '@media (prefers-contrast: more)'), '.surface-panel {'));
  /**
   * What an element inside a panel resolves under `prefers-contrast: more`. Two scopes, as
   * the browser computes them: a custom property's `var()` resolves on the element that
   * DECLARES it, and descendants inherit the result. So the root scope (the theme plus the
   * global block) is resolved first, then the panel's own declarations on top of it.
   */
  const inPanel = (base: Map<string, string>, rootSelector: string) => {
    const root = new Map<string, string>([...base, ...declsIn(bodyAfter(globalMore, `${rootSelector} {`))]);
    const resolvedRoot = new Map<string, string>(
      [...root.keys()].map((name) => [name, resolveToken(name, root) ?? root.get(name)!]),
    );
    return new Map<string, string>([...resolvedRoot, ...recipe, ...panelMore]);
  };
  const themes = { light: inPanel(light, ':root'), dark: inPanel(dark, '.dark') };
  /** Source-over compositing of `fg` at `alpha` onto an opaque `bg`. */
  const over = (fg: number[], alpha: number, bg: number[]) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

  it.each(Object.entries(themes))(
    '%s: every rule, divider, control edge and the panel edge is a ≥3:1 line against the panel',
    (_name, map) => {
      const panel = resolveTokenRgb('--panel', map)!;
      expect(resolveTokenRgb('--card', map)).toEqual(panel);
      const floor = Number(map.get('--border-alpha-floor') ?? 0);
      expect(floor).toBe(1);
      const border = resolveTokenRgb('--border', map)!;
      // `border-border/70`, `/60`, … and the strip's inset rule (`max(0.7, floor)`).
      for (const alpha of [0.4, 0.6, 0.7, 0.8]) {
        const painted = over(border, Math.max(alpha, floor), panel);
        expect(contrastRatio(painted as [number, number, number], panel), `--border/${alpha * 100}`).toBeGreaterThanOrEqual(3);
      }
      for (const token of ['--border-strong', '--input']) {
        expect(contrastRatio(resolveTokenRgb(token, map)!, panel), token).toBeGreaterThanOrEqual(3);
      }
      // The panel's own edge, against the canvas it sits on.
      expect(contrastRatio(resolveTokenRgb('--border-strong', map)!, resolveTokenRgb('--canvas', map)!)).toBeGreaterThanOrEqual(3);
    },
  );

  it('records the light figures, and that the root step alone fell short on the panel', () => {
    const map = themes.light;
    const panel = resolveTokenRgb('--panel', map)!;
    const round = (n: number) => Math.round(n * 100) / 100;
    expect(round(contrastRatio(resolveTokenRgb('--border', map)!, panel))).toBe(3.17);
    expect(round(contrastRatio(resolveTokenRgb('--border-strong', map)!, resolveTokenRgb('--canvas', map)!))).toBe(3.46);
    // The finding this pins: the root's structural step measured 2.85:1 on the panel.
    expect(round(contrastRatio(resolveTokenRgb('--border-strong', light)!, panel))).toBe(2.85);
  });
});

describe('the contrast gate measures the panel', () => {
  const { ok, results } = checkContrast();
  const pick = (theme: string, name: string) => results.find((r) => r.theme === theme && r.name === name);

  it('covers text, badge washes, the structural line and separations in both themes, all passing', () => {
    expect(ok).toBe(true);
    const of = (kind: string) => results.filter((r) => r.kind === kind);
    // Text on the panel and its hovered row, muted text on the muted step, body text on
    // the selected wash.
    expect(of('panel-text')).toHaveLength((PANEL_TEXT_AXES.length * 2 + PANEL_MUTED_TEXT_AXES.length + 1) * 2);
    // Every semantic text step on its wash over the resting panel AND the hovered row.
    expect(of('panel-text-wash')).toHaveLength(TEXT_WASH_AXES.length * 2 * 2);
    expect(of('panel-nontext')).toHaveLength(2 * 2);
    expect(of('separation')).toHaveLength(7 * 2);
    for (const r of [...of('panel-text'), ...of('panel-text-wash'), ...of('panel-nontext'), ...of('separation')]) {
      expect(r.pass, `${r.theme} ${r.name} ${r.ratio}`).toBe(true);
    }
    for (const theme of ['light', 'dark']) {
      for (const axis of TEXT_WASH_AXES) {
        expect(pick(theme, `panel-${axis}-text on ${axis}/10 wash over panel-hover`), `${theme} ${axis}`).toBeDefined();
      }
    }
  });

  it('records the measured figures: AA text on the panel and its separation from the canvas', () => {
    // Body and muted text on the panel, both themes (WCAG AA, 4.5:1).
    expect(pick('light', 'foreground on panel')?.ratio).toBe(15.58);
    expect(pick('light', 'muted-foreground on panel')?.ratio).toBe(5.34);
    expect(pick('dark', 'foreground on panel')?.ratio).toBe(13.89);
    expect(pick('dark', 'muted-foreground on panel')?.ratio).toBe(6.45);
    // …and on a hovered row (the worst: muted text and the link colour in light).
    expect(pick('light', 'muted-foreground on panel-hover')?.ratio).toBe(4.7);
    expect(pick('light', 'primary on panel-hover')?.ratio).toBe(4.6);
    // The semantic badge text on its wash over the panel, and over a HOVERED row, where
    // the first draft's light steps measured 4.17 to 4.49:1 and dark critical 4.00:1.
    expect(pick('light', 'panel-critical-text on critical/10 wash over panel')?.ratio).toBe(5.27);
    expect(pick('light', 'panel-high-text on high/10 wash over panel-hover')?.ratio).toBe(4.65);
    expect(pick('light', 'panel-low-text on low/10 wash over panel-hover')?.ratio).toBe(4.6);
    expect(pick('dark', 'panel-critical-text on critical/10 wash over panel')?.ratio).toBe(5.26);
    expect(pick('dark', 'panel-critical-text on critical/10 wash over panel-hover')?.ratio).toBe(4.56);
    // The panel against the canvas (not a WCAG bar: the grouping, not an edge, identifies it).
    expect(pick('light', 'panel vs canvas')?.ratio).toBe(1.09);
    expect(pick('dark', 'panel vs canvas')?.ratio).toBe(1.12);
    expect(pick('light', 'panel vs canvas')?.bar).toBe(PANEL_SEPARATION);
    // Hover inside a panel stays as visible as on the canvas.
    expect(pick('light', 'panel-hover vs panel')?.ratio).toBe(1.14);
    expect(pick('dark', 'panel-hover vs panel')?.ratio).toBe(1.15);
    expect(pick('dark', 'panel-hover vs panel')?.bar).toBe(PANEL_HOVER_SEPARATION);
  });

  it('keeps the muted, hover and selected steps apart, in the canvas order', () => {
    // Muted (tracks, `hover:bg-muted`, secondary badges) against the panel: at least the
    // canvas's own muted step (1.07:1). The first draft measured 1.02:1 and 1.01:1.
    expect(pick('light', 'panel-muted vs panel')?.ratio).toBe(1.08);
    expect(pick('dark', 'panel-muted vs panel')?.ratio).toBe(1.11);
    expect(pick('dark', 'panel-muted vs panel')?.bar).toBe(PANEL_MUTED_SEPARATION);
    expect(pick('light', 'muted-foreground on panel-muted')?.ratio).toBe(4.94);
    expect(pick('dark', 'muted-foreground on panel-muted')?.ratio).toBe(5.82);
    // One notch from muted to hover and from hover to the selected wash: in dark the
    // first draft's selected wash WAS the hover (1.00:1).
    expect(pick('light', 'panel-hover vs panel-muted')?.ratio).toBe(1.05);
    expect(pick('dark', 'panel-hover vs panel-muted')?.ratio).toBe(1.04);
    expect(pick('light', 'panel-accent vs panel-hover')?.ratio).toBe(1.11);
    expect(pick('dark', 'panel-accent vs panel-hover')?.ratio).toBe(1.09);
    expect(pick('dark', 'panel-accent vs panel-hover')?.bar).toBe(PANEL_STEP_SEPARATION);
    expect(pick('dark', 'panel-accent vs panel')?.ratio).toBe(1.25);
    expect(pick('dark', 'foreground on panel-accent')?.ratio).toBe(11.13);
  });

  it('holds the KPI hover wash inside a panel to what it measures over the canvas', () => {
    expect(KPI_HOVER_WASH_ALPHA).toBe(0.3);
    // KpiTile's own hover class is the wash this measures.
    const kpiTile = fs.readFileSync(path.join(WEBUI_ROOT, 'src/soc/components/KpiTile.tsx'), 'utf8');
    expect(kpiTile).toContain('hover:bg-accent/30');
    const light = pick('light', 'panel-accent/30 over panel (KPI hover)');
    const dark = pick('dark', 'panel-accent/30 over panel (KPI hover)');
    // Bars: the same 30% wash over the canvas (1.065:1 light, 1.054:1 dark).
    expect([light?.bar, light?.ratio]).toEqual([1.06, 1.07]);
    // Dark was 1.04:1, weaker than its 1.05:1 on the canvas.
    expect([dark?.bar, dark?.ratio]).toEqual([1.05, 1.06]);
  });

  it('measures the panel\'s structural line against the panel and the canvas', () => {
    expect(pick('light', 'panel-border-strong (input) on panel')?.ratio).toBe(3.17);
    expect(pick('light', 'panel-border-strong (edge) on canvas')?.ratio).toBe(3.46);
    expect(pick('dark', 'panel-border-strong (input) on panel')?.ratio).toBe(4.05);
    expect(pick('dark', 'panel-border-strong (edge) on canvas')?.ratio).toBe(4.54);
    for (const r of results.filter((x) => x.kind === 'panel-nontext')) expect(r.bar).toBe(3);
  });
});

// ---- The page --------------------------------------------------------------------------

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const CASES: Case[] = [
  {
    case_id: 'c-open', case_number: 'CASE-1001', status: 'open', risk_score: 88,
    severity_band: 'critical', title: 'Impossible travel', detection_source: 'rule',
    created_at: iso(30), updated_at: iso(5), entity: { type: 'ip', value: '10.0.0.1' },
  },
  {
    case_id: 'c-closed', case_number: 'CASE-1002', status: 'closed', risk_score: 20,
    severity_band: 'low', title: 'Benign admin login', detection_source: 'anomaly',
    verdict: 'FALSE_POSITIVE', decision_by: 'agent',
    created_at: iso(50), updated_at: iso(15), entity: { type: 'user', value: 'alice' },
  },
] as unknown as Case[];

const METRICS = {
  total_cases: 2, open_cases: 1, needs_human_cases: 0, closed_cases: 1,
  by_status: { open: 1, closed: 1 },
  by_verdict: { TRUE_POSITIVE: 0, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 54,
  mttr_minutes: 120, resolved_count: 1,
  cases_per_day: [{ date: '2026-06-30', count: 2 }],
  burndown: [], timing_trend: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const block = (p50: number) => ({ p50, p90: p50 * 2, mean: p50, max: p50 * 3, count: 2, available: true, reason: '' });
const POSTURE = {
  window_hours: 24, generated_at: new Date(NOW).toISOString(), case_count: 2,
  severity_counts: { critical: 1, high: 0, medium: 0, low: 1, info: 0 },
  open_now: { count: 3, window_exempt: true, as_of: new Date(NOW).toISOString(), complete: true, reason: '' },
  window_covered: true, window_coverage_reason: '',
  lifecycle: {
    mtta_minutes: block(45), mttr_minutes: block(180), dwell_minutes: block(30), mttd_minutes: block(9),
  },
  quality: {
    total_cases: 2, verdicted_cases: 1, true_positive_cases: 0, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    human_closed_cases: 0, system_closed_cases: 0, policy_closed_cases: 0,
    alert_to_incident_ratio: 0.5, false_positive_rate: 0.5, escalation_rate: 0,
    containment_rate: 1, automation_rate: 1,
  },
  aging: { queue_depth: 1, age_buckets: [], oldest: [], arrivals: 2, closures: 1, closure_vs_arrival: 0.5, backlog: 1 },
  sla: { enabled: false },
} as unknown as PostureResponse;

const NOISE: NoiseReduction = {
  window_hours: 24,
  generated_at: new Date(NOW).toISOString(),
  bands: ['critical', 'high', 'medium', 'low', 'info'],
  stages: [
    { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 100, by_severity: {} },
    { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 40, by_severity: {} },
    { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 2, by_severity: {} },
    { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 1, by_severity: {} },
    { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 1, by_severity: {} },
  ],
  drops: { suppressed: 0, ignored: 0 },
  reduction: { overall_pct: 98, human_reduction_pct: 50 },
  counters: { available: true, since: '2026-06-30T08:00:00Z', incomplete: false },
  cases_meta: { truncated: false, store_total: 2, fetched: 2 },
};

const COVERAGE = {
  generated_at: new Date(NOW).toISOString(),
  sources_total: 2, sources_enabled: 2, sources_silent: 0,
  events_per_min: 12, alerts_triaged_24h: 4, worst_last_event_seconds: 60,
  silent_after_seconds: 900, sources: [],
} as unknown as SourceCoverage;

function mountMocks() {
  fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
  listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length, window_total_exact: true });
  getMetricsMock.mockReset().mockResolvedValue(METRICS);
  usageMock.mockReset().mockResolvedValue({ total_cost: 0.5, total_tokens: 1000, call_count: 3, currency: 'USD', cost_over_time: [] });
  noiseMock.mockReset().mockResolvedValue(NOISE);
  coverageMock.mockReset().mockResolvedValue(COVERAGE);
  trendsMock.mockReset().mockResolvedValue({ window_hours: 24, bucket_minutes: 60, buckets: [], truncated: false });
  putUserMock.mockReset().mockResolvedValue({});
  useOptionalPrefsMock.mockReset().mockReturnValue(null);
}

async function mount() {
  const view = render(<Overview onNavigate={vi.fn()} />);
  await screen.findByTestId('page-hero');
  await waitFor(() => expect(screen.getByTestId('noise-funnel')).toBeInTheDocument());
  await waitFor(() => expect(within(screen.getByTestId('kpi-total-cases')).getByText('2')).toBeInTheDocument());
  return view;
}

const PANEL_PAD = ['p-4', 'xl:p-5', '3xl:p-6'];
const PANEL_GAP = ['gap-4', 'xl:gap-5', '3xl:gap-6'];
/** The panel a node sits on, or null. */
const panelOf = (node: Element | null) => node?.closest('.surface-panel') ?? null;
/** No resting shadow, no blur, no motion on a panel element itself. */
const RESTLESS = /(^|\s)(shadow(-\S+)?|drop-shadow(-\S+)?|backdrop-\S+|transition(-\S+)?|duration-\S+|animate-\S+|hover-lift|opacity-\S+)(\s|$)/;

describe('the Overview renders on grouped panels', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    sessionStorage.clear();
    mountMocks();
  });

  it('puts the KPI strip on one panel, with inner rules only and inset column rules from xl', async () => {
    await mount();
    const strip = screen.getByTestId('kpi-strip');
    expect(strip).toHaveClass('surface-panel', 'overflow-hidden');
    // The panel replaces the strip's outer rules.
    expect(strip).not.toHaveClass('border-y');
    for (const item of Array.from(strip.children)) {
      expect(item.className).toContain('xl:[border-image:var(--panel-inset-rule)_0_1_0_0]');
      expect(item).toHaveClass('border-border/70');
    }
  });

  it('starts the first tile of each strip row at the panel padding, so labels share the titles\' edge', async () => {
    await mount();
    const cellOf = (id: string) => screen.getByTestId(id).parentElement!;
    const tiles = ['kpi-total-cases', 'kpi-total-critical', 'kpi-open-cases', 'kpi-false-positive-rate', 'kpi-resolved-closed', 'kpi-auto-closed'];
    const present = tiles.filter((id) => screen.queryByTestId(id));
    expect(present).toHaveLength(6);
    const first = cellOf(present[0]).className;
    expect(first).toContain('max-sm:[&>button[data-testid]]:pl-4');
    expect(first).toContain('sm:max-md:[&>button[data-testid]]:pl-4');
    expect(first).toContain('md:max-xl:[&>button[data-testid]]:pl-4');
    expect(first).toContain('xl:[&>button[data-testid]]:pl-5');
    expect(first).toContain('3xl:[&>button[data-testid]]:pl-6');
    // Row starts at two columns (odd tiles) and three columns (tiles 1 and 4) only.
    expect(cellOf(present[2]).className).toContain('sm:max-md:[&>button[data-testid]]:pl-4');
    expect(cellOf(present[3]).className).toContain('md:max-xl:[&>button[data-testid]]:pl-4');
    expect(cellOf(present[1]).className).not.toContain('sm:max-md:[&>button[data-testid]]:pl-4');
    expect(cellOf(present[1]).className).not.toContain('md:max-xl:[&>button[data-testid]]:pl-4');
    for (const id of present.slice(1)) expect(cellOf(id).className).not.toContain('xl:[&>button[data-testid]]:pl-5');
    // The tile's own trigger inset is untouched.
    expect(cellOf(present[1])).toHaveClass('xl:max-2xl:[&>button]:px-3');
  });

  it('gives every module of both bands its own padded panel, with panel-sized gutters', async () => {
    await mount();
    const modules = [
      panelOf(screen.getByTestId('noise-funnel')),
      panelOf(screen.getByTestId('human-vs-ai')),
      screen.getByRole('region', { name: 'Resolved and open cases' }),
      screen.getByRole('region', { name: 'Mean time to detect / respond' }),
      panelOf(screen.getByRole('region', { name: 'Latest cases' })),
    ];
    for (const module of modules) {
      expect(module).not.toBeNull();
      expect(module).toHaveClass('surface-panel', ...PANEL_PAD);
      expect(module!.className).not.toMatch(RESTLESS);
    }
    // Both snapshots share ONE panel; the queue's panel is its own.
    const snaps = screen.getAllByTestId('snapshot-card');
    expect(snaps).toHaveLength(2);
    expect(panelOf(snaps[0])).toBe(panelOf(snaps[1]));
    // The gutters between panels match the panel padding.
    const flowGrid = screen.getByRole('region', { name: 'Alert flow' }).querySelector(':scope > div')!;
    expect(flowGrid).toHaveClass(...PANEL_GAP);
    expect(screen.getByTestId('cases-band-grid')).toHaveClass(...PANEL_GAP);
    expect(screen.getByTestId('cases-band-grid')).not.toHaveClass('gap-x-6');
  });

  it('keeps band titles outside the panels, on the canvas, and module titles inside', async () => {
    await mount();
    for (const name of ['Alert flow', 'Cases and response']) {
      expect(panelOf(screen.getByRole('heading', { name }))).toBeNull();
    }
    for (const name of ['Human vs AI', 'Open cases', 'Cases resolved', 'Response time', 'Latest cases']) {
      expect(panelOf(screen.getByRole('heading', { name })), name).not.toBeNull();
    }
    // The page title and its dashbar are not a panel either.
    expect(panelOf(screen.getByTestId('page-hero'))).toBeNull();
  });

  it('draws one thin divider between Open cases and Cases resolved, from the second snapshot', async () => {
    await mount();
    const [open, resolved] = screen.getAllByTestId('snapshot-card');
    expect(open.className).not.toContain('before:');
    for (const cls of [
      'relative', 'before:absolute', 'before:-top-3', 'before:border-t', 'before:border-border/70',
      '@[35rem]:before:border-l', '@[35rem]:before:border-t-0', '@[35rem]:before:-left-3',
      'xl:@[35rem]:before:-left-4',
    ]) {
      expect(resolved, cls).toHaveClass(cls);
    }
  });

  it('lines the Human vs AI title up with the flow title (a 24px centred title row)', async () => {
    await mount();
    expect(screen.getByRole('heading', { name: 'Human vs AI' }).parentElement).toHaveClass(
      'flex', 'min-h-6', 'items-center',
    );
  });

  it('puts the Deeper analytics header on a panel and, open, the timing strip and every instrument', async () => {
    const user = userEvent.setup();
    await mount();
    const deeper = screen.getByRole('region', { name: 'Deeper analytics' });
    // No top rule any more: the header panel separates the fold.
    expect(deeper).not.toHaveClass('border-t');
    const trigger = within(deeper).getByRole('button', { name: /Deeper analytics/ });
    expect(trigger).toHaveClass('surface-panel', 'px-4', 'py-3', 'xl:px-5', '3xl:px-6', 'hover:bg-hover');
    expect(trigger.className).not.toMatch(RESTLESS);
    await user.click(trigger);
    const region = await waitFor(() => {
      const el = document.getElementById('overview-deeper-region');
      expect(el).not.toBeNull();
      return el!;
    });
    const timing = await within(region).findByTestId('deeper-timing-strip');
    expect(timing.closest('[data-kpi-grid-count]')).toHaveClass('surface-panel', 'overflow-hidden');
    const instruments = region.querySelectorAll('section[data-scope]');
    expect(instruments.length).toBeGreaterThanOrEqual(6);
    for (const section of Array.from(instruments)) {
      expect(section).toHaveClass('surface-panel', ...PANEL_PAD);
    }
    // Sub-band titles stay on the canvas.
    for (const name of ['Efficiency and cost', /What.s driving volume/]) {
      expect(panelOf(within(region).getByRole('heading', { name }))).toBeNull();
    }
  });

  it('keeps the dashbar clear at rest and on the Console material once content scrolls', async () => {
    await mount();
    const hero = screen.getByTestId('page-hero');
    expect(hero.className).toContain('material-surface');
    expect(hero.className).toContain('[&:not([data-scrolled=true])]:bg-transparent');
  });

  it('spaces the modules as one group: 40px strip to bands to Deeper analytics, no sibling margins', async () => {
    const { container } = await mount();
    const group = screen.getByTestId('overview-modules');
    expect(group).toHaveClass('space-y-10');
    // The strip, the bands and the fold are the group's children, in that order.
    const children = Array.from(group.children);
    expect(children[0]).toContainElement(screen.getByTestId('kpi-strip'));
    expect(children[1]).toBe(screen.getByTestId('hero-row'));
    expect(children[2]).toBe(screen.getByRole('region', { name: 'Deeper analytics' }));
    // Between the two bands: 40px, 48px from 1920px.
    expect(screen.getByTestId('hero-row')).toHaveClass('space-y-10', '3xl:space-y-12');
    // Nothing overrides a sibling margin with `!important` (ui-standard "Spacing").
    expect(container.querySelector('[class*="!mt-"], [class*="!mb-"], [class*="!my-"]')).toBeNull();
    const source = fs.readFileSync(path.join(WEBUI_ROOT, 'src/soc/pages/Overview.tsx'), 'utf8');
    expect(source).not.toMatch(/!m[tby]-\d/);
  });

  it('spreads Response time\'s spare height between detect and respond', async () => {
    await mount();
    const response = screen.getByRole('region', { name: 'Mean time to detect / respond' });
    expect(response).toHaveClass('flex', 'flex-col');
    const pair = response.querySelector(':scope > .grid');
    expect(pair).not.toBeNull();
    expect(pair).toHaveClass('flex-auto', 'content-between');
  });

  it('tightens the snapshot gaps below 1280px so each legend stays beside its ring', async () => {
    await mount();
    const region = screen.getByRole('region', { name: 'Resolved and open cases' });
    expect(region.querySelector(':scope > .grid')).toHaveClass('gap-x-6', 'xl:gap-x-8');
    for (const card of screen.getAllByTestId('snapshot-card')) {
      expect(within(card).getByTestId('snapshot-body')).toHaveClass('gap-x-3', 'xl:gap-x-4');
      const row = within(card).getByTestId('snapshot-body').parentElement!;
      expect(row).toHaveClass('gap-2', 'xl:gap-4');
      expect(row).not.toHaveClass('gap-4');
    }
  });

  it('never nests a panel in a panel, with Deeper analytics open too', async () => {
    const user = userEvent.setup();
    const { container } = await mount();
    expect(container.querySelectorAll('.surface-panel .surface-panel')).toHaveLength(0);
    await user.click(
      within(screen.getByRole('region', { name: 'Deeper analytics' })).getByRole('button', { name: /Deeper analytics/ }),
    );
    await within(document.getElementById('overview-deeper-region')!).findByTestId('deeper-timing-strip');
    expect(container.querySelectorAll('.surface-panel').length).toBeGreaterThanOrEqual(12);
    expect(container.querySelectorAll('.surface-panel .surface-panel')).toHaveLength(0);
  });

  it('starts each timing-strip row at the panel padding too, by the strip\'s own columns', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(
      within(screen.getByRole('region', { name: 'Deeper analytics' })).getByRole('button', { name: /Deeper analytics/ }),
    );
    const timing = await within(document.getElementById('overview-deeper-region')!).findByTestId('deeper-timing-strip');
    // One tile per grid cell: the cell itself or the hover-trend wrapper around it.
    const tiles = Array.from(timing.children).map(
      (cell) => (cell.matches('[data-testid^="kpi-"]') ? cell : cell.querySelector('[data-testid^="kpi-"]'))!,
    );
    expect(tiles).toHaveLength(4);
    expect(tiles[3]).toHaveAttribute('data-testid', 'kpi-llm-spend-detail');
    // The strip is 1 / 2 / 4 columns at <20rem / <40rem / ≥40rem of its own width.
    expect(timing.className).toContain('@[20rem]:grid-cols-2');
    expect(timing.className).toContain('@[40rem]:grid-cols-4');
    // The first tile always starts at the panel padding (16 / 20 / 24px)…
    expect(tiles[0]).toHaveClass('pl-4', 'xl:pl-5', '3xl:pl-6');
    // …the third while the strip is two-up (and from 1920px, the 38rem column)…
    expect(tiles[2]).toHaveClass('pl-4', '@[40rem]:pl-3', '3xl:[@container(max-width:39.98rem)]:pl-6');
    // …the second and fourth only in one column; otherwise each keeps its own inset.
    for (const tile of [tiles[1], tiles[3]]) {
      expect(tile).toHaveClass('pl-4', '@[20rem]:pl-3');
      expect(tile).not.toHaveClass('xl:pl-5');
    }
    // The tiles' own inset is still there underneath (12 / 16 / 20px).
    for (const tile of tiles) expect(tile).toHaveClass('px-3', 'xl:px-4', '2xl:px-5');
  });

  it('draws the LLM spend focus ring inside the tile, where the strip and panel cannot clip it', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(
      within(screen.getByRole('region', { name: 'Deeper analytics' })).getByRole('button', { name: /Deeper analytics/ }),
    );
    const tile = await within(document.getElementById('overview-deeper-region')!).findByTestId('kpi-llm-spend-detail');
    expect(tile.tagName).toBe('BUTTON');
    expect(tile).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    expect(tile).not.toHaveClass('focus-visible:ring-offset-2');
    // The hover-trend wrapper is the stop when the tile is not a button: inset as well.
    expect(tile.closest('[data-testid="metric-trend-trigger"]')).toHaveClass('focus-visible:ring-inset');
  });

  it('lays the Case outcomes ring and legend out by the panel\'s width, not the viewport\'s', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(
      within(screen.getByRole('region', { name: 'Deeper analytics' })).getByRole('button', { name: /Deeper analytics/ }),
    );
    const outcomes = await within(document.getElementById('overview-deeper-region')!).findByRole('region', {
      name: 'Case outcomes',
    });
    const ring = within(outcomes).getByRole('img', { name: 'Case outcomes by AI verdict' });
    const body = ring.closest('.flex')!;
    // Side by side only from a 24rem panel body (ring 160px + 20px gap + a ~200px legend);
    // two-up at 768px the body is 288px, so the legend goes under the ring there.
    expect(body).toHaveClass('flex-col', '@[24rem]:flex-row');
    expect(body.className).not.toMatch(/(^|\s)(sm|md|lg|xl):flex-row/);
    expect(body.parentElement).toHaveClass('@container');
    expect(panelOf(body)).toBe(outcomes);
  });

  it('lifts a hovered flow chip with the hover step, which the panel deepens', () => {
    const funnel = fs.readFileSync(path.join(WEBUI_ROOT, 'src/soc/components/NoiseFunnel.tsx'), 'utf8');
    // `--popover` equals the card in light and the grouped panel in dark (1.01:1).
    expect(funnel).not.toContain('hover:bg-popover');
  });

  it('keeps a forced-colours backplate under the KPI label: the fluid numerals get an inset', () => {
    const forced = Array.from(stripComments(css).matchAll(/@media \(forced-colors: active\) \{/g)).map((m) =>
      bodyAfter(stripComments(css).slice(m.index!), '@media (forced-colors: active)'),
    );
    const rule = forced.find((body) => body.includes('.kpi-numeral-fluid'));
    expect(rule, 'a forced-colours rule for the fluid numerals').toBeDefined();
    for (const rung of ['.kpi-numeral-fluid,', '.kpi-numeral-fluid-md,', '.kpi-numeral-fluid-sm {']) {
      expect(rule).toContain(rung);
    }
    expect(rule).toMatch(/padding-top:\s*0\.125em;/);
  });

  it('shows the normal page for a visit with ?separation= in the URL, and stores nothing', async () => {
    const before = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(null, '', '/?separation=hairlines#/overview?separation=titled');
    try {
      const { container } = await mount();
      expect(container.querySelector('[data-ov-sep], [data-ov], [data-ov-cell], [data-ov-grid]')).toBeNull();
      expect(screen.getByTestId('kpi-strip')).toHaveClass('surface-panel');
      expect(container.querySelectorAll('.surface-panel').length).toBeGreaterThanOrEqual(6);
      expect(sessionStorage.getItem('soc.overview.separationPreview')).toBeNull();
    } finally {
      window.history.replaceState(null, '', before);
    }
  });
});
