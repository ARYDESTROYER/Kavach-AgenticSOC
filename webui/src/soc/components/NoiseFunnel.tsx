/**
 * NoiseFunnel — the "Noise Reduction" flow ribbon for the Security Command Center
 * (restored from the Round-8 horizontal-Sankey ribbon, then tuned as an
 * operational instrument rather than a decorative illustration).
 *
 * Tells the value-prop story of how the agent thins raw alert volume down to the
 * handful of cases a human sees, as a left-to-right flow:
 *
 *     ingested → clustered → cases → { auto_cleared | escalated → closed }
 *
 * The processing spine is intentionally one quiet, proportional stream. Severity is
 * evidence about each stage (available in the stage detail), not a second competing
 * visual encoding. At `cases`, the stream fans into the three terminal operational
 * views: auto-cleared and escalated are the conserved split; closed by a human is an
 * overlapping subset of escalated. The labelled count/share rail is authoritative;
 * the restored ribbon fan provides directional context for the operator.
 *
 * Binds VERBATIM to the §D `GET /api/metrics/noise-reduction` contract (the
 * `NoiseReduction` type). When the durable ingest counters are still warming up
 * (`counters.available === false`) it degrades gracefully to a case-only funnel.
 *
 * #9: every value shown is an aggregate count or a fixed stage label (no raw log
 * text), rendered as plain text — UNTRUSTED-safe by construction. Colours resolve
 * from approved theme/semantic tokens only (no raw hex; design gate). The SVG flow is
 * decorative (`aria-hidden`); ALL meaning is carried by the focusable stage
 * buttons/groups in the label rail, so assistive tech gets the numbers, not the
 * beziers. Reduced-motion is honoured globally (theme.css neutralises the keyframes).
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
export const NOISE_FUNNEL_HELP_TEXT =
  'How the agent reduces raw alert volume: received alerts move through clustering, a ' +
  'fraction become cases, and opened cases split into false-positive auto-clear or the ' +
  'escalated analyst path. Closed by human is a subset of that escalated path, not a ' +
  'third partition. Counts and percentages in the aligned rail are authoritative; ' +
  'hover or focus any stage for its evidence.';

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
/* Sankey geometry.                                                            */
/* ------------------------------------------------------------------------- */

/** Fixed-aspect viewBox (~2.9:1). Stretch-scaled to the dashboard band. */
const VB_W = 640;
const VB_H = 220;
/**
 * The flat dashboard has useful whitespace before the first centered stage column.
 * Reclaim a small part of it for the decorative plot only. The offset tapers to zero
 * at the final node, so the right edge stays fixed and the labelled rail never moves.
 */
const FLAT_PLOT_LEFT_EXTENSION = 14;
/** Vertical center + the plot band the strands live in. */
const CY = VB_H / 2;
const PLOT_PAD = 24;
const PLOT_H = VB_H - PLOT_PAD * 2;
/** Thin square-ended anchors + the vertical splay of the three outcomes. */
const NODE_W = 5;
const OUTCOME_SPREAD = 58;

/** Exact proportional spine height: visual area never overstates survivor volume. */
function spineNodeHeight(total: number, topTotal: number): number {
  if (total <= 0) return 0;
  const prop = topTotal > 0 ? Math.min(1, total / topTotal) : 0;
  return PLOT_H * prop;
}

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
interface Ribbon {
  id: string;
  path: string;
  colorName: string;
  kind: 'flow' | 'outcome';
  sourceKey: string;
  targetKey: string;
}
interface Badge {
  leftPct: number;
  topPct: number;
  drop: number;
  pct: number;
}
interface Layout {
  ribbons: Ribbon[];
  rects: Rect[];
  badges: Badge[];
  spurPath: string | null;
  spurNub: { x: number; y: number } | null;
  spurChip: { leftPct: number; topPct: number } | null;
}

/** One processing-spine node's exact proportional vertical extent. */
interface SpineGeom {
  row: FunnelRow;
  index: number;
  x: number;
  top: number;
  bottom: number;
  h: number;
}

/**
 * Build one aggregate processing stream (ingested → clustered → cases), the
 * three-outcome fan, exact proportional anchors, direct loss annotations, and the
 * suppressed/ignored side-spur. Severity remains in the stage evidence instead of
 * becoming five competing flow colours.
 */
