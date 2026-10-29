/**
 * Case-mix widgets (Round 5 / G7; Round 14, SPEC §4.4.3):
 *
 * - `chart.verdict_mix` "Cases by verdict": the board window's cases by AI verdict, as
 *   ranked bars with each verdict's share of the window, from the exact breakdown (the
 *   Round 5 widget read the all-time `/api/metrics` counts under a window caption).
 * - `chart.autonomous_vs_human` "Human vs AI": the window's closed cases split by who
 *   closed them (the AI agent, a person, or the system), over one stacked column per
 *   arrival bucket. It is the Cyber Defence Center's card, so the agent is blue and a
 *   person orange in every chart on every board.
 *
 * The three-band partition is read straight off the server (never `terminal - auto`,
 * which folds the system residual into analyst work). Labels are plain text (#9);
 * advisory only (#3).
 */
import * as React from 'react';

import { Panel } from '@/design-system/panel';
import { cn } from '@/lib/cn';
import { fmtNumber, humanizeToken } from '@/lib/format';
import type { MetricsTrends } from '@/lib/types';
import type { MetricsBreakdown } from '@/lib/types-dashboards';
import type { BarListItem } from '@/soc/components/BarList';
import { type DonutSegment } from '@/soc/components/charts';
import { HumanVsAiCard, type HumanVsAiPoint, type HumanVsAiTotals } from '@/soc/components/HumanVsAiCard';
import { token } from '@/soc/components/palette';
import type { PostureResponse } from '@/soc/pages/Metrics.posture.api';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import {
  StaleNote,
  WidgetFrameContext,
  WidgetShell,
  WidgetStateView,
  countOf,
  requestState,
  resolveTitle,
  shareOf,
  staleOf,
  type WidgetProps,
} from './common';
import { RankedBars } from './panel-table';
import { trendsGap, trendsSplitReported } from './trends-data';

// Map a verdict key to a BarList token color class so TP reads critical, FP neutral.
const VERDICT_BAR: Record<string, string> = {
  TRUE_POSITIVE: 'bg-critical',
  FALSE_POSITIVE: 'bg-info',
  NEEDS_HUMAN: 'bg-warning',
};

const VERDICT_WORDS: Record<string, string> = {
  TRUE_POSITIVE: 'True positive',
  FALSE_POSITIVE: 'False positive',
  NEEDS_HUMAN: 'Needs human',
};

/** The board-window cases by AI verdict (the exact breakdown, never the all-time metrics). */
export const VERDICT_MIX_REQUEST: DashboardRequest = { key: 'breakdown', query: { by: 'verdict' } };

/** The ranked bars of a verdict breakdown, each with its share of the window's cases. */
export function verdictMixItems(b: MetricsBreakdown): BarListItem[] {
  const total = b.total > 0 ? b.total : 0;
  return b.groups
    .filter((g) => g.then_key == null && g.bucket == null && g.count > 0)
    .sort((x, y) => y.count - x.count)
    .map((g) => {
      const key = g.key ?? '';
      // The board's one share rule: "<1%" for a real but tiny share, ">99%" short of all.
      const pct = shareOf(g.count, total);
      return {
        label: key ? (VERDICT_WORDS[key] ?? humanizeToken(key)) : 'No verdict yet',
        value: g.count,
        color: VERDICT_BAR[key] ?? 'bg-muted-foreground/40',
        sub: pct ? `${pct} of the window's cases` : undefined,
      };
    });
}

