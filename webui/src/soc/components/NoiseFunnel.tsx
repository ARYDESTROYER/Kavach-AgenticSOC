/**
 * NoiseFunnel — the selected-window Noise Reduction instrument in the Security
 * Command Center.
 *
 * Simple draws a full, filled alert-to-case flow. Alerts, clusters, and cases remain
 * different units, so those first two ribbons use a disclosed compressed display scale;
 * exact counts stay in their labels. From opened cases onward, the case-unit ribbons
 * conserve the backend outcome partitions:
 *
 *     alerts → clusters → cases ⇉ auto-cleared | escalated ⇉ human-closed | remainder
 *
 * Simple is the default direct-labelled graph. Detailed intentionally restores the
 * Testing renderer as a separate compatibility presentation: its 640x220 stretched
 * canvas, processing spine, overlapping outcome fan, loss badges, and complete evidence
 * rail remain unchanged. Open cases are shown as separate selected-window lifecycle
 * context because they are not equal to the conserved escalated remainder.
 *
 * Binds VERBATIM to the §D `GET /api/metrics/noise-reduction` contract (the
 * `NoiseReduction` type). When the durable ingest counters are still warming up
 * (`counters.available === false`) it degrades gracefully to a case-only funnel.
 *
 * #9: every value shown is an aggregate count or a fixed stage label (no raw log
 * text), rendered as plain text — UNTRUSTED-safe by construction. Colours resolve
 * from approved theme/semantic tokens only (no raw hex; design gate). The SVG is
 * decorative; graph labels or the Detailed evidence rail carry the accessible values.
 * Refresh feedback is one-shot, data-keyed, and absent under reduced motion.
 */