function buildLayout(
  derived: DerivedFunnel,
  drops: { suppressed: number; ignored: number },
  uid: string,
  leftExtension = 0,
): Layout {
  const rows = derived.rows;
  const n = rows.length;
  const candidateKeys = new Set(['candidate', 'awaiting']);
  const spineEntries = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row.isOutcome && !candidateKeys.has(row.key));
  const topTotal = derived.topTotal;
  const colCenter = (i: number) => {
    const count = Math.max(1, n);
    const canonical = (VB_W * (i + 0.5)) / count;
    if (leftExtension <= 0) return canonical;
    const progress = count <= 1 ? 0 : i / (count - 1);
    return canonical - leftExtension * (1 - progress);
  };

  const rects: Rect[] = [];
  const ribbons: Ribbon[] = [];
  const badges: Badge[] = [];

  // --- one quiet processing spine, centered and exactly proportional ---
  const spine: SpineGeom[] = [];
  for (const { row, index } of spineEntries) {
    const x = colCenter(index);
    const h = spineNodeHeight(row.total, topTotal);
    const top = CY - h / 2;
    if (h > 0) {
      rects.push({
        key: row.key,
        x: x - NODE_W / 2,
        y: top,
        w: NODE_W,
        h,
        fill: token('primary'),
      });
    }
    spine.push({ row, index, x, top, bottom: top + h, h });
  }

  // --- aggregate stream between consecutive processing stages ---
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    if (a.h > 0 && b.h > 0) {
      ribbons.push({
        id: `${uid}-flow-${i}`,
        path: ribbonPath(
          a.x + NODE_W / 2,
          a.top,
          a.bottom,
          b.x - NODE_W / 2,
          b.top,
          b.bottom,
        ),
        colorName: 'primary',
        kind: 'flow',
        sourceKey: a.row.key,
        targetKey: b.row.key,
      });
    }

    // drop-off badge on this connector.
    const drop = Math.max(0, a.row.total - b.row.total);
    if (drop > 0) {
      badges.push({
        leftPct: ((a.x + b.x) / 2 / VB_W) * 100,
        topPct: (10 / VB_H) * 100,
        drop,
        pct: a.row.total > 0 ? Math.round((drop / a.row.total) * 100) : 0,
      });
    }
  }

  // Candidate/awaiting review is an optional side cohort from clustering, not a
  // required parent of opened cases. Keep it discoverable without changing the
  // restored primary processing spine.
  const candidateEntry = rows
    .map((row, index) => ({ row, index }))
    .find(({ row }) => candidateKeys.has(row.key));
  const clusteredNode = spine.find((node) => node.row.key === 'clustered');
  if (candidateEntry && clusteredNode && candidateEntry.row.total > 0) {
    const x = colCenter(candidateEntry.index);
    const h = spineNodeHeight(candidateEntry.row.total, topTotal);
    const top = VB_H - PLOT_PAD - h;
    rects.push({
      key: candidateEntry.row.key,
      x: x - NODE_W / 2,
      y: top,
      w: NODE_W,
      h,
      fill: token('muted-foreground'),
    });
    const sourceH = Math.min(clusteredNode.h, h);
    ribbons.push({
      id: `${uid}-candidate`,
      path: ribbonPath(
        clusteredNode.x + NODE_W / 2,
        clusteredNode.bottom - sourceH,
        clusteredNode.bottom,
        x - NODE_W / 2,
        top,
        top + h,
      ),
      colorName: 'muted-foreground',
      kind: 'flow',
      sourceKey: clusteredNode.row.key,
      targetKey: candidateEntry.row.key,
    });
  }

  // --- outcome nodes (splayed) + the verdict fan out of the last spine node ---
  const outcomes = rows.filter((row) => row.isOutcome);
  const casesNode = spine.find((node) => node.row.key === 'cases');
  const casesTotal = derived.casesTotal;
  const casesH = casesNode ? casesNode.h : 0;
  // The visible outcomes are OVERLAPPING terminal views of `cases`, not a strict
  // partition, so their source-side shares can sum past 1.0. Normalize the common
  // source slices to avoid overflow. Each outcome anchor keeps its true share-based
  // height; only the shared source fan is normalized.
  const shareSum = outcomes.reduce(
    (a, r) => a + (casesTotal > 0 && r.total > 0 ? r.total / casesTotal : 0),
    0,
  );
  const srcScale = shareSum > 1 ? 1 / shareSum : 1;
  let sliceCursor = casesNode ? casesNode.top : CY;
  outcomes.forEach((row, m) => {
    const oi = rows.findIndex((candidate) => candidate.key === row.key);
    const x = colCenter(oi);
    const share = casesTotal > 0 ? row.total / casesTotal : 0;
    const h = row.total > 0 ? share * casesH : 0;
    const yc =
      outcomes.length > 1
        ? CY - OUTCOME_SPREAD + (2 * OUTCOME_SPREAD * m) / (outcomes.length - 1)
        : CY;
    const top = yc - h / 2;
    const colorName = OUTCOME_TOKEN[row.key] ?? 'primary';
    if (h > 0) {
      rects.push({
        key: row.key,
        x: x - NODE_W / 2,
        y: top,
        w: NODE_W,
        h,
        fill: token(colorName),
      });
    }

    // Fan ribbon: a proportional (source-normalized) slice of the cases node → this outcome.
    if (casesNode && casesH > 0 && row.total > 0) {
      const sliceH = share * casesH * srcScale;
      const s0 = sliceCursor;
      const s1 = sliceCursor + sliceH;
      sliceCursor = s1;
      ribbons.push({
        id: `${uid}-o${m}`,
        path: ribbonPath(casesNode.x + NODE_W / 2, s0, s1, x - NODE_W / 2, top, top + h),
        colorName,
        kind: 'outcome',
        sourceKey: casesNode.row.key,
        targetKey: row.key,
      });
    }
  });

  // --- suppressed/ignored side-spur (peels down before clustering) ---
  const dropTotal = (drops.suppressed ?? 0) + (drops.ignored ?? 0);
  let spurPath: string | null = null;
  let spurNub: { x: number; y: number } | null = null;
  let spurChip: { leftPct: number; topPct: number } | null = null;
  if (dropTotal > 0 && spine.length >= 2 && spine[0].h > 0) {
    const sx = spine[0].x;
    const sy = spine[0].bottom - spine[0].h * 0.25;
    const nubX = (spine[0].x + spine[1].x) / 2;
    const nubY = VB_H - 12;
    spurPath = `M${sx},${sy} C${(sx + nubX) / 2},${sy} ${nubX},${nubY - 24} ${nubX},${nubY}`;
    spurNub = { x: nubX, y: nubY };
    spurChip = { leftPct: (nubX / VB_W) * 100, topPct: ((nubY - 4) / VB_H) * 100 };
  }

  return { ribbons, rects, badges, spurPath, spurNub, spurChip };
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
}