// --------------------------------------------------------------------------- //
// Cases by verdict: ranked bars of the window's cases by AI verdict.
// --------------------------------------------------------------------------- //
export function VerdictMixWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Cases by verdict');
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest(VERDICT_MIX_REQUEST as DashboardRequest & { key: 'breakdown' });
  const b = answer.data;
  const onRetry = () => retry(VERDICT_MIX_REQUEST);
  let state = requestState(answer, onRetry);
  if (!state && b && b.total === 0) state = { kind: 'empty', title: `No cases in the ${windowInfo.phrase}` };
  const items = b ? verdictMixItems(b) : [];
  return (
    <WidgetShell
      title={title}
      caption={`${windowInfo.label} · AI verdicts${b ? ` · ${b.partial ? 'at least ' : ''}${countOf(b.total, 'case')}` : ''}`}
      exit={{ label: 'View cases', page: 'cases' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={b?.partial ? `Part of the cases could not be read${b.partial_reason ? `: ${b.partial_reason.replace(/\.$/, '')}` : ''}.` : undefined}
    >
      <RankedBars label={title} items={items} format={fmtNumber} />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Close attribution: of the RESOLVED (terminal) cases, who was the LAST decider.
// Read straight off the server posture QUALITY rollup's three-way partition; never
// client-derived, and never a two-way split (see `autonomySegments`).
// --------------------------------------------------------------------------- //

/** The posture-quality fields this split reads (a subset of `PostureQuality`). */
export interface AutonomyQuality {
  terminal_cases?: number;
  auto_closed_cases?: number;
  human_closed_cases?: number;
  system_closed_cases?: number;
}

/**
 * Does this posture payload actually REPORT close attribution?
 *
 * The three-band partition is optional on the wire: an older backend omits
 * `human_closed_cases`/`system_closed_cases`, and that absence means "not reported",
 * never zero. Separated from {@link autonomySegments} so the widget can say which of
 * "no closed cases" and "this backend does not report attribution" is true, instead of
 * printing the first when it means the second.
 *
 * This answers only "are the four keys present?". Whether they FORM a partition is
 * {@link closeAttributionState}'s job; the two questions have different answers and
 * conflating them is what let a non-reconciling payload print "nothing closed".
 */
export function hasCloseAttribution(q: AutonomyQuality | null | undefined): boolean {
  if (!q) return false;
  return (
    typeof q.terminal_cases === 'number' &&
    typeof q.auto_closed_cases === 'number' &&
    typeof q.human_closed_cases === 'number' &&
    typeof q.system_closed_cases === 'number'
  );
}

/** Which fact about close attribution this payload actually establishes. */
export type CloseAttributionState =
  /** No payload at all: the rollup could not be read. */
  | 'unreadable'
  /** The payload omits one or more of the four bands: not reported, never zero. */
  | 'unreported'
  /** All four present, but they are not a partition (or a band is negative/non-finite). */
  | 'unreconciled'
  /** A reconciling partition of ZERO terminal cases: nothing closed in this window. */
  | 'empty'
  /** A reconciling partition of one or more terminal cases: renderable. */
  | 'ok';

/**
 * The ONE classifier both the donut and its empty line consume.
 *
 * {@link autonomySegments} and {@link autonomyEmptyMessage} used to test different
 * things (presence-of-keys in one, reconciliation in the other), so a REPORTED but
 * non-reconciling payload rendered no arcs AND claimed "No resolved cases in this
 * window.", i.e. the widget published a measurement of zero off a payload that said
 * ten. Routing both through this function makes that disagreement unrepresentable.
 */
export function closeAttributionState(
  q: AutonomyQuality | null | undefined,
): CloseAttributionState {
  if (!q) return 'unreadable';
  if (!hasCloseAttribution(q)) return 'unreported';
  const terminal = Number(q.terminal_cases);
  const ai = Number(q.auto_closed_cases);
  const human = Number(q.human_closed_cases);
  const system = Number(q.system_closed_cases);
  if ([terminal, ai, human, system].some((n) => !Number.isFinite(n) || n < 0)) {
    return 'unreconciled';
  }
  if (ai + human + system !== terminal) return 'unreconciled';
  return terminal === 0 ? 'empty' : 'ok';
}

/**
 * Build the close-attribution donut segments from the posture quality rollup.
 *
 * THREE arcs, never two. This used to compute `human = terminal − auto`, which
 * `engine/metrics.py` explicitly forbids: the difference absorbs the SYSTEM/legacy
 * residual (deterministic routing plus older records that never recorded a decider)
 * into the analyst band, over-stating human work by exactly that residual, and it
 * labelled the result "Human-handled", so the over-statement was invisible. The server
 * publishes `auto_closed_cases` + `human_closed_cases` + `system_closed_cases`, which
 * sum to `terminal_cases` exactly; this reads all three keys or renders nothing.
 *
 * All three are returned even at zero, so the residual stays part of the partition;
 * `DonutChart` drops empty arcs itself, and the centre total therefore still equals
 * `terminal_cases`. A payload whose bands do not reconcile is not a partition and is
 * refused outright rather than massaged. Colours are the `HumanVsAiCard` bands' own
 * colourblind-safe categorical ramp: an "AI vs human" split must not borrow a
 * red/green severity reading.
 */
export function autonomySegments(q: AutonomyQuality | null | undefined): DonutSegment[] {
  // Not a partition → not renderable as one, and an all-zero terminal cohort is an
  // empty window rather than a donut of nothing. Both refusals come from the shared
  // classifier so the empty line below can name WHICH refusal happened.
  if (closeAttributionState(q) !== 'ok') return [];
  return [
    { label: 'AI agent', value: Number(q?.auto_closed_cases), color: token('chart-1') },
    { label: 'Human', value: Number(q?.human_closed_cases), color: token('chart-2') },
    { label: 'System', value: Number(q?.system_closed_cases), color: token('chart-8') },
  ];
}

/**
 * The widget's honest empty line. "Not reported", "could not be read", "did not
 * reconcile" and "nothing closed" are FOUR different facts; printing the last when one
 * of the first three is true turns a gap in evidence into a measurement.
 *
 * Every arm below reads {@link closeAttributionState}, the same classifier
 * {@link autonomySegments} refuses on, so the message can never disagree with the
 * reason the donut is blank.
 */
export function autonomyEmptyMessage(
  q: AutonomyQuality | null | undefined,
  segmentCount: number,
  opts: { loading: boolean; failed: boolean },
): string | undefined {
  if (opts.failed) return 'Posture data unavailable';
  if (opts.loading || segmentCount > 0) return undefined;
  switch (closeAttributionState(q)) {
    case 'unreadable':
      return 'Posture data unavailable';
    case 'unreported':
      return 'This backend does not report how closed cases were attributed.';
    case 'unreconciled':
      // The same wording `Overview.tsx` uses for this payload, so the two surfaces
      // describe one fact identically.
      return 'Close attribution did not reconcile for this window.';
    case 'empty':
      // The ONLY arm that is a measurement: the four bands reconcile, and they are all
      // zero. Everything above is an evidence gap.
      return 'No resolved cases in this window.';
    default:
      // 'ok': arcs are renderable, so there is nothing to say. (Reachable only if a
      // caller passes a `segmentCount` that disagrees with `autonomySegments`.)
      return undefined;
  }
}

/** The window's close partition from the posture rollup, or null when it does not reconcile. */
export function humanVsAiTotals(posture: PostureResponse | null | undefined): HumanVsAiTotals | null {
  const q = posture?.quality;
  if (closeAttributionState(q) === 'unreadable' || closeAttributionState(q) === 'unreported') return null;
  if (closeAttributionState(q) === 'unreconciled') return null;
  // A store outage answers structural zeros with both completeness flags false: zero
  // because unreadable is no measurement.
  if (posture?.window_covered === false && posture?.open_now?.complete === false) return null;
  return {
    ai: Number(q?.auto_closed_cases),
    human: Number(q?.human_closed_cases),
    system: Number(q?.system_closed_cases),
    closed: Number(q?.terminal_cases),
  };
}

/**
 * A bucket's tick label in the chart kit's one day format, in UTC (the card says so):
 * "Oct 28" for a day, "Oct 28 06:00" for an hour on a board longer than a day, "06:00"
 * for an hour within one day.
 */
export function humanVsAiTick(startMs: number, bucketMinutes: number, windowHours: number): string {
  const d = new Date(startMs);
  if (!Number.isFinite(d.getTime())) return '';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const hour = d.toISOString().slice(11, 16);
  if (bucketMinutes >= 1440) return day;
  return windowHours > 24 ? `${day} ${hour}` : hour;
}

/** One stacked column per trends bucket, or null when the server does not split closers. */
export function humanVsAiSeries(trends: MetricsTrends | null | undefined): HumanVsAiPoint[] | null {
  if (!trends || !trendsSplitReported(trends.buckets)) return null;
  const bucketMinutes = Number(trends.bucket_minutes) || 0;
  const bucketMs = bucketMinutes * 60_000;
  const generatedMs = Date.parse(String(trends.generated_at ?? ''));
  const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return trends.buckets.map((b, i) => {
    const startMs = Date.parse(String(b.t ?? ''));
    const endMs = Number.isFinite(startMs) && bucketMs > 0 ? startMs + bucketMs : Number.NaN;
    const iso = Number.isFinite(startMs) ? new Date(startMs).toISOString() : '';
    const x = iso ? humanVsAiTick(startMs, bucketMinutes, Number(trends.window_hours) || 0) : String(b.t ?? '');
    return {
      x,
      ai: finite(b.auto_closed),
      human: finite(b.human_closed),
      system: finite(b.system_closed),
      start: iso || null,
      end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
      closed: finite(b.closed),
      newCases: finite(b.new_cases),
      sentToHuman: finite(b.sent_to_human),
      fpRate: finite(b.fp_rate),
      alerts: finite(b.alerts),
      inProgress: Number.isFinite(endMs) && Number.isFinite(generatedMs) ? endMs > generatedMs : i === trends.buckets.length - 1,
    };
  });
}

const POSTURE_REQ: DashboardRequest = { key: 'posture' };
const TRENDS_REQ: DashboardRequest = { key: 'trends' };

export function AutonomousVsHumanWidget(props: WidgetProps) {
  const mode = React.useContext(WidgetFrameContext);
  const { windowInfo, windowHours, retry } = useDashboardData();
  const postureAnswer = useDashboardRequest({ key: 'posture' });
  const trendsAnswer = useDashboardRequest({ key: 'trends' });
  const posture = postureAnswer.data;
  const trends = trendsAnswer.data;
  const totals = humanVsAiTotals(posture);
  // A trends answer clamped below the board window would mislabel the columns.
  const series = trends && !trendsGap(trends, windowHours) ? humanVsAiSeries(trends) : null;
  const truncated = posture?.window_covered === false || trends?.truncated === true;
  const bucket = trends && !trendsGap(trends, windowHours) ? Number(trends.bucket_minutes) : null;
  const bucketText = bucket === 60 ? '1h buckets' : bucket === 1440 ? 'daily buckets' : bucket ? `${bucket / 60}h buckets` : null;
  const title = resolveTitle(props, 'Human vs AI');
  // The close partition is the card's spine: until it is read the panel shows the shared
  // skeleton, and a failed read is the shared LoadError with Retry (posture and trends
  // both, the two reads the card joins), never a "no trend yet" line beside an error.
  const retryBoth = () => {
    retry(POSTURE_REQ);
    retry(TRENDS_REQ);
  };
  const postureState = requestState(postureAnswer, retryBoth);
  // Figures kept through a failed refresh of either read the card joins.
  const stale = postureState ? null : staleOf([postureAnswer, trendsAnswer], retryBoth);
  const edit = mode === 'edit';
  return (
    <Panel
      as="div"
      // In a fixed edit-mode cell the panel fills the cell and its content scrolls inside
      // it, so a short cell never cuts the chart or its notes off.
      className={cn('flex h-full flex-col', edit && 'min-h-0 overflow-hidden')}
      data-widget-human-vs-ai=""
    >
      <div
        className={cn('flex min-w-0 flex-1 flex-col', edit && 'min-h-0 overflow-auto')}
        data-widget-scroll={edit ? '' : undefined}
      >
        {postureState ? (
          <>
            <h2 className="mb-3 text-base font-semibold text-foreground">{title}</h2>
            <WidgetStateView state={postureState} title={title} />
          </>
        ) : (
          <>
            <HumanVsAiCard
              totals={totals}
              unavailableReason={
                closeAttributionState(posture?.quality) === 'unreconciled'
                  ? 'Close attribution did not reconcile for this window.'
                  : 'Close attribution is not reported for this window.'
              }
              series={series}
              windowLabel={[windowInfo.label, bucketText].filter(Boolean).join(' · ')}
              truncated={truncated}
              // `flex-1` (a zero basis) rather than a full height, so the stale line
              // under the card keeps its room.
              className="w-full flex-1"
            />
            {stale ? <StaleNote stale={stale} className="mb-0 mt-3" /> : null}
          </>
        )}
      </div>
    </Panel>
  );
}