import * as React from 'react';
import { Eye, EyeOff, Maximize2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { api } from '@/lib/api';
import type {
  NoiseLineage,
  NoiseReduction,
  NoiseSeverityBreakdown,
  NoiseStage,
} from '@/lib/types';
import { LoadingState as ConsoleLoadingState } from '@/design-system';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { token, SEVERITY_COLOR, VERDICT_COLOR } from './palette';
import { CountUp } from './CountUp';
import { HelpTip } from './HelpTip';
import { NoiseLineageView } from './NoiseLineage';
import { SegmentedControl } from './SegmentedControl';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';

/* ------------------------------------------------------------------------- */
/* Severity + outcome → token-name maps (routed through the palette authority  */
/* so the flow re-themes with the rest of the UI — no raw hex; design gate).   */
/* ------------------------------------------------------------------------- */
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SevBand = (typeof SEV_ORDER)[number];

/** Severity evidence colour used by each stage's hover breakdown. */
const BAND_TOKEN: Record<SevBand, string> = {
  critical: SEVERITY_COLOR.critical,
  high: SEVERITY_COLOR.high,
  medium: SEVERITY_COLOR.medium,
  low: SEVERITY_COLOR.low,
  info: SEVERITY_COLOR.info,
};

const SEV_LABEL: Record<SevBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/**
 * Outcome ribbon colour (cases → the terminal outcomes) — the VERDICT/STATUS semantic
 * axis: severity describes the INPUT, the outcome describes the OUTPUT. `closed` (human-
 * resolved) reads on the resolved/success token, the calm end of the flow.
 */
const OUTCOME_TOKEN: Record<string, string> = {
  auto_cleared: VERDICT_COLOR.false_positive, // blue-grey (a cleared false positive)
  escalated: VERDICT_COLOR.suspicious, // amber-orange
  closed: 'success', // green — a human drove it to a terminal state
  // An operator's rule-level declaration closed it deterministically, with no model
  // call and no human case work. Its own colour so it never reads as either.
  policy_closed: VERDICT_COLOR.false_positive,
  needs_human: VERDICT_COLOR.needs_human, // warning (back-compat; no longer a spine chip)
  true_positive: VERDICT_COLOR.true_positive, // critical-red (back-compat)
};

/** Fallback labels for the canonical funnel stages (the backend supplies `label`). */
const STAGE_LABEL: Record<string, string> = {
  ingested: 'Ingested',
  clustered: 'Clustered',
  // Below-floor candidates: risk-scored but NOT yet promoted to an LLM investigation.
  candidate: 'Awaiting review',
  awaiting: 'Awaiting review',
  cases: 'Cases opened',
  auto_cleared: 'Auto-cleared',
  escalated: 'Escalated',
  closed: 'Closed by human',
  policy_closed: 'Closed by analyst policy',
  needs_human: 'Needs human',
  true_positive: 'True positive',
};

/** Operator-requested dashboard copy. The rail is text-only; no phase pictograms. */
const DASHBOARD_STAGE_LABEL: Record<string, string> = {
  ingested: 'Alerts ingested',
  clustered: 'After clustering',
  candidate: 'Awaiting review',
  awaiting: 'Awaiting review',
  cases: 'Cases opened',
  auto_cleared: 'Auto-cleared by AI',
  escalated: 'Escalated',
  closed: 'Closed by human',
  policy_closed: 'Closed by analyst policy',
};

/** One-line "what this stage means" copy for the per-stage hover card (plain text). */
const STAGE_MEANING: Record<string, string> = {
  ingested: 'Every raw alert pulled from your connected sources, before any triage.',
  clustered: 'Related alerts grouped into deduplicated clusters by the correlation engine.',
  // Honest about the below-floor tier: these are seen + risk-scored, not silently dropped,
  // but they have NOT been reasoned over by the strong LLM yet (they sit below the
  // auto-investigate risk floor). They stay $0 candidates until risk/anomaly promotes them.
  candidate:
    'Clusters the agent risk-scored but kept below the auto-investigate floor — seen and ' +
    'tracked as $0 candidates, not yet reasoned over by the AI.',
  awaiting:
    'Clusters the agent risk-scored but kept below the auto-investigate floor — seen and ' +
    'tracked as $0 candidates, not yet reasoned over by the AI.',
  cases: 'Clusters the agent promoted into investigable cases.',
  auto_cleared: 'Cases the agent auto-closed as false positives — no human needed.',
  escalated:
    'Every case not false-positive auto-cleared by the agent, including analyst-owned, ' +
    'needs-human, and confirmed residual cases.',
  closed: 'Cases a human analyst drove to a terminal state (resolved / closed).',
  policy_closed:
    'Cases closed by an operator declaration that the detection is benign here — no ' +
    'model was called and no analyst worked the case. Excluded from agent performance.',
  needs_human: 'Cases routed to a human for the final decision.',
  true_positive: 'Cases confirmed as real, actionable threats.',
};

/** The terminal case views rendered after `cases` (AI-cleared, escalated, human-closed).
 *  `closed` overlaps `escalated`; it is not a third partition. */
const OUTCOME_KEYS = ['auto_cleared', 'escalated', 'closed', 'policy_closed'];

/** Popover help copy (>80 chars → focusable Popover, not a bare Tooltip). */
const LEGACY_NOISE_FUNNEL_HELP_TEXT =
  'How the agent reduces raw alert volume: received alerts move through clustering, a ' +
  'fraction become cases, and opened cases split into false-positive auto-clear or the ' +
  'escalated analyst path. Closed by human is a subset of that escalated path, not a ' +
  'third partition. Counts and percentages in the aligned rail are authoritative; ' +
  'hover or focus any stage for its evidence.';

export const NOISE_FUNNEL_HELP_TEXT =
  'Simple view draws the complete alert-to-cluster-to-case flow with filled, tapered ' +
  'ribbons and exact stage labels. Ribbon thickness uses a compressed display scale so ' +
  'small stages stay visible; alerts, clusters, and cases remain different units. From ' +
  'Cases opened onward, Auto-cleared, optional analyst-policy closes, and Escalated form ' +
  'the conserved case split.';

/* ------------------------------------------------------------------------- */
/* Pure derivation (exported for tests).                                       */
/* ------------------------------------------------------------------------- */

/** One render-ready funnel stage. */
export interface FunnelRow {
  key: string;
  label: string;
  total: number;
  by_severity: NoiseSeverityBreakdown;
  /** Deterministic-code stage vs the LLM-influenced `cases` stage. */
  deterministic: boolean;
  /** Bar width as a fraction of `topTotal` (0..1). */
  ratio: number;
  /** Share of the funnel top (`topTotal`) this stage retains (0..100). */
  pctRetained: number;
  /** A terminal case view. Auto-cleared + escalated partition cases; closed overlaps. */
  isOutcome: boolean;
}

export interface DerivedFunnel {
  rows: FunnelRow[];
  /** The funnel top the ribbons/percentages are relative to (ingested, or cases when degraded). */
  topTotal: number;
  /** 'full' = counters available (ingested→…); 'cases' = counters warming up (case-only). */
  mode: 'full' | 'cases';
  casesTotal: number;
  /** auto_cleared + escalated + closed — overlapping views, retained for compatibility. */
  outcomeSum: number;
}

/**
 * Derive the ordered funnel rows from the §D contract as the processing flow
 * ingested → clustered → cases → {auto_cleared | escalated → closed}, switching to a
 * case-only view when the durable ingest counters are unavailable. The trailing
 * `closed` stage (label "Closed by human") is supplied by the backend (terminal AND
 * explicitly analyst-decided); the legacy `needs_human`/`true_positive` keys stay in the payload for
 * back-compat but are no longer separate spine chips. The MECE `reduction.overall_pct`
 * headline is the backend's own value and is byte-identical here.
 */
export function deriveFunnel(data: NoiseReduction): DerivedFunnel {
  const byKey = new Map<string, NoiseStage>();
  for (const s of data.stages ?? []) byKey.set(s.key, s);

  const countersOk = data.counters?.available !== false;

  const casesTotal = byKey.get('cases')?.total ?? 0;
  const auto = byKey.get('auto_cleared')?.total ?? 0;
  const esc = byKey.get('escalated')?.total ?? 0;
  const closed = byKey.get('closed')?.total ?? 0;

  // A below-floor "Awaiting review" tier: clusters that were correlated + risk-scored but
  // stayed below the auto-investigate floor, so they are kept as $0 candidates and have NOT
  // been reasoned over by the LLM. Rendered between `clustered` and `cases` ONLY when the
  // backend emits such a stage — so the flow is BYTE-IDENTICAL (six stages) when it doesn't,
  // and honestly shows the candidate tier when it does. Keeps the UI from implying reasoning
  // that isn't happening for below-floor candidates.
  const candidateKey = byKey.has('candidate')
    ? 'candidate'
    : byKey.has('awaiting')
      ? 'awaiting'
      : null;

  // Full flow from ingested, or case-only when the counters are still warming up.
  // Rendered ONLY when an operator has actually declared something, so a deployment
  // with no analyst rule policies keeps the exact previous stage list.
  const policyKeys = (byKey.get('policy_closed')?.total ?? 0) > 0 ? ['policy_closed'] : [];

  const visibleKeys = countersOk
    ? [
        'ingested',
        'clustered',
        ...(candidateKey ? [candidateKey] : []),
        'cases',
        'auto_cleared',
        'escalated',
        'closed',
        ...policyKeys,
      ]
    : ['cases', 'auto_cleared', 'escalated', 'closed', ...policyKeys];

  const topKey = countersOk ? 'ingested' : 'cases';
  const topTotal = byKey.get(topKey)?.total ?? casesTotal;

  const asRow = (key: string, stage: NoiseStage | undefined): FunnelRow => {
    const total = stage?.total ?? 0;
    return {
      key,
      label: stage?.label || STAGE_LABEL[key] || key,
      total,
      by_severity: stage?.by_severity ?? {},
      // Trust the backend flag; default per the §H pin (only `cases` is LLM-influenced;
      // `closed` is a human-driven terminal, so it reads as deterministic).
      deterministic: stage ? stage.deterministic : key !== 'cases',
      ratio: topTotal > 0 ? total / topTotal : 0,
      pctRetained: topTotal > 0 ? (total / topTotal) * 100 : 0,
      isOutcome: OUTCOME_KEYS.includes(key),
    };
  };

  const rows = visibleKeys.map((key) => asRow(key, byKey.get(key)));

  return {
    rows,
    topTotal,
    mode: countersOk ? 'full' : 'cases',
    casesTotal,
    // The three terminal outcomes rendered in the fan out of `cases`.
    outcomeSum: auto + esc + closed,
  };
}

/* ------------------------------------------------------------------------- */
/* Flow geometry.                                                             */
/* ------------------------------------------------------------------------- */

/** Honest compact share copy: a non-zero sub-half-percent cohort never reads as 0%. */
function formatShare(value: number): string {
  const rounded = Math.round(value);
  return value > 0 && rounded === 0 ? '<1%' : `${rounded}%`;
}

/**
 * The canonical horizontal-Sankey link path: a symmetric cubic Bezier between two
 * fixed-height endpoints, using the horizontal midpoint as the control x (exactly
 * what `d3.sankeyLinkHorizontal()` generates). Exported for unit tests.
 */
export function ribbonPath(
  x0: number,
  sy0: number,
  sy1: number,
  x1: number,
  ty0: number,
  ty1: number,
): string {
  const xm = (x0 + x1) / 2;
  return `M${x0},${sy0} C${xm},${sy0} ${xm},${ty0} ${x1},${ty0} L${x1},${ty1} C${xm},${ty1} ${xm},${sy1} ${x0},${sy1} Z`;
}

interface Rect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/* Exact Testing renderer geometry used by Detailed view. Keep this isolated from
 * the Simple renderer: Detailed is a compatibility presentation, including its
 * 640×220 stretched canvas, processing spine, overlapping outcome fan, drop badges,
 * and excluded-count spur. */
const LEGACY_VB_W = 640;
const LEGACY_VB_H = 220;
const LEGACY_FLAT_PLOT_LEFT_EXTENSION = 14;
const LEGACY_CY = LEGACY_VB_H / 2;
const LEGACY_PLOT_PAD = 24;
const LEGACY_PLOT_H = LEGACY_VB_H - LEGACY_PLOT_PAD * 2;
const LEGACY_NODE_W = 5;
const LEGACY_OUTCOME_SPREAD = 58;

function legacySpineNodeHeight(total: number, topTotal: number): number {
  if (total <= 0) return 0;
  const prop = topTotal > 0 ? Math.min(1, total / topTotal) : 0;
  return LEGACY_PLOT_H * prop;
}

interface LegacyRibbon {
  id: string;
  path: string;
  colorName: string;
  kind: 'flow' | 'outcome';
  sourceKey: string;
  targetKey: string;
}

interface LegacyBadge {
  leftPct: number;
  topPct: number;
  drop: number;
  pct: number;
}

interface LegacyLayout {
  ribbons: LegacyRibbon[];
  rects: Rect[];
  badges: LegacyBadge[];
  spurPath: string | null;
  spurNub: { x: number; y: number } | null;
  spurChip: { leftPct: number; topPct: number } | null;
}

interface LegacySpineGeom {
  row: FunnelRow;
  index: number;
  x: number;
  top: number;
  bottom: number;
  h: number;
}

function buildLegacyLayout(
  derived: DerivedFunnel,
  drops: { suppressed: number; ignored: number },
  uid: string,
  leftExtension = 0,
): LegacyLayout {
  const rows = derived.rows;
  const n = rows.length;
  const candidateKeys = new Set(['candidate', 'awaiting']);
  const spineEntries = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row.isOutcome && !candidateKeys.has(row.key));
  const topTotal = derived.topTotal;
  const colCenter = (i: number) => {
    const count = Math.max(1, n);
    const canonical = (LEGACY_VB_W * (i + 0.5)) / count;
    if (leftExtension <= 0) return canonical;
    const progress = count <= 1 ? 0 : i / (count - 1);
    return canonical - leftExtension * (1 - progress);
  };

  const rects: Rect[] = [];
  const ribbons: LegacyRibbon[] = [];
  const badges: LegacyBadge[] = [];
  const spine: LegacySpineGeom[] = [];

  for (const { row, index } of spineEntries) {
    const x = colCenter(index);
    const h = legacySpineNodeHeight(row.total, topTotal);
    const top = LEGACY_CY - h / 2;
    if (h > 0) {
      rects.push({
        key: row.key,
        x: x - LEGACY_NODE_W / 2,
        y: top,
        w: LEGACY_NODE_W,
        h,
        fill: token('primary'),
      });
    }
    spine.push({ row, index, x, top, bottom: top + h, h });
  }

  for (let i = 0; i < spine.length - 1; i += 1) {
    const source = spine[i];
    const target = spine[i + 1];
    if (source.h > 0 && target.h > 0) {
      ribbons.push({
        id: `${uid}-legacy-flow-${i}`,
        path: ribbonPath(
          source.x + LEGACY_NODE_W / 2,
          source.top,
          source.bottom,
          target.x - LEGACY_NODE_W / 2,
          target.top,
          target.bottom,
        ),
        colorName: 'primary',
        kind: 'flow',
        sourceKey: source.row.key,
        targetKey: target.row.key,
      });
    }

    const drop = Math.max(0, source.row.total - target.row.total);
    if (drop > 0) {
      badges.push({
        leftPct: (((source.x + target.x) / 2) / LEGACY_VB_W) * 100,
        topPct: (10 / LEGACY_VB_H) * 100,
        drop,
        pct: source.row.total > 0 ? Math.round((drop / source.row.total) * 100) : 0,
      });
    }
  }

  const candidateEntry = rows
    .map((row, index) => ({ row, index }))
    .find(({ row }) => candidateKeys.has(row.key));
  const clusteredNode = spine.find((node) => node.row.key === 'clustered');
  if (candidateEntry && clusteredNode && candidateEntry.row.total > 0) {
    const x = colCenter(candidateEntry.index);
    const h = legacySpineNodeHeight(candidateEntry.row.total, topTotal);
    const top = LEGACY_VB_H - LEGACY_PLOT_PAD - h;
    rects.push({
      key: candidateEntry.row.key,
      x: x - LEGACY_NODE_W / 2,
      y: top,
      w: LEGACY_NODE_W,
      h,
      fill: token('muted-foreground'),
    });
    const sourceH = Math.min(clusteredNode.h, h);
    ribbons.push({
      id: `${uid}-legacy-candidate`,
      path: ribbonPath(
        clusteredNode.x + LEGACY_NODE_W / 2,
        clusteredNode.bottom - sourceH,
        clusteredNode.bottom,
        x - LEGACY_NODE_W / 2,
        top,
        top + h,
      ),
      colorName: 'muted-foreground',
      kind: 'flow',
      sourceKey: clusteredNode.row.key,
      targetKey: candidateEntry.row.key,
    });
  }

  const outcomes = rows.filter((row) => row.isOutcome);
  const casesNode = spine.find((node) => node.row.key === 'cases');
  const casesTotal = derived.casesTotal;
  const casesH = casesNode ? casesNode.h : 0;
  const shareSum = outcomes.reduce(
    (sum, row) => sum + (casesTotal > 0 && row.total > 0 ? row.total / casesTotal : 0),
    0,
  );
  const sourceScale = shareSum > 1 ? 1 / shareSum : 1;
  let sliceCursor = casesNode ? casesNode.top : LEGACY_CY;
  outcomes.forEach((row, outcomeIndex) => {
    const rowIndex = rows.findIndex((candidate) => candidate.key === row.key);
    const x = colCenter(rowIndex);
    const share = casesTotal > 0 ? row.total / casesTotal : 0;
    const h = row.total > 0 ? share * casesH : 0;
    const centerY =
      outcomes.length > 1
        ? LEGACY_CY -
          LEGACY_OUTCOME_SPREAD +
          (2 * LEGACY_OUTCOME_SPREAD * outcomeIndex) / (outcomes.length - 1)
        : LEGACY_CY;
    const top = centerY - h / 2;
    const colorName = OUTCOME_TOKEN[row.key] ?? 'primary';
    if (h > 0) {
      rects.push({
        key: row.key,
        x: x - LEGACY_NODE_W / 2,
        y: top,
        w: LEGACY_NODE_W,
        h,
        fill: token(colorName),
      });
    }

    if (casesNode && casesH > 0 && row.total > 0) {
      const sliceH = share * casesH * sourceScale;
      const sourceTop = sliceCursor;
      const sourceBottom = sliceCursor + sliceH;
      sliceCursor = sourceBottom;
      ribbons.push({
        id: `${uid}-legacy-outcome-${outcomeIndex}`,
        path: ribbonPath(
          casesNode.x + LEGACY_NODE_W / 2,
          sourceTop,
          sourceBottom,
          x - LEGACY_NODE_W / 2,
          top,
          top + h,
        ),
        colorName,
        kind: 'outcome',
        sourceKey: casesNode.row.key,
        targetKey: row.key,
      });
    }
  });

  const dropTotal = (drops.suppressed ?? 0) + (drops.ignored ?? 0);
  let spurPath: string | null = null;
  let spurNub: { x: number; y: number } | null = null;
  let spurChip: { leftPct: number; topPct: number } | null = null;
  if (dropTotal > 0 && spine.length >= 2 && spine[0].h > 0) {
    const sourceX = spine[0].x;
    const sourceY = spine[0].bottom - spine[0].h * 0.25;
    const nubX = (spine[0].x + spine[1].x) / 2;
    const nubY = LEGACY_VB_H - 12;
    spurPath = `M${sourceX},${sourceY} C${(sourceX + nubX) / 2},${sourceY} ${nubX},${nubY - 24} ${nubX},${nubY}`;
    spurNub = { x: nubX, y: nubY };
    spurChip = {
      leftPct: (nubX / LEGACY_VB_W) * 100,
      topPct: ((nubY - 4) / LEGACY_VB_H) * 100,
    };
  }

  return { ribbons, rects, badges, spurPath, spurNub, spurChip };
}