function Header({
  hidden,
  onToggleHidden,
  onExpand,
  flat,
}: {
  hidden?: boolean;
  onToggleHidden?: () => void;
  onExpand?: () => void;
  flat?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h3
          className={cn(
            'font-semibold text-foreground',
            flat ? 'text-2xs uppercase tracking-widest' : 'text-sm',
          )}
        >
          {flat ? 'Noise reduction flow' : 'Noise reduction'}
        </h3>
        <HelpTip label="What the noise-reduction funnel means" text={NOISE_FUNNEL_HELP_TEXT} />
      </div>
      <div className="flex items-center gap-1">
        {onExpand && !hidden ? (
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand noise reduction flow"
            className={cn(
              'inline-flex min-h-7 items-center justify-center gap-1.5 rounded-[3px] border border-border px-2 text-2xs font-medium text-muted-foreground transition-colors',
              'hover:bg-hover hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Expand</span>
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
}: NoiseFunnelProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [hoveredStage, setHoveredStage] = React.useState<string | null>(null);
  const [focusedStage, setFocusedStage] = React.useState<string | null>(null);
  const activeStage = focusedStage ?? hoveredStage;
  const [lineage, setLineage] = React.useState<NoiseLineage | null>(null);
  const [lineageLoading, setLineageLoading] = React.useState(false);
  const [lineageError, setLineageError] = React.useState<string | null>(null);
  const lineageRequest = React.useRef(0);
  const rawUid = React.useId();
  const uid = React.useMemo(() => rawUid.replace(/[^a-zA-Z0-9_-]/g, ''), [rawUid]);
  const topologyDescriptionId = `${uid}-topology`;
  const derived = React.useMemo(() => (data ? deriveFunnel(data) : null), [data]);
  const flat = variant === 'flat';
  const dropSuppressed = data?.drops?.suppressed ?? 0;
  const dropIgnored = data?.drops?.ignored ?? 0;
  const layout = React.useMemo(
    () =>
      derived
        ? buildLayout(
            derived,
            { suppressed: dropSuppressed, ignored: dropIgnored },
            uid,
            flat ? FLAT_PLOT_LEFT_EXTENSION : 0,
          )
        : null,
    [derived, dropSuppressed, dropIgnored, uid, flat],
  );
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
  if (!data || !derived || !layout) return null;

  const overall = data.reduction?.overall_pct;
  const headlinePct = typeof overall === 'number' ? overall : null;
  const degradedNote =
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : 'Reduction pending';
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';
  const n = derived.rows.length;
  const closedByHuman = derived.rows.find((r) => r.key === 'closed')?.total ?? 0;
  const rowByKey = new Map(derived.rows.map((row) => [row.key, row]));

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
    const relationship =
      row.key === 'closed'
        ? 'This is a subset of Escalated, not an additional case partition.'
        : row.key === 'auto_cleared'
          ? 'Together with Escalated, this partitions opened cases.'
          : row.key === 'escalated'
            ? 'Together with Auto-cleared, this partitions opened cases; human closure is a subset of this stage.'
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
      row.key === 'auto_cleared' || row.key === 'escalated'
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

  const gridStyle: React.CSSProperties | undefined =
    flat && !wideInspection
      ? undefined
      : { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const flatGridColumns =
    n === 4 ? 'lg:grid-cols-4' : n === 7 ? 'lg:grid-cols-7' : 'lg:grid-cols-6';
  const dropTotal = dropSuppressed + dropIgnored;

  const coverageNote = !data.counters?.available
    ? 'Durable ingest counters are still warming up, so this view starts at cases opened.'
    : data.counters?.incomplete
      ? 'Durable alert counters cover only part of the selected window.'
      : data.cases_meta?.truncated
        ? `Case stages are partial: ${fmtNumber(data.cases_meta.fetched)} of ${fmtNumber(data.cases_meta.store_total)} matching cases were tallied.`
        : 'Every value is an aggregate for the selected time range.';

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
          Alerts move through clustering into opened cases. Auto-cleared and Escalated
          partition opened cases. Closed by human is a subset of Escalated. The graph is
          directional context; the labelled counts and percentages are authoritative.
        </p>
        <Header
          hidden={hidden}
          onToggleHidden={onToggleHidden}
          onExpand={expandable ? () => setExpanded(true) : undefined}
          flat={flat}
        />

        {hidden ? null : (
          <div className={cn('space-y-3', flat ? 'mt-2' : 'mt-3')}>
          {/* Hero — the value-prop headline + the ingested→human cascade. */}
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
            {/* The proportional flow band is shown at desktop width, where the six
                fixed columns remain legible. The complete evidence rail stays present
                at every width. All meaning is carried by that interactive rail. */}
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
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
                aria-hidden
                focusable="false"
              >
              {/* Matte, exact-width ribbons. No gradients, glow, or decorative growth. */}
              {layout.ribbons.map((r) => {
                const related =
                  !activeStage || r.sourceKey === activeStage || r.targetKey === activeStage;
                return (
                  <path
                    key={r.id}
                    d={r.path}
                    fill={token(r.colorName)}
                    stroke={token(r.colorName)}
                    strokeWidth={0.5}
                    vectorEffect="non-scaling-stroke"
                    data-noise-ribbon
                    data-source-stage={r.sourceKey}
                    data-target-stage={r.targetKey}
                    className="transition-opacity duration-fast ease-standard"
                    style={{
                      fillOpacity: activeStage
                        ? related
                          ? 1
                          : 0.14
                        : r.kind === 'flow'
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

              {/* Suppressed/ignored side-spur. */}
              {layout.spurPath ? (
                <>
                  <path
                    d={layout.spurPath}
                    fill="none"
                    stroke={token('muted-foreground', 0.4)}
                    strokeWidth={1}
                    strokeDasharray="2 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  {layout.spurNub ? (
                    <circle cx={layout.spurNub.x} cy={layout.spurNub.y} r={2.5} fill={token('muted-foreground', 0.7)} />
                  ) : null}
                </>
              ) : null}

              {/* Node anchors on top of the ribbons. */}
              {layout.rects.map((rc) => (
                <rect
                  key={rc.key}
                  data-node-key={rc.key}
                  x={rc.x}
                  y={rc.y}
                  width={rc.w}
                  height={rc.h}
                  rx={0}
                  fill={rc.fill}
                  stroke={rc.fill}
                  strokeWidth={0.5}
                  vectorEffect="non-scaling-stroke"
                  opacity={activeStage && activeStage !== rc.key ? 0.48 : 1}
                  className="transition-opacity duration-fast ease-standard"
                />
              ))}
              </svg>

            {/* HTML overlay (decorative): per-connector drop-off badges + spur chip. */}
              <div className="pointer-events-none absolute inset-0" aria-hidden>
              {layout.badges.map((b, i) => (
                <span
                  key={i}
                  data-loss-annotation
                  className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap px-1 text-2xs font-medium tabular-nums text-muted-foreground"
                  style={{ left: `${b.leftPct}%`, top: `${b.topPct}%` }}
                >
                  −{b.drop} · {b.pct}% filtered
                </span>
              ))}
              {layout.spurChip ? (
                <span
                  className="absolute -translate-x-1/2 whitespace-nowrap px-1 text-2xs tabular-nums text-muted-foreground"
                  style={{ left: `${layout.spurChip.leftPct}%`, top: `${layout.spurChip.topPct}%` }}
                >
                  −{dropTotal} excluded
                </span>
              ) : null}
              </div>
            </div>

          {/* The interactive + labelled rail: one focusable, hover-detailed stage per column. */}
            <div
              data-testid="noise-stage-rail"
              className={cn(
                'grid items-start gap-1',
                flat && 'grid-cols-2 gap-y-3 border-t border-border/60 pt-3 sm:grid-cols-3',
                flat && flatGridColumns,
              )}
              style={gridStyle}
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
        )}
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
