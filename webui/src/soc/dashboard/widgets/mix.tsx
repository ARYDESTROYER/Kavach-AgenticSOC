/**
 * Case-mix dashboard widgets (Round 5 / G7): the verdict/severity bar list and the
 * autonomous-vs-human split donut. Both read the SHARED metrics/posture payload
 * (fetched once) and reuse `BarList` / `DonutChart` — no new charting code. Every
 * label is plain text (#9); layout is advisory (#3).
 */
import * as React from 'react';
import { BarChart3, Bot } from 'lucide-react';

import { BarList, type BarListItem } from '@/soc/components/BarList';
import { DonutChart, type DonutSegment } from '@/soc/components/charts';
import { token } from '@/soc/components/palette';
import { humanizeToken, fmtNumber } from '@/lib/format';

import { useDashboardSource } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetShell, resolveTitle, type WidgetProps } from './common';

// Map a verdict key to a BarList token color class so TP reads critical, FP neutral.
const VERDICT_BAR: Record<string, string> = {
  TRUE_POSITIVE: 'bg-critical',
  FALSE_POSITIVE: 'bg-info',
  NEEDS_HUMAN: 'bg-warning',
  none: 'bg-muted',
};

// --------------------------------------------------------------------------- //
// Open by verdict — a ranked bar list of the verdict breakdown.
// --------------------------------------------------------------------------- //
export function OpenBySeverityWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('metrics');
  const title = resolveTitle(props, 'Cases by verdict');

  const items: BarListItem[] = React.useMemo(() => {
    const bv = data?.by_verdict;
    if (!bv) return [];
    return Object.entries(bv)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label: humanizeToken(k),
        value: v,
        color: VERDICT_BAR[k] ?? 'bg-accent-bar',
      }));
  }, [data]);

  const empty =
    error && !data
      ? 'Metrics unavailable'
      : items.length === 0 && !loading
        ? 'No verdicts recorded in this window.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={BarChart3}
      loading={loading && !data}
      emptyMessage={empty}
    >
      <BarList items={items} format={fmtNumber} showPercent />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Close attribution — of the RESOLVED (terminal) cases, who was the LAST decider.
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
 * {@link closeAttributionState}'s job — the two questions have different answers and
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
  /** No payload at all — the rollup could not be read. */
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
 * things — presence-of-keys in one, reconciliation in the other — so a REPORTED but
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
 * into the analyst band, over-stating human work by exactly that residual — and it
 * labelled the result "Human-handled", so the over-statement was invisible. The server
 * publishes `auto_closed_cases` + `human_closed_cases` + `system_closed_cases`, which
 * sum to `terminal_cases` exactly; this reads all three keys or renders nothing.
 *
 * All three are returned even at zero, so the residual stays part of the partition;
 * `DonutChart` drops empty arcs itself, and the centre total therefore still equals
 * `terminal_cases`. A payload whose bands do not reconcile is not a partition and is
 * refused outright rather than massaged. Colours are the `HumanVsAiCard` bands' own
 * colourblind-safe categorical ramp — an "AI vs human" split must not borrow a
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
      // 'ok' — arcs are renderable, so there is nothing to say. (Reachable only if a
      // caller passes a `segmentCount` that disagrees with `autonomySegments`.)
      return undefined;
  }
}

export function AutonomousVsHumanWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('posture');
  const title = resolveTitle(props, 'Autonomous vs human');

  const segments: DonutSegment[] = React.useMemo(
    () => autonomySegments(data?.quality),
    [data],
  );

  const total = segments.reduce((a, s) => a + s.value, 0);
  const empty = autonomyEmptyMessage(data?.quality, segments.length, {
    loading,
    failed: Boolean(error) && !data,
  });

  return (
    <WidgetShell
      title={title}
      icon={Bot}
      accentClass="text-primary"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <DonutChart
        segments={segments}
        format={fmtNumber}
        center={
          <div className="text-center">
            <div className="text-lg font-semibold tabular-nums">{fmtNumber(total)}</div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">resolved</div>
          </div>
        }
      />
    </WidgetShell>
  );
}