/* Carbon-inspired conversion + conserved case-flow geometry. */

const SIMPLE_INLINE_WIDTH = 800;
const SIMPLE_EXPANDED_WIDTH = 1120;
const SIMPLE_INLINE_HEIGHT = 184;
const SIMPLE_EXPANDED_HEIGHT = 400;
const SIMPLE_NODE_W = 4;
const SIMPLE_FLOW_KEYS = new Set([
  'ingested',
  'clustered',
  'cases',
  'auto_cleared',
  'policy_closed',
  'escalated',
  'closed',
  'escalated_remaining',
]);

interface SimpleRibbon {
  id: string;
  kind: 'conversion' | 'conserved';
  path: string;
  targetColor: string;
  sourceKey: string;
  targetKey: string;
  value: number;
  sourceHeight: number;
  targetHeight: number;
  relatedStages: string[];
}

interface SimpleNode extends Rect {
  rowKey: string | null;
  label: string;
  total: number;
  labelY: number;
  labelSide: 'after' | 'before';
}

interface ConversionNode {
  key: 'ingested' | 'clustered';
  row: FunnelRow;
  x: number;
  y: number;
  h: number;
  labelY: number;
  labelSide: 'above' | 'below';
}

interface SimpleLayout {
  width: number;
  height: number;
  valid: boolean;
  integrityMessage: string | null;
  remainingEscalated: number;
  ribbons: SimpleRibbon[];
  nodes: SimpleNode[];
  conversionNodes: ConversionNode[];
  casesX: number;
  contextY: number;
}

/**
 * Build the polished full-pipeline Simple view. Alerts → clusters → cases are filled,
 * tapered conversion ribbons using a disclosed square-root display scale so the much
 * smaller case stages remain legible. Exact labels retain their different units. From
 * Cases opened onward, child heights remain strictly conserved:
 *
 *   auto-cleared + policy-closed + escalated = cases
 *   closed-by-human + not-analyst-closed = escalated
 */
function buildSimpleLayout(
  derived: DerivedFunnel,
  uid: string,
  requestedWidth: number,
  height: number,
): SimpleLayout {
  const width = Math.max(720, requestedWidth || SIMPLE_INLINE_WIDTH);
  const rowByKey = new Map(derived.rows.map((row) => [row.key, row]));
  const rawTotal = (key: string) => rowByKey.get(key)?.total ?? 0;
  const safeTotal = (key: string) => {
    const value = rawTotal(key);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const ingested = safeTotal('ingested');
  const clustered = safeTotal('clustered');
  const cases = safeTotal('cases');
  const autoCleared = safeTotal('auto_cleared');
  const policyClosed = safeTotal('policy_closed');
  const escalated = safeTotal('escalated');
  const closed = safeTotal('closed');
  const remainingEscalated = Math.max(0, escalated - closed);
  const rawCaseTotals = [
    rawTotal('cases'),
    rawTotal('auto_cleared'),
    rawTotal('policy_closed'),
    rawTotal('escalated'),
    rawTotal('closed'),
  ];
  const valid =
    rawCaseTotals.every((value) => Number.isFinite(value) && value >= 0) &&
    autoCleared + policyClosed + escalated === cases &&
    closed <= escalated;

  const casesX = width * 0.405;
  const base = {
    width,
    height,
    valid,
    integrityMessage: valid
      ? null
      : 'Case outcomes do not reconcile, so proportional ribbons are withheld. Exact counts remain available in Detailed view.',
    remainingEscalated,
    ribbons: [] as SimpleRibbon[],
    nodes: [] as SimpleNode[],
    conversionNodes: [] as ConversionNode[],
    casesX,
    contextY: height / 2,
  };

  if (!valid || cases <= 0) return base;

  const expanded = height >= 300;
  const plotTop = expanded ? 54 : 34;
  const plotBottom = height - (expanded ? 24 : 10);
  const nodePadding = expanded ? 42 : 24;
  const pipelineHeight = Math.max(1, plotBottom - plotTop - nodePadding);
  const fullPipeline = derived.mode === 'full' && ingested > 0;
  const compressedHeight = (total: number) =>
    total > 0 && ingested > 0
      ? pipelineHeight * Math.sqrt(Math.min(1, total / ingested))
      : 0;
  const caseHeight = Math.max(1, fullPipeline ? compressedHeight(cases) : pipelineHeight);
  const contextY = (plotTop + plotBottom) / 2;
  const casesTop = contextY - caseHeight / 2;
  const casesBottom = casesTop + caseHeight;
  const decisionX = width * 0.69;
  const resolutionX = width - 10;

  const autoHeight = (autoCleared / cases) * caseHeight;
  const policyHeight = (policyClosed / cases) * caseHeight;
  const escalatedHeight = (escalated / cases) * caseHeight;
  const decisionGap = policyClosed > 0 ? (expanded ? 24 : 14) : nodePadding;
  const decisionGapCount = policyClosed > 0 ? 2 : 1;
  const autoTop = contextY - (caseHeight + decisionGap * decisionGapCount) / 2;
  const policyTop = autoTop + autoHeight + decisionGap;
  const escalatedTop =
    policyClosed > 0
      ? policyTop + policyHeight + decisionGap
      : autoTop + autoHeight + decisionGap;
  const escalatedBottom = escalatedTop + escalatedHeight;

  const resolutionPadding = expanded ? 30 : 18;
  const closedHeight = escalated > 0 ? (closed / escalated) * escalatedHeight : 0;
  const remainingHeight =
    escalated > 0 ? (remainingEscalated / escalated) * escalatedHeight : 0;
  const resolutionHeight = closedHeight + remainingHeight + resolutionPadding;
  const escalatedCenter = escalatedTop + escalatedHeight / 2;
  const resolutionTop = Math.max(
    plotTop,
    Math.min(plotBottom - resolutionHeight, escalatedCenter - resolutionHeight / 2),
  );
  const closedTop = resolutionTop;
  const remainingTop = closedTop + closedHeight + resolutionPadding;

  // Keep the two right-hand labels in separate lanes even when automation leaves
  // only a very thin non-auto-cleared branch.
  const labelGap = expanded ? 36 : 27;
  const labelInset = expanded ? 18 : 12;
  const labelFloor = plotTop + labelInset;
  const labelCeiling = plotBottom - labelInset;
  let closedLabelY = closedTop + Math.max(1, closedHeight) / 2;
  let remainingLabelY = remainingTop + Math.max(1, remainingHeight) / 2;
  if (remainingLabelY - closedLabelY < labelGap) {
    const midpoint = (closedLabelY + remainingLabelY) / 2;
    closedLabelY = midpoint - labelGap / 2;
    remainingLabelY = midpoint + labelGap / 2;
  }
  if (closedLabelY < labelFloor) {
    remainingLabelY += labelFloor - closedLabelY;
    closedLabelY = labelFloor;
  }
  if (remainingLabelY > labelCeiling) {
    closedLabelY -= remainingLabelY - labelCeiling;
    remainingLabelY = labelCeiling;
  }

  const nodes: SimpleNode[] = [
    {
      key: 'cases',
      rowKey: 'cases',
      label: 'Cases opened',
      total: cases,
      labelY: Math.max(plotTop + 9, casesTop - 8),
      labelSide: 'after',
      x: casesX - SIMPLE_NODE_W / 2,
      y: casesTop,
      w: SIMPLE_NODE_W,
      h: caseHeight,
      fill: token('primary'),
    },
    {
      key: 'auto_cleared',
      rowKey: 'auto_cleared',
      label: 'Auto-cleared by AI',
      total: autoCleared,
      labelY: autoTop + Math.max(1, autoHeight) / 2,
      labelSide: 'after',
      x: decisionX - SIMPLE_NODE_W / 2,
      y: autoTop,
      w: SIMPLE_NODE_W,
      h: autoHeight,
      fill: token(OUTCOME_TOKEN.auto_cleared),
    },
    ...(policyClosed > 0
      ? [
          {
            key: 'policy_closed',
            rowKey: 'policy_closed',
            label: 'Closed by analyst policy',
            total: policyClosed,
            labelY: policyTop + Math.max(1, policyHeight) / 2,
            labelSide: 'after' as const,
            x: decisionX - SIMPLE_NODE_W / 2,
            y: policyTop,
            w: SIMPLE_NODE_W,
            h: policyHeight,
            fill: token(OUTCOME_TOKEN.policy_closed),
          },
        ]
      : []),
    {
      key: 'escalated',
      rowKey: 'escalated',
      label: 'Escalated',
      total: escalated,
      labelY: escalatedTop + Math.max(1, escalatedHeight) / 2,
      labelSide: 'before',
      x: decisionX - SIMPLE_NODE_W / 2,
      y: escalatedTop,
      w: SIMPLE_NODE_W,
      h: escalatedHeight,
      fill: token(OUTCOME_TOKEN.escalated),
    },
    {
      key: 'closed',
      rowKey: 'closed',
      label: 'Closed by human',
      total: closed,
      labelY: closedLabelY,
      labelSide: 'before',
      x: resolutionX - SIMPLE_NODE_W / 2,
      y: closedTop,
      w: SIMPLE_NODE_W,
      h: closedHeight,
      fill: token(OUTCOME_TOKEN.closed),
    },
    {
      key: 'escalated_remaining',
      rowKey: null,
      label: 'Not analyst-closed',
      total: remainingEscalated,
      labelY: remainingLabelY,
      labelSide: 'before',
      x: resolutionX - SIMPLE_NODE_W / 2,
      y: remainingTop,
      w: SIMPLE_NODE_W,
      h: remainingHeight,
      fill: token(OUTCOME_TOKEN.escalated),
    },
  ];

  const ribbons: SimpleRibbon[] = [];
  const addRibbon = (
    suffix: string,
    kind: 'conversion' | 'conserved',
    sourceKey: string,
    targetKey: string,
    value: number,
    x0: number,
    sy0: number,
    sy1: number,
    x1: number,
    ty0: number,
    ty1: number,
    targetColor: string,
    relatedStages: string[],
  ) => {
    if (value <= 0 || sy1 <= sy0 || ty1 <= ty0) return;
    const id = `${uid}-${suffix}`;
    ribbons.push({
      id,
      kind,
      path: ribbonPath(x0, sy0, sy1, x1, ty0, ty1),
      targetColor,
      sourceKey,
      targetKey,
      value,
      sourceHeight: sy1 - sy0,
      targetHeight: ty1 - ty0,
      relatedStages,
    });
  };

  const conversionNodes: ConversionNode[] = [];
  if (fullPipeline) {
    const ingestedRow = rowByKey.get('ingested');
    const clusteredRow = rowByKey.get('clustered');
    const ingestedHeight = pipelineHeight;
    const clusteredHeight = compressedHeight(clustered);
    const ingestedX = 12;
    const clusteredX = width * 0.205;
    if (ingestedRow && ingestedHeight > 0) {
      conversionNodes.push({
        key: 'ingested',
        row: ingestedRow,
        x: ingestedX,
        y: contextY - ingestedHeight / 2,
        h: ingestedHeight,
        labelY: contextY - ingestedHeight / 2 - 6,
        labelSide: 'above',
      });
    }
    if (clusteredRow && clusteredHeight > 0) {
      conversionNodes.push({
        key: 'clustered',
        row: clusteredRow,
        x: clusteredX,
        y: contextY - clusteredHeight / 2,
        h: clusteredHeight,
        labelY: contextY + clusteredHeight / 2 + 6,
        labelSide: 'below',
      });
    }

    if (ingestedRow && clusteredRow && ingestedHeight > 0 && clusteredHeight > 0) {
      addRibbon(
        'simple-ingested-clustered',
        'conversion',
        'ingested',
        'clustered',
        clustered,
        ingestedX + SIMPLE_NODE_W / 2,
        contextY - ingestedHeight / 2,
        contextY + ingestedHeight / 2,
        clusteredX - SIMPLE_NODE_W / 2,
        contextY - clusteredHeight / 2,
        contextY + clusteredHeight / 2,
        token('primary'),
        [...SIMPLE_FLOW_KEYS],
      );
    }
    if (clusteredRow && clusteredHeight > 0 && caseHeight > 0) {
      addRibbon(
        'simple-clustered-cases',
        'conversion',
        'clustered',
        'cases',
        cases,
        clusteredX + SIMPLE_NODE_W / 2,
        contextY - clusteredHeight / 2,
        contextY + clusteredHeight / 2,
        casesX - SIMPLE_NODE_W / 2,
        casesTop,
        casesBottom,
        token('primary'),
        [...SIMPLE_FLOW_KEYS],
      );
    }
  }

  addRibbon(
    'simple-cases-auto',
    'conserved',
    'cases',
    'auto_cleared',
    autoCleared,
    casesX + SIMPLE_NODE_W / 2,
    casesTop,
    casesTop + autoHeight,
    decisionX - SIMPLE_NODE_W / 2,
    autoTop,
    autoTop + autoHeight,
    token(OUTCOME_TOKEN.auto_cleared),
    ['cases', 'auto_cleared'],
  );
  addRibbon(
    'simple-cases-policy',
    'conserved',
    'cases',
    'policy_closed',
    policyClosed,
    casesX + SIMPLE_NODE_W / 2,
    casesTop + autoHeight,
    casesTop + autoHeight + policyHeight,
    decisionX - SIMPLE_NODE_W / 2,
    policyTop,
    policyTop + policyHeight,
    token(OUTCOME_TOKEN.policy_closed),
    ['cases', 'policy_closed'],
  );
  addRibbon(
    'simple-cases-escalated',
    'conserved',
    'cases',
    'escalated',
    escalated,
    casesX + SIMPLE_NODE_W / 2,
    casesTop + autoHeight + policyHeight,
    casesBottom,
    decisionX - SIMPLE_NODE_W / 2,
    escalatedTop,
    escalatedBottom,
    token(OUTCOME_TOKEN.escalated),
    ['cases', 'escalated', 'closed', 'escalated_remaining'],
  );
  addRibbon(
    'simple-escalated-closed',
    'conserved',
    'escalated',
    'closed',
    closed,
    decisionX + SIMPLE_NODE_W / 2,
    escalatedTop,
    escalatedTop + closedHeight,
    resolutionX - SIMPLE_NODE_W / 2,
    closedTop,
    closedTop + closedHeight,
    token(OUTCOME_TOKEN.closed),
    ['cases', 'escalated', 'closed'],
  );
  addRibbon(
    'simple-escalated-remaining',
    'conserved',
    'escalated',
    'escalated_remaining',
    remainingEscalated,
    decisionX + SIMPLE_NODE_W / 2,
    escalatedTop + closedHeight,
    escalatedBottom,
    resolutionX - SIMPLE_NODE_W / 2,
    remainingTop,
    remainingTop + remainingHeight,
    token(OUTCOME_TOKEN.escalated),
    ['cases', 'escalated', 'escalated_remaining'],
  );

  return {
    ...base,
    ribbons,
    nodes,
    conversionNodes,
    casesX,
    contextY,
  };
}

/* ------------------------------------------------------------------------- */
/* Presentation helpers.                                                       */
/* ------------------------------------------------------------------------- */

/** Per-severity (or per-disposition) mini breakdown shown inside a stage hover card. */
function StageBreakdown({ row }: { row: FunnelRow }) {
  const entries = SEV_ORDER.map(
    (b) => [b, Math.max(0, Number(row.by_severity[b] ?? 0))] as const,
  ).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
  return (
    <div className="space-y-1.5">
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        By severity
      </p>
      <ul className="space-y-1.5">
        {entries.map(([band, value]) => (
          <li key={band} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: token(BAND_TOKEN[band]) }}
              aria-hidden
            />
            <span className="w-14 shrink-0 text-2xs text-muted-foreground">{SEV_LABEL[band]}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(value / max) * 100}%`, backgroundColor: token(BAND_TOKEN[band]) }}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground">
              {fmtNumber(value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function stageAuthority(row: FunnelRow): string {
  return row.key === 'closed' ? 'Human-driven' : row.deterministic ? 'Deterministic' : 'AI-assisted';
}

function stageSeverityDescription(row: FunnelRow): string {
  const parts = SEV_ORDER.map((band) => {
    const value = Math.max(0, Number(row.by_severity[band] ?? 0));
    return value > 0 ? `${SEV_LABEL[band]} ${fmtNumber(value)}` : null;
  }).filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `By severity: ${parts.join(', ')}.` : 'No severity breakdown is available.';
}

/** The rich hover-card body for one stage chip. */
function StageHoverContent({
  row,
  topReference,
  baseReference,
}: {
  row: FunnelRow;
  topReference: string;
  baseReference: FunnelRow | null;
}) {
  const pctRetained = formatShare(row.pctRetained);
  const ofPrevious =
    baseReference && baseReference.total > 0
      ? (row.total / baseReference.total) * 100
      : null;
  const meaning = STAGE_MEANING[row.key];
  const authority = stageAuthority(row);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {authority}
        </span>
      </div>
      {meaning ? <p className="text-xs leading-relaxed text-muted-foreground">{meaning}</p> : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
          {fmtNumber(row.total)}
        </span>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {pctRetained} {topReference}
          {ofPrevious != null && baseReference
            ? ` · ${formatShare(ofPrevious)} of ${baseReference.label.toLowerCase()}`
            : ''}
        </span>
      </div>
      <StageBreakdown row={row} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Component.                                                                  */
/* ------------------------------------------------------------------------- */

export interface NoiseFunnelProps {
  /** The §D funnel payload, or `null` while unfetched / when the feature is off. */
  data: NoiseReduction | null;
  /** Show the loading skeleton. */
  loading?: boolean;
  /** Stagger the stage reveal + count-up (default true; reduced-motion still wins). */
  animate?: boolean;
  /** Accessible label for the funnel region. */
  ariaLabel?: string;
  className?: string;
  /** Fires with a stage `key` (e.g. `'escalated'`) — the host filters the Cases list. */
  onStageClick?: (key: string) => void;
  /** Per-user collapsed state (header stays; body hides). */
  hidden?: boolean;
  /** Toggle the collapsed state (renders the show/hide control when provided). */
  onToggleHidden?: () => void;
  /** `flat` removes card chrome and tightens the flow for the command-center canvas. */
  variant?: 'card' | 'flat';
  /** Show an accessible near-fullscreen aggregate-flow inspection action. */
  expandable?: boolean;
  /** Test/integration seam for the lazy selected-window lineage read. */
  lineageLoader?: (windowHours: number, limit: number) => Promise<NoiseLineage>;
  /** Expanded inspection keeps the graph and aligned rail visible at every viewport. */
  wideInspection?: boolean;
  /** Selected-window current-state context. This is not a conserved flow node. */
  openCases?: { count: number; partial?: boolean };
  /** Opens the complete active-case cohort for the selected window. */
  onOpenCasesClick?: () => void;
  /** Optional controlled presentation mode (used by the expanded inspection). */
  view?: NoiseFunnelView;
  /** Initial mode for an uncontrolled funnel. */
  defaultView?: NoiseFunnelView;
  /** Optional controlled-mode change callback. */
  onViewChange?: (view: NoiseFunnelView) => void;
}

export type NoiseFunnelView = 'simple' | 'detailed';

function Header({
  hidden,
  onToggleHidden,
  onExpand,
  flat,
  view,
  onViewChange,
}: {
  hidden?: boolean;
  onToggleHidden?: () => void;
  onExpand?: () => void;
  flat?: boolean;
  view: NoiseFunnelView;
  onViewChange: (view: NoiseFunnelView) => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h3
          className={cn(
            'font-semibold text-foreground',
            flat ? 'text-2xs uppercase tracking-widest' : 'text-sm',
          )}
        >
          {flat ? 'Noise reduction flow' : 'Noise reduction'}
        </h3>
        <HelpTip
          label="What the noise-reduction funnel means"
          text={view === 'detailed' ? LEGACY_NOISE_FUNNEL_HELP_TEXT : NOISE_FUNNEL_HELP_TEXT}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {!hidden ? (
          <SegmentedControl<NoiseFunnelView>
            aria-label="Noise reduction view"
            size="sm"
            value={view}
            onValueChange={onViewChange}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'detailed', label: 'Detailed' },
            ]}
          />
        ) : null}
        {onExpand && !hidden ? (
          <button
            type="button"
            onClick={onExpand}
            aria-label={
              view === 'detailed'
                ? 'Expand noise reduction flow'
                : 'Open full-screen noise reduction flow'
            }
            className={cn(
              'inline-flex min-h-7 items-center justify-center gap-1.5 rounded-[3px] border border-border px-2 text-2xs font-medium text-muted-foreground transition-colors',
              'hover:bg-hover hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">
              {view === 'detailed' ? 'Expand' : 'Full screen'}
            </span>
          </button>
        ) : null}
        {onToggleHidden ? (
          <button
            type="button"
            onClick={onToggleHidden}
            aria-label={hidden ? 'Show noise funnel' : 'Hide noise funnel'}
            aria-pressed={hidden ? true : false}
            className={cn(
              'inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-[3px] text-muted-foreground transition-colors',
              'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function NoiseFunnel({
  data,
  loading = false,
  animate = true,
  ariaLabel,
  className,
  onStageClick,
  hidden,
  onToggleHidden,
  variant = 'card',
  expandable = false,
  lineageLoader,
  wideInspection = false,
  openCases,
  onOpenCasesClick,
  view: controlledView,
  defaultView = 'simple',
  onViewChange,
}: NoiseFunnelProps) {
  const [uncontrolledView, setUncontrolledView] = React.useState<NoiseFunnelView>(defaultView);
  const view = controlledView ?? uncontrolledView;
  const setView = React.useCallback(
    (next: NoiseFunnelView) => {
      if (controlledView === undefined) setUncontrolledView(next);
      onViewChange?.(next);
    },
    [controlledView, onViewChange],
  );
  const [expanded, setExpanded] = React.useState(false);
  const [hoveredStage, setHoveredStage] = React.useState<string | null>(null);
  const [focusedStage, setFocusedStage] = React.useState<string | null>(null);
  const activeStage = focusedStage ?? hoveredStage;
  const activeSimpleStage =
    activeStage && SIMPLE_FLOW_KEYS.has(activeStage) ? activeStage : null;
  const [lineage, setLineage] = React.useState<NoiseLineage | null>(null);
  const [lineageLoading, setLineageLoading] = React.useState(false);
  const [lineageError, setLineageError] = React.useState<string | null>(null);
  const lineageRequest = React.useRef(0);
  const rawUid = React.useId();
  const uid = React.useMemo(() => rawUid.replace(/[^a-zA-Z0-9_-]/g, ''), [rawUid]);
  const topologyDescriptionId = `${uid}-topology`;
  const derived = React.useMemo(() => (data ? deriveFunnel(data) : null), [data]);
  const flat = variant === 'flat';
  const reducedMotion = usePrefersReducedMotion();
  const simplePlotRef = React.useRef<HTMLDivElement>(null);
  const [simplePlotWidth, setSimplePlotWidth] = React.useState(0);
  const simplePlotHeight = wideInspection ? SIMPLE_EXPANDED_HEIGHT : SIMPLE_INLINE_HEIGHT;
  const simpleFallbackWidth = wideInspection ? SIMPLE_EXPANDED_WIDTH : SIMPLE_INLINE_WIDTH;
  const dropSuppressed = data?.drops?.suppressed ?? 0;
  const dropIgnored = data?.drops?.ignored ?? 0;
  const simpleLayout = React.useMemo(
    () =>
      derived
        ? buildSimpleLayout(
            derived,
            uid,
            simplePlotWidth || simpleFallbackWidth,
            simplePlotHeight,
          )
        : null,
    [derived, simpleFallbackWidth, simplePlotHeight, simplePlotWidth, uid],
  );
  const legacyLayout = React.useMemo(
    () =>
      derived
        ? buildLegacyLayout(
            derived,
            { suppressed: dropSuppressed, ignored: dropIgnored },
            uid,
            flat ? LEGACY_FLAT_PLOT_LEFT_EXTENSION : 0,
          )
        : null,
    [derived, dropIgnored, dropSuppressed, flat, uid],
  );

  React.useLayoutEffect(() => {
    if (hidden) return undefined;
    const element = simplePlotRef.current;
    if (!element) return undefined;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width || element.clientWidth);
      if (next > 0) setSimplePlotWidth((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hidden, view, wideInspection]);

  React.useEffect(() => {
    setHoveredStage(null);
    setFocusedStage(null);
  }, [view]);
  const lineageWindowHours = data?.window_hours ?? 24;
  const loadLineage = React.useCallback(async () => {
    const loader = lineageLoader ?? api.noiseReductionLineage;
    if (typeof loader !== 'function') {
      setLineageError('Case-lineage inspection is unavailable in this deployment.');
      return;
    }
    const requestId = ++lineageRequest.current;
    setLineageLoading(true);
    setLineageError(null);
    try {
      const result = await loader(lineageWindowHours, 12);
      if (requestId === lineageRequest.current) setLineage(result);
    } catch (error) {
      if (requestId === lineageRequest.current) {
        setLineageError(error instanceof Error ? error.message : 'The lineage request failed.');
      }
    } finally {
      if (requestId === lineageRequest.current) setLineageLoading(false);
    }
  }, [lineageLoader, lineageWindowHours]);

  React.useEffect(() => {
    lineageRequest.current += 1;
    setLineage(null);
    setLineageError(null);
    setLineageLoading(false);
  }, [lineageWindowHours]);

  React.useEffect(() => {
    if (!expanded || lineage || lineageLoading || lineageError) return;
    void loadLineage();
  }, [expanded, lineage, lineageLoading, lineageError, loadLineage]);

  if (loading && !derived) {
    return (
      <ConsoleLoadingState
        label="Loading noise reduction flow"
        aria-label={ariaLabel ?? 'Loading noise reduction flow'}
        layout="panel"
        shape="panel"
        className={className}
        data-testid="noise-funnel-loading"
      />
    );
  }
  // Absent data + not loading → render nothing (a missing/off backend simply omits the widget).
  if (!data || !derived || !simpleLayout || !legacyLayout) return null;

  const overall = data.reduction?.overall_pct;
  const headlinePct = typeof overall === 'number' ? overall : null;
  const degradedNote =
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : 'Reduction pending';
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';
  const n = derived.rows.length;
  const closedByHuman = derived.rows.find((r) => r.key === 'closed')?.total ?? 0;
  const rowByKey = new Map(derived.rows.map((row) => [row.key, row]));
  const hasPolicyClosed = (rowByKey.get('policy_closed')?.total ?? 0) > 0;
  const candidateRow = rowByKey.get('candidate') ?? rowByKey.get('awaiting') ?? null;
  const escalatedRow = rowByKey.get('escalated') ?? null;
  const validOpenCases =
    openCases && Number.isFinite(openCases.count) && openCases.count >= 0
      ? { count: Math.floor(openCases.count), partial: openCases.partial === true }
      : null;

  const chips = derived.rows.map((row, index) => {
    const pctLabel = formatShare(row.pctRetained);
    const accessiblePct = pctLabel === '<1%' ? 'less than 1%' : pctLabel;
    const unit =
      row.key === 'ingested'
        ? row.total === 1
          ? 'alert'
          : 'alerts'
        : row.key === 'clustered'
          ? row.total === 1
            ? 'cluster'
            : 'clusters'
          : row.key === 'candidate' || row.key === 'awaiting'
            ? row.total === 1
              ? 'candidate'
              : 'candidates'
            : row.total === 1
              ? 'case'
              : 'cases';
    const accessibleLabel = `${row.label}: ${row.total} ${unit}, ${accessiblePct} ${relativeTo}`;
    const detailId = `${uid}-${row.key}-detail`;
    const useSimplePolicyCopy = view === 'simple' && hasPolicyClosed;
    const relationship =
      row.key === 'closed'
        ? 'This is a subset of Escalated, not an additional case partition.'
        : row.key === 'auto_cleared'
          ? useSimplePolicyCopy
            ? 'Together with Closed by analyst policy and Escalated, this partitions opened cases.'
            : 'Together with Escalated, this partitions opened cases.'
          : row.key === 'policy_closed' && view === 'simple'
            ? 'Together with Auto-cleared and Escalated, this partitions opened cases.'
          : row.key === 'escalated'
            ? useSimplePolicyCopy
              ? 'Together with Auto-cleared and Closed by analyst policy, this partitions opened cases; human closure is a subset of this stage.'
              : 'Together with Auto-cleared, this partitions opened cases; human closure is a subset of this stage.'
            : row.key === 'candidate' || row.key === 'awaiting'
              ? 'This is a side cohort from clustered alerts, not a parent of opened cases.'
              : '';
    const inspectDescription = [
      STAGE_MEANING[row.key],
      `${stageAuthority(row)}.`,
      relationship,
      stageSeverityDescription(row),
    ]
      .filter(Boolean)
      .join(' ');
    const displayLabel = flat ? DASHBOARD_STAGE_LABEL[row.key] || row.label : row.label;
    const baseReference =
      row.key === 'auto_cleared' ||
      row.key === 'escalated' ||
      (view === 'simple' && row.key === 'policy_closed')
        ? rowByKey.get('cases') ?? null
        : row.key === 'closed'
          ? rowByKey.get('escalated') ?? null
          : row.key === 'candidate' || row.key === 'awaiting' || row.key === 'cases'
            ? rowByKey.get('clustered') ?? null
            : index > 0
              ? derived.rows[index - 1]
              : null;
    const flatLabelTone =
      row.key === 'cases'
        ? 'text-critical-text'
        : row.key === 'closed'
          ? 'text-success-text'
          : 'text-muted-foreground';

    const inner = (
      <>
        <span
          className={cn(
            'max-w-full text-2xs font-medium leading-tight',
            flat
              ? `min-h-7 w-full text-left uppercase tracking-wider ${flatLabelTone}`
              : 'text-foreground',
          )}
          title={displayLabel}
        >
          {displayLabel}
        </span>
        <span className={cn('flex items-baseline gap-1', flat && 'w-full justify-start')}>
          <CountUp
            value={row.total}
            duration={animate ? undefined : 0}
            className={cn(
              'font-semibold tabular-nums text-foreground',
              flat ? 'font-mono text-xl' : 'text-sm',
            )}
          />
          <span className={cn('tabular-nums text-muted-foreground', flat ? 'text-xs' : 'text-2xs')}>
            {pctLabel}
          </span>
        </span>
      </>
    );

    const trigger = onStageClick ? (
      <button
        type="button"
        onClick={() => onStageClick(row.key)}
        onPointerEnter={() => setHoveredStage(row.key)}
        onPointerLeave={() => setHoveredStage(null)}
        onFocus={() => setFocusedStage(row.key)}
        onBlur={() => setFocusedStage(null)}
        aria-label={accessibleLabel}
        aria-describedby={detailId}
        className={cn(
          'flex w-full flex-col gap-1 transition-colors duration-fast ease-standard focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          flat
            ? 'items-start px-3 py-1 text-left hover:bg-muted/20'
            : 'items-center px-1 py-1.5 text-center hover:bg-muted/60',
          flat && index > 0 && 'lg:border-l lg:border-border/60',
        )}
      >
        {inner}
        <span id={detailId} className="sr-only">
          {inspectDescription}
        </span>
      </button>
    ) : (
      <button
        type="button"
        aria-label={accessibleLabel}
        onClick={() => setFocusedStage(row.key)}
        onPointerEnter={() => setHoveredStage(row.key)}
        onPointerLeave={() => setHoveredStage(null)}
        onFocus={() => setFocusedStage(row.key)}
        onBlur={() => setFocusedStage(null)}
        aria-describedby={detailId}
        className={cn(
          'flex w-full cursor-default flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          flat ? 'items-start px-3 py-1 text-left' : 'items-center px-1 py-1.5 text-center',
          flat && index > 0 && 'lg:border-l lg:border-border/60',
        )}
      >
        {inner}
        <span id={detailId} className="sr-only">
          {inspectDescription}
        </span>
      </button>
    );

    return (
      <HoverCard key={row.key} openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
        <HoverCardContent side="top" align="center" className="w-72">
          <StageHoverContent
            row={row}
            topReference={relativeTo}
            baseReference={baseReference}
          />
        </HoverCardContent>
      </HoverCard>
    );
  });

  const legacyGridStyle: React.CSSProperties | undefined =
    flat && !wideInspection
      ? undefined
      : { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const legacyFlatGridColumns =
    n === 4 ? 'lg:grid-cols-4' : n === 7 ? 'lg:grid-cols-7' : 'lg:grid-cols-6';
  const dropTotal = dropSuppressed + dropIgnored;

  const coverageNote = !data.counters?.available
    ? 'Durable ingest counters are still warming up, so this view starts at cases opened.'
    : data.counters?.incomplete
      ? 'Durable alert counters cover only part of the selected window.'
      : data.cases_meta?.truncated
        ? `Case stages are partial: ${fmtNumber(data.cases_meta.fetched)} of ${fmtNumber(data.cases_meta.store_total)} matching cases were tallied.`
        : 'Every value is an aggregate for the selected time range.';

  const legacyDetailedView = (
    <div
      className={cn('space-y-3', flat ? 'mt-2' : 'mt-3')}
      data-testid="noise-detailed-view"
      role="region"
      aria-label="Detailed noise reduction view"
    >
      {headlinePct != null ? (
        <div>
          <p
            className={cn(
              'font-semibold tracking-tight text-foreground',
              flat ? 'text-2xl' : 'text-2xl sm:text-3xl',
            )}
          >
            {flat ? 'Reduced by ' : 'Noise reduced by '}
            <span className="text-primary tabular-nums">{headlinePct}%</span>
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {fmtNumber(derived.topTotal)}{' '}
            {derived.mode === 'full' ? 'events ingested' : 'cases opened'}
            <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
              →
            </span>
            {fmtNumber(closedByHuman)} case{closedByHuman === 1 ? '' : 's'} closed by a human
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="noise-funnel-warming">
          {degradedNote}
        </p>
      )}

      {headlinePct != null && (data.counters?.incomplete || data.cases_meta?.truncated) ? (
        <p
          className="border-l-2 border-warning pl-2 text-xs leading-relaxed text-muted-foreground"
          data-testid="noise-coverage-warning"
        >
          <span className="font-medium text-warning-text">Partial coverage</span>
          {' · '}
          {coverageNote}
        </p>
      ) : null}

      <div
        data-testid="noise-instrument-panel"
        className={cn('space-y-3', flat && 'border-y border-border/60 py-3')}
      >
        <div
          data-testid="noise-flow-band"
          className={cn(
            'relative mt-1 w-full',
            wideInspection
              ? 'h-44'
              : flat
                ? 'hidden h-36 lg:block lg:h-44'
                : 'h-44 sm:h-52',
          )}
        >
          <svg
            viewBox={`0 0 ${LEGACY_VB_W} ${LEGACY_VB_H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            aria-hidden
            focusable="false"
          >
            {legacyLayout.ribbons.map((ribbon) => {
              const related =
                !activeStage ||
                ribbon.sourceKey === activeStage ||
                ribbon.targetKey === activeStage;
              return (
                <path
                  key={ribbon.id}
                  d={ribbon.path}
                  fill={token(ribbon.colorName)}
                  stroke={token(ribbon.colorName)}
                  strokeWidth={0.5}
                  vectorEffect="non-scaling-stroke"
                  data-noise-ribbon
                  data-source-stage={ribbon.sourceKey}
                  data-target-stage={ribbon.targetKey}
                  className="transition-opacity duration-fast ease-standard"
                  style={{
                    fillOpacity: activeStage
                      ? related
                        ? 1
                        : 0.14
                      : ribbon.kind === 'flow'
                        ? 'var(--noise-ribbon-opacity)'
                        : 'var(--noise-outcome-opacity)',
                    strokeOpacity: activeStage
                      ? related
                        ? 1
                        : 0.14
                      : 'var(--noise-ribbon-stroke-opacity)',
                  }}
                />
              );
            })}

            {legacyLayout.spurPath ? (
              <>
                <path
                  d={legacyLayout.spurPath}
                  fill="none"
                  stroke={token('muted-foreground', 0.4)}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
                {legacyLayout.spurNub ? (
                  <circle
                    cx={legacyLayout.spurNub.x}
                    cy={legacyLayout.spurNub.y}
                    r={2.5}
                    fill={token('muted-foreground', 0.7)}
                  />
                ) : null}
              </>
            ) : null}

            {legacyLayout.rects.map((rect) => (
              <rect
                key={rect.key}
                data-node-key={rect.key}
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                rx={0}
                fill={rect.fill}
                stroke={rect.fill}
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
                opacity={activeStage && activeStage !== rect.key ? 0.48 : 1}
                className="transition-opacity duration-fast ease-standard"
              />
            ))}
          </svg>

          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {legacyLayout.badges.map((badge, index) => (
              <span
                key={index}
                data-loss-annotation
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap px-1 text-2xs font-medium tabular-nums text-muted-foreground"
                style={{ left: `${badge.leftPct}%`, top: `${badge.topPct}%` }}
              >
                −{badge.drop} · {badge.pct}% filtered
              </span>
            ))}
            {legacyLayout.spurChip ? (
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap px-1 text-2xs tabular-nums text-muted-foreground"
                style={{
                  left: `${legacyLayout.spurChip.leftPct}%`,
                  top: `${legacyLayout.spurChip.topPct}%`,
                }}
              >
                −{dropTotal} excluded
              </span>
            ) : null}
          </div>
        </div>

        <div
          data-testid="noise-stage-rail"
          className={cn(
            'grid items-start gap-1',
            flat && 'grid-cols-2 gap-y-3 border-t border-border/60 pt-3 sm:grid-cols-3',
            flat && legacyFlatGridColumns,
          )}
          style={legacyGridStyle}
        >
          {chips}
        </div>

        {dropTotal > 0 ? (
          <p className="mt-1 border-t border-border pt-2 text-xs text-muted-foreground">
            {dropSuppressed} suppressed · {dropIgnored} ignored removed before clustering
          </p>
        ) : null}
      </div>
    </div>
  );

  const simpleFlowView = (
    <div
      className={cn('space-y-3', flat ? 'mt-2' : 'mt-3')}
      data-testid="noise-simple-view"
      role="region"
      aria-label="Simple noise reduction view"
    >
      {data.counters?.incomplete || data.cases_meta?.truncated ? (
        <p
          className="border-l-2 border-warning pl-2 text-xs leading-relaxed text-muted-foreground"
          data-testid="noise-coverage-warning"
        >
          <span className="font-medium text-warning-text">Partial coverage</span>
          {' · '}
          {coverageNote}
        </p>
      ) : null}

      <div
        data-testid="noise-instrument-panel"
        className={cn('@container/noise space-y-2.5', flat && 'border-y border-border/60 py-3')}
      >
        <div
          ref={simplePlotRef}
          data-testid="noise-flow-band"
          className={cn(
            'relative w-full',
            wideInspection ? 'h-[400px]' : 'hidden h-[184px] @[38rem]/noise:block',
          )}
        >
          {!simpleLayout.valid ? (
            <div
              className="flex h-full items-center justify-center border border-dashed border-warning/60 bg-warning/5 px-6 text-center text-xs leading-relaxed text-muted-foreground"
              data-testid="noise-flow-integrity"
              role="status"
            >
              {simpleLayout.integrityMessage}
            </div>
          ) : simpleLayout.nodes.length === 0 ? (
            <div
              className="flex h-full items-center justify-center border border-dashed border-border text-xs text-muted-foreground"
              data-testid="noise-flow-empty"
              role="status"
            >
              No cases were opened in this time range.
            </div>
          ) : (
            <>
              <svg
                viewBox={`0 0 ${simpleLayout.width} ${simpleLayout.height}`}
                preserveAspectRatio="xMidYMid meet"
                className="absolute inset-0 h-full w-full"
                aria-hidden
                focusable="false"
              >
                <defs>
                  <clipPath id={`${uid}-simple-flow-clip`}>
                    {simpleLayout.ribbons.map((ribbon) => (
                      <path key={`${ribbon.id}-clip`} d={ribbon.path} />
                    ))}
                  </clipPath>
                </defs>

                <text
                  x={simpleLayout.width / 2}
                  y={wideInspection ? 22 : 14}
                  textAnchor="middle"
                  fill={token('muted-foreground')}
                  fontSize={wideInspection ? 12 : 10}
                  fontWeight={600}
                  letterSpacing="0.12em"
                >
                  FULL ALERT-TO-CASE FLOW
                </text>

                {simpleLayout.conversionNodes.map((node) => (
                  <rect
                    key={`${node.key}-context-node`}
                    data-context-node-key={node.key}
                    x={node.x - SIMPLE_NODE_W / 2}
                    y={node.y}
                    width={SIMPLE_NODE_W}
                    height={node.h}
                    rx={0}
                    fill={token('primary')}
                    stroke={token('primary')}
                    strokeWidth={0.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

                {simpleLayout.ribbons.map((ribbon) => {
                  const related =
                    !activeSimpleStage || ribbon.relatedStages.includes(activeSimpleStage);
                  return (
                    <path
                      key={ribbon.id}
                      d={ribbon.path}
                      fill={ribbon.targetColor}
                      stroke={ribbon.targetColor}
                      strokeWidth={0.5}
                      vectorEffect="non-scaling-stroke"
                      data-noise-ribbon
                      data-edge-kind={ribbon.kind}
                      data-source-stage={ribbon.sourceKey}
                      data-target-stage={ribbon.targetKey}
                      data-value={ribbon.value}
                      data-source-height={ribbon.sourceHeight}
                      data-target-height={ribbon.targetHeight}
                      className="transition-opacity duration-fast ease-standard"
                      style={{
                        fillOpacity: activeSimpleStage
                          ? related
                            ? 0.92
                            : 0.14
                          : 'var(--noise-ribbon-opacity)',
                        strokeOpacity: activeSimpleStage
                          ? related
                            ? 0.92
                            : 0.12
                          : 'var(--noise-ribbon-stroke-opacity)',
                      }}
                    />
                  );
                })}

                {animate && !reducedMotion && !activeSimpleStage && simpleLayout.ribbons.length > 0 ? (
                  <g
                    key={`${data.generated_at}-flow-sweep`}
                    clipPath={`url(#${uid}-simple-flow-clip)`}
                    className="noise-flow-refresh-sweep"
                    data-testid="noise-flow-refresh-sweep"
                    style={
                      {
                        '--noise-sweep-distance': `${simpleLayout.width + 120}px`,
                      } as React.CSSProperties
                    }
                  >
                    <rect
                      x={-92}
                      y={0}
                      width={54}
                      height={simpleLayout.height}
                      fill={token('foreground', 0.05)}
                    />
                    <rect
                      x={-38}
                      y={0}
                      width={12}
                      height={simpleLayout.height}
                      fill={token('foreground', 0.16)}
                    />
                  </g>
                ) : null}

                {simpleLayout.nodes
                  .filter(
                    (node) =>
                      node.h > 0 &&
                      node.labelSide === 'before' &&
                      Math.abs(node.labelY - (node.y + node.h / 2)) > 0.5,
                  )
                  .map((node) => (
                    <path
                      key={`${node.key}-label-leader`}
                      d={`M${node.x},${node.y + node.h / 2} L${node.x - 7},${node.labelY}`}
                      fill="none"
                      stroke={token('muted-foreground', 0.55)}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      data-label-leader={node.key}
                    />
                  ))}

                {simpleLayout.nodes
                  .filter((node) => node.h > 0)
                  .map((node) => {
                    const related =
                      !activeSimpleStage ||
                      node.key === activeSimpleStage ||
                      simpleLayout.ribbons.some(
                        (ribbon) =>
                          ribbon.relatedStages.includes(activeSimpleStage) &&
                          (ribbon.sourceKey === node.key || ribbon.targetKey === node.key),
                      );
                    return (
                      <rect
                        key={node.key}
                        data-node-key={node.key}
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={node.h}
                        rx={0}
                        fill={node.fill}
                        stroke={node.fill}
                        strokeWidth={0.5}
                        vectorEffect="non-scaling-stroke"
                        opacity={related ? 1 : 0.3}
                        className="transition-opacity duration-fast ease-standard"
                      />
                    );
                  })}
              </svg>

              <div className="pointer-events-none absolute inset-0">
                {simpleLayout.conversionNodes.map((node) => {
                  const unit =
                    node.key === 'ingested'
                      ? node.row.total === 1
                        ? 'alert'
                        : 'alerts'
                      : node.row.total === 1
                        ? 'cluster'
                        : 'clusters';
                  const labelClassName = cn(
                    'absolute rounded-[3px] bg-card/95 px-1.5 py-1 text-left',
                    node.labelSide === 'above' && '-translate-y-full',
                  );
                  const labelStyle: React.CSSProperties = {
                    left: `${((node.x + 8) / simpleLayout.width) * 100}%`,
                    top: `${(node.labelY / simpleLayout.height) * 100}%`,
                  };
                  const labelContent = (
                    <>
                      <span className="block text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                        {DASHBOARD_STAGE_LABEL[node.key]}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs font-semibold tabular-nums text-foreground">
                        {fmtNumber(node.row.total)} {unit}
                      </span>
                    </>
                  );
                  if (view === 'detailed') {
                    return (
                      <div
                        key={node.key}
                        className={labelClassName}
                        style={labelStyle}
                        aria-hidden
                      >
                        {labelContent}
                      </div>
                    );
                  }
                  const control = (
                    <button
                      type="button"
                      onClick={() => onStageClick?.(node.key)}
                      onPointerEnter={() => setHoveredStage(node.key)}
                      onPointerLeave={() => setHoveredStage(null)}
                      onFocus={() => setFocusedStage(node.key)}
                      onBlur={() => setFocusedStage(null)}
                      aria-label={`${DASHBOARD_STAGE_LABEL[node.key]}: ${fmtNumber(node.row.total)} ${unit}. Filled conversion ribbon; the unit changes at this step.`}
                      className={cn(
                        'pointer-events-auto transition-colors duration-fast ease-standard',
                        'hover:bg-popover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        labelClassName,
                      )}
                      style={labelStyle}
                    >
                      {labelContent}
                    </button>
                  );
                  return (
                    <HoverCard key={node.key} openDelay={80} closeDelay={60}>
                      <HoverCardTrigger asChild>{control}</HoverCardTrigger>
                      <HoverCardContent side="top" align="center" className="w-72">
                        <StageHoverContent
                          row={node.row}
                          topReference={relativeTo}
                          baseReference={node.key === 'clustered' ? rowByKey.get('ingested') ?? null : null}
                        />
                      </HoverCardContent>
                    </HoverCard>
                  );
                })}

                {simpleLayout.nodes.filter((node) => node.h > 0).map((node) => {
                  const row = node.rowKey ? rowByKey.get(node.rowKey) : undefined;
                  const stageKey = node.rowKey ?? node.key;
                  const labelX =
                    node.labelSide === 'after' ? node.x + node.w + 8 : node.x - 8;
                  const translateX =
                    node.labelSide === 'after' ? '' : '-translate-x-full';
                  const relationship =
                    node.key === 'escalated_remaining'
                      ? ', equal to Escalated minus Closed by human; this is not the Open cases count'
                      : '';
                  const labelClassName = cn(
                    'absolute -translate-y-1/2 whitespace-nowrap rounded-[3px] bg-card/95 px-1.5 py-1 text-left font-medium text-foreground',
                    node.total === 0 && 'text-muted-foreground',
                    wideInspection ? 'text-sm' : 'text-xs',
                    translateX,
                  );
                  const labelStyle: React.CSSProperties = {
                    left: `${(labelX / simpleLayout.width) * 100}%`,
                    top: `${(node.labelY / simpleLayout.height) * 100}%`,
                  };
                  const labelContent = (
                    <>
                      <span>{node.label}</span>
                      <span className="ml-1 font-mono font-semibold tabular-nums">
                        · {fmtNumber(node.total)}
                      </span>
                    </>
                  );
                  if (view === 'detailed') {
                    return (
                      <div
                        key={node.key}
                        data-flow-label={node.key}
                        className={labelClassName}
                        style={labelStyle}
                        aria-hidden
                      >
                        {labelContent}
                      </div>
                    );
                  }
                  const control = (
                    <button
                      type="button"
                      data-flow-label={node.key}
                      aria-label={`${node.label}: ${fmtNumber(node.total)} case${node.total === 1 ? '' : 's'}${relationship}.`}
                      onClick={() => {
                        setFocusedStage(stageKey);
                        if (node.rowKey) onStageClick?.(node.rowKey);
                      }}
                      onPointerEnter={() => setHoveredStage(stageKey)}
                      onPointerLeave={() => setHoveredStage(null)}
                      onFocus={() => setFocusedStage(stageKey)}
                      onBlur={() => setFocusedStage(null)}
                      className={cn(
                        'pointer-events-auto',
                        'transition-colors duration-fast ease-standard hover:bg-popover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        row ? 'active:bg-accent/70' : 'cursor-help',
                        labelClassName,
                      )}
                      style={labelStyle}
                    >
                      {labelContent}
                    </button>
                  );

                  if (!row) return <React.Fragment key={node.key}>{control}</React.Fragment>;
                  const baseReference =
                    row.key === 'auto_cleared' ||
                    row.key === 'policy_closed' ||
                    row.key === 'escalated'
                      ? rowByKey.get('cases') ?? null
                      : row.key === 'closed'
                        ? rowByKey.get('escalated') ?? null
                        : row.key === 'cases'
                          ? rowByKey.get('clustered') ?? null
                          : null;
                  return (
                    <HoverCard key={node.key} openDelay={80} closeDelay={60}>
                      <HoverCardTrigger asChild>{control}</HoverCardTrigger>
                      <HoverCardContent side="top" align="center" className="w-72">
                        <StageHoverContent
                          row={row}
                          topReference={relativeTo}
                          baseReference={baseReference}
                        />
                      </HoverCardContent>
                    </HoverCard>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div
          data-testid="noise-stage-rail"
          className={cn(
            'grid grid-cols-2 items-start gap-1 gap-y-3 border-t border-border/60 pt-3 sm:grid-cols-3',
            simpleLayout.valid && simpleLayout.nodes.length > 0
              ? wideInspection
                ? 'hidden'
                : '@[38rem]/noise:hidden'
              : 'lg:grid-cols-4',
          )}
        >
          {chips}
          <button
            type="button"
            onPointerEnter={() => setHoveredStage('escalated_remaining')}
            onPointerLeave={() => setHoveredStage(null)}
            onFocus={() => setFocusedStage('escalated_remaining')}
            onBlur={() => setFocusedStage(null)}
            aria-label={`Not analyst-closed: ${fmtNumber(simpleLayout.remainingEscalated)} cases, equal to Escalated minus Closed by human; this is not the Open cases count.`}
            aria-describedby={topologyDescriptionId}
            className={cn(
              'flex w-full cursor-help flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              flat ? 'items-start px-3 py-1 text-left' : 'items-center px-1 py-1.5 text-center',
            )}
          >
            <span
              className={cn(
                'max-w-full text-2xs font-medium leading-tight',
                flat
                  ? 'min-h-7 w-full text-left uppercase tracking-wider text-muted-foreground'
                  : 'text-foreground',
              )}
            >
              Not analyst-closed
            </span>
            <span className={cn('flex items-baseline gap-1', flat && 'w-full justify-start')}>
              <CountUp
                value={simpleLayout.remainingEscalated}
                duration={animate ? undefined : 0}
                className={cn(
                  'font-semibold tabular-nums text-foreground',
                  flat ? 'font-mono text-xl' : 'text-sm',
                )}
              />
              <span className={cn('tabular-nums text-muted-foreground', flat ? 'text-xs' : 'text-2xs')}>
                {formatShare(
                  escalatedRow && escalatedRow.total > 0
                    ? (simpleLayout.remainingEscalated / escalatedRow.total) * 100
                    : 0,
                )}
              </span>
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Filled ribbons show the alert → cluster → case reduction. Thickness uses a
            compressed display scale; labels are the exact counts and units.
          </p>
          {validOpenCases ? (
            <button
              type="button"
              onClick={onOpenCasesClick}
              disabled={!onOpenCasesClick}
              data-testid="noise-open-cases"
              data-partial={validOpenCases.partial ? 'true' : 'false'}
              aria-label={`${validOpenCases.partial ? 'At least ' : ''}${fmtNumber(validOpenCases.count)} open cases in the selected window${validOpenCases.count > 0 ? ', review active cases' : ', queue clear'}.`}
              className={cn(
                'ml-auto inline-flex min-h-8 items-center gap-2 rounded-[3px] border px-2.5 py-1.5 text-left text-xs font-medium transition-colors duration-fast ease-standard',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                validOpenCases.count > 0
                  ? 'border-warning/50 bg-warning/5 text-warning-text hover:bg-warning/10'
                  : 'border-success/40 bg-success/5 text-success-text',
              )}
            >
              <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
                {validOpenCases.count > 0 && animate && !reducedMotion ? (
                  <span
                    key={`${data.generated_at}-open-pulse`}
                    className="noise-open-cases-pulse absolute inset-0 rounded-full border border-warning"
                  />
                ) : null}
                <span
                  className={cn(
                    'relative h-2 w-2 rounded-full',
                    validOpenCases.count > 0 ? 'bg-warning' : 'bg-success',
                  )}
                />
              </span>
              <span>
                <span className="font-mono font-semibold tabular-nums">
                  {validOpenCases.partial ? '≥' : ''}{fmtNumber(validOpenCases.count)}
                </span>{' '}
                open case{validOpenCases.count === 1 ? '' : 's'}
              </span>
              <span className="text-2xs uppercase tracking-wider opacity-80">
                {validOpenCases.count > 0 ? 'Review' : 'Clear'}
              </span>
            </button>
          ) : null}
        </div>

        {candidateRow || dropTotal > 0 ? (
          <p
            className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-2xs leading-relaxed text-muted-foreground"
            data-testid="noise-flow-annotations"
          >
            {candidateRow ? (
              <span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtNumber(candidateRow.total)}
                </span>{' '}
                awaiting review · side cohort from clustering
              </span>
            ) : null}
            {dropTotal > 0 ? (
              <span>
                Excluded before clustering ·{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {fmtNumber(dropSuppressed)}
                </span>{' '}
                suppressed ·{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {fmtNumber(dropIgnored)}
                </span>{' '}
                ignored
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <section
        className={cn(
          flat ? 'min-w-0 bg-transparent' : 'min-w-0 rounded-lg border border-border bg-card p-4',
          className,
        )}
        role="group"
        aria-label={ariaLabel ?? 'Noise reduction funnel'}
        aria-describedby={topologyDescriptionId}
        data-testid="noise-funnel"
      >
        <p id={topologyDescriptionId} className="sr-only">
          {view === 'detailed'
            ? 'Alerts move through clustering into opened cases. Auto-cleared and Escalated partition opened cases. Closed by human is a subset of Escalated. The graph is directional context; the labelled counts and percentages are authoritative.'
            : 'Alerts move through clustering into opened cases as filled, tapered ribbons. Alerts, clusters, and cases are different units, and ribbon thickness uses a compressed display scale; labels are the exact values. Auto-cleared, optional analyst-policy closes, and Escalated partition opened cases. Closed by human is a subset of Escalated. Not analyst-closed is the remaining conserved complement, while Open cases is a separate current lifecycle count.'}
        </p>
        <Header
          hidden={hidden}
          onToggleHidden={onToggleHidden}
          onExpand={expandable ? () => setExpanded(true) : undefined}
          flat={flat}
          view={view}
          onViewChange={setView}
        />

        {hidden ? null : view === 'detailed' ? legacyDetailedView : simpleFlowView}
      </section>

      {expandable ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            className="h-[min(92dvh,960px)] w-[min(96dvw,1800px)] max-w-none gap-0 overflow-hidden rounded-[6px] p-0"
            data-testid="noise-funnel-expanded"
          >
            <DialogHeader className="border-b border-border px-6 py-5">
              <DialogTitle>Noise reduction flow · Last {data.window_hours} hours</DialogTitle>
              <DialogDescription>
                Wide selected-window flow with aggregate volume above and inspectable redacted case lineages below.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto px-6 py-5">
              <div className="min-w-[960px]">
                <NoiseFunnel
                  data={data}
                  animate={false}
                  ariaLabel="Expanded noise reduction funnel"
                  onStageClick={onStageClick}
                  variant="flat"
                  wideInspection
                  openCases={validOpenCases ?? undefined}
                  onOpenCasesClick={onOpenCasesClick}
                  view={view}
                  onViewChange={setView}
                />
              </div>
              <div className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                <p>{coverageNote}</p>
                <p className="mt-1">
                  Aggregate counters represent all ingested alerts. Raw identifiers and payloads are intentionally excluded.
                </p>
              </div>
              <NoiseLineageView
                data={lineage}
                loading={lineageLoading}
                error={lineageError}
                onRetry={() => void loadLineage()}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default NoiseFunnel;
