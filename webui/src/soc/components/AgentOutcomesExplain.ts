/**
 * Agent effectiveness's operational outcomes explained (Round 16 FXD2).
 *
 * Each headline comparison (confirmed-positive share, observed elapsed-time difference,
 * alerts after clustering per day, AI processing cost per case) gets a hover line with
 * its inputs and a click panel that works both windows' figures from their numerator and
 * denominator, then the change between them. The server rounds each figure before it
 * compares them (4 decimals for a share, 1 for minutes, 2 for a per-day count, 6 for
 * dollars), so the panel prints those rounded values: the change worked from them is the
 * change the server sent, and the tile's chip is that change rounded for display.
 *
 * Pure: plain data only (#9). Reporting only: nothing here decides anything (#3).
 */
import { count, plain } from '@/lib/explain/rounding';
import type { Explanation, ExplanationInput, ExplanationStep } from '@/lib/explain/types';
import type {
  AgentAlertVolumeOutcome,
  AgentConfirmedPositiveCaseRateOutcome,
  AgentObservedTimeSavedOutcome,
  AgentRecordedCaseCostOutcome,
} from '@/lib/types';

/** What the tile shows, so the panel ends on the same text. */
export interface OutcomeShown {
  value: string;
  prior: string;
  /** The delta chip's label ("+15.5 min / case"), when the tile shows one. */
  delta?: string;
  /** The two windows in words ("Nov 19 to 25, 2026"). */
  currentWindow: string;
  priorWindow: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const PROVENANCE = 'Computed by the server for each window; the Console prints its rounded figures.';

function windowInputs(shown: OutcomeShown): ExplanationInput[] {
  return [
    { key: 'current_window', label: 'This window', value: shown.currentWindow, source: 'Complete UTC days' },
    { key: 'prior_window', label: 'Comparable prior', value: shown.priorWindow, source: 'The same number of days before' },
  ];
}

/**
 * The summary's comparison clause: "comparable prior $0.020, a change of -22.9%", or "no
 * comparable prior figure" when the prior window has none. The tile prints a dash then;
 * a sentence never ends on that mark (FXD2 review).
 */
function priorClause(shown: OutcomeShown, priorValue: unknown): string {
  if (!finite(priorValue)) return 'no comparable prior figure';
  return `comparable prior ${shown.prior}${shown.delta ? `, a change of ${shown.delta}` : ''}`;
}

/** A dollar amount with the 6 decimals the server keeps: "$0.015432". */
function usd(value: number): string {
  return `$${plain(value, 6)}`;
}

/** True when `worked` and the server's figure agree to `digits` decimals. */
function holds(worked: number, server: number, digits: number): boolean {
  const factor = 10 ** digits;
  const clean = (v: number) => Math.round(Math.round(v * 1e9) / 1e9 * factor);
  return Number.isFinite(worked) && clean(worked) === clean(server);
}

/**
 * A step, but only with an expression that gives the server's figure: if the printed
 * operands do not work out to it (a figure the server derived another way), the step
 * says the figure came from the server instead of printing arithmetic that disagrees.
 */
function step(label: string, expression: string, worked: number, server: number, digits: number, result: string): ExplanationStep {
  return holds(worked, server, digits)
    ? { label, expression, result }
    : { label, expression: 'As the server computed it', result };
}

/** Parse a printed operand back to a number ("$0.015432" is 0.015432). */
const num = (text: string): number => Number(text.replace(/[$,]/g, ''));

/** A relative change as a step: "(a - b) / b = -0.229, shown as -22.9%". */
function relativeStep(current: string, prior: string, relative: number, chip: string | undefined): ExplanationStep {
  return step(
    'Change',
    `(${current} - ${prior}) / ${prior}`,
    (num(current) - num(prior)) / num(prior),
    relative,
    4,
    `${plain(relative, 4)}${chip ? `, shown as ${chip}` : ''}`,
  );
}

/** AI processing cost per costed case, both windows and the change. */
export function explainCostOutcome(cost: AgentRecordedCaseCostOutcome, shown: OutcomeShown): Explanation | null {
  const cur = cost.current;
  const base = cost.baseline;
  if (cost.status === 'unavailable' || !finite(cur.cost_per_costed_case)) return null;
  const perCase = (label: string, period: typeof cur, text: string): ExplanationStep =>
    step(
      label,
      `${usd(period.total_cost)} / ${count(period.costed_cases)} ${period.costed_cases === 1 ? 'case' : 'cases'}`,
      num(usd(period.total_cost)) / period.costed_cases,
      period.cost_per_costed_case as number,
      6,
      `${usd(period.cost_per_costed_case as number)}, shown as ${text}`,
    );
  const steps: ExplanationStep[] = [perCase('This window', cur, shown.value)];
  if (finite(base.cost_per_costed_case)) steps.push(perCase('Comparable prior', base, shown.prior));
  const relative = cost.delta.cost_per_costed_case_relative;
  if (finite(relative) && finite(base.cost_per_costed_case)) {
    steps.push(relativeStep(usd(cur.cost_per_costed_case), usd(base.cost_per_costed_case), relative, shown.delta));
  }
  return {
    metric: 'outcome_cost_per_case',
    title: 'AI processing cost per case',
    value: cur.cost_per_costed_case,
    display: shown.value,
    summary: `${usd(cur.total_cost)} of recorded model cost over ${count(cur.costed_cases)} cases = ${usd(cur.cost_per_costed_case)} per case; ${priorClause(shown, base.cost_per_costed_case)}.`,
    formula: 'recorded cost of model calls tied to a case / cases with such a call; change = (now - prior) / prior',
    inputs: [
      { key: 'total', label: 'Recorded cost, this window', value: usd(cur.total_cost), source: `${count(cur.call_count)} model calls tied to a case` },
      { key: 'cases', label: 'Costed cases, this window', value: count(cur.costed_cases), source: 'Distinct cases with a recorded call' },
      { key: 'prior_total', label: 'Recorded cost, prior', value: usd(base.total_cost), source: `${count(base.call_count)} model calls tied to a case` },
      { key: 'prior_cases', label: 'Costed cases, prior', value: count(base.costed_cases), source: 'Distinct cases with a recorded call' },
      ...windowInputs(shown),
    ],
    steps,
    rounding: 'Each cost per case is rounded to 6 decimals before the change is worked. The tile shows 3 decimals and the change to one decimal of a percent.',
    provenance: 'server_computed',
    provenanceNote: PROVENANCE,
    caveats: ['Model operating cost only, not analyst time or total SOC cost.'],
  };
}

/** One window's elapsed-time difference as a step: "106 - 0.4 = 105.6 minutes". */
function differenceStep(label: string, human: number | null, agent: number | null, diff: number | null, shown: string): ExplanationStep | null {
  if (!finite(human) || !finite(agent) || !finite(diff)) return null;
  return step(
    label,
    `${plain(human, 1)} - ${plain(agent, 1)}`,
    num(plain(human, 1)) - num(plain(agent, 1)),
    diff,
    1,
    `${plain(diff, 1)} minutes per case, shown as ${shown}`,
  );
}

/** Observed elapsed-time difference: human-owned p50 minus agent-closed p50, per window. */
export function explainTimingOutcome(timing: AgentObservedTimeSavedOutcome, shown: OutcomeShown): Explanation | null {
  const cur = timing.current;
  const base = timing.baseline;
  if (timing.status === 'unavailable' || !finite(cur.observed_difference_minutes_per_case)) return null;
  const steps = [
    differenceStep('This window', cur.human_owned_closure_p50_minutes, cur.agent_closed_p50_minutes, cur.observed_difference_minutes_per_case, shown.value),
    differenceStep('Comparable prior', base.human_owned_closure_p50_minutes, base.agent_closed_p50_minutes, base.observed_difference_minutes_per_case, shown.prior),
  ].filter((s): s is ExplanationStep => s !== null);
  const delta = timing.delta.minutes_per_case;
  if (finite(delta) && finite(base.observed_difference_minutes_per_case)) {
    const now = plain(cur.observed_difference_minutes_per_case, 1);
    const before = plain(base.observed_difference_minutes_per_case, 1);
    steps.push(
      step(
        'Change',
        `${now} - ${before}`,
        num(now) - num(before),
        delta,
        1,
        `${plain(delta, 1)} minutes per case${shown.delta ? `, shown as ${shown.delta}` : ''}`,
      ),
    );
  }
  return {
    metric: 'outcome_elapsed_difference',
    title: 'Observed elapsed-time difference',
    value: cur.observed_difference_minutes_per_case,
    display: shown.value,
    summary: `Median human-owned closure ${plain(cur.human_owned_closure_p50_minutes ?? 0, 1)} min - median agent closure ${plain(cur.agent_closed_p50_minutes ?? 0, 1)} min = ${plain(cur.observed_difference_minutes_per_case, 1)} min per case; ${priorClause(shown, base.observed_difference_minutes_per_case)}.`,
    formula: 'median human-owned closure time - median agent closure time; change = now - prior',
    inputs: [
      { key: 'human', label: 'Human-owned closures, this window', value: count(cur.human_owned_closure_count), source: `median ${plain(cur.human_owned_closure_p50_minutes ?? 0, 1)} minutes` },
      { key: 'agent', label: 'Agent closures, this window', value: count(cur.agent_closed_count), source: `median ${plain(cur.agent_closed_p50_minutes ?? 0, 1)} minutes` },
      { key: 'prior_human', label: 'Human-owned closures, prior', value: count(base.human_owned_closure_count), source: finite(base.human_owned_closure_p50_minutes) ? `median ${plain(base.human_owned_closure_p50_minutes, 1)} minutes` : 'No median' },
      { key: 'prior_agent', label: 'Agent closures, prior', value: count(base.agent_closed_count), source: finite(base.agent_closed_p50_minutes) ? `median ${plain(base.agent_closed_p50_minutes, 1)} minutes` : 'No median' },
      ...windowInputs(shown),
    ],
    steps,
    rounding: 'Each median and difference is rounded to one decimal of a minute before the change is worked. The tile shows whole minutes.',
    provenance: 'server_computed',
    provenanceNote: PROVENANCE,
    caveats: ['The two groups of cases are not matched, and elapsed time is not working time.'],
  };
}

/** One window's per-day count as a step, when its own division gives the server's figure. */
function perDayStep(label: string, total: number | null, days: number | null, perDay: number | null, shown: string): ExplanationStep | null {
  if (!finite(perDay)) return null;
  if (finite(total) && finite(days) && days > 0 && Math.round((total / days) * 100) / 100 === perDay) {
    return { label, expression: `${count(total)} / ${count(days)} days`, result: `${plain(perDay, 2)} per day, shown as ${shown}` };
  }
  return { label, expression: 'Per-day count from the server', result: `${plain(perDay, 2)} per day, shown as ${shown}` };
}

/** Alerts after clustering per day, both windows and the relative change. */
export function explainVolumeOutcome(
  volume: AgentAlertVolumeOutcome,
  shown: OutcomeShown,
  days: { current: number | null; prior: number | null },
): Explanation | null {
  const cur = volume.current;
  const base = volume.baseline;
  if (volume.status === 'unavailable' || !finite(cur.after_clustering_per_day)) return null;
  const steps = [
    perDayStep('This window', cur.after_clustering_alerts, days.current, cur.after_clustering_per_day, shown.value),
    perDayStep('Comparable prior', base.after_clustering_alerts, days.prior, base.after_clustering_per_day, shown.prior),
  ].filter((s): s is ExplanationStep => s !== null);
  const relative = volume.delta.after_clustering_per_day_relative;
  if (finite(relative) && finite(base.after_clustering_per_day)) {
    steps.push(relativeStep(plain(cur.after_clustering_per_day, 2), plain(base.after_clustering_per_day, 2), relative, shown.delta));
  }
  return {
    metric: 'outcome_alerts_per_day',
    title: 'Alerts after clustering per day',
    value: cur.after_clustering_per_day,
    display: shown.value,
    summary: `${count(cur.after_clustering_alerts ?? 0)} alerts after clustering over ${count(days.current ?? 0)} days = ${plain(cur.after_clustering_per_day, 2)} per day; ${priorClause(shown, base.after_clustering_per_day)}.`,
    formula: 'alerts left after clustering / days in the window; change = (now - prior) / prior',
    inputs: [
      { key: 'current', label: 'After clustering, this window', value: count(cur.after_clustering_alerts ?? 0), source: `of ${count(cur.ingested_alerts ?? 0)} ingested alerts` },
      { key: 'prior', label: 'After clustering, prior', value: count(base.after_clustering_alerts ?? 0), source: `of ${count(base.ingested_alerts ?? 0)} ingested alerts` },
      ...windowInputs(shown),
    ],
    steps,
    rounding: 'Each per-day count is rounded to 2 decimals before the change is worked. The tile shows whole alerts and the change to one decimal of a percent.',
    provenance: 'server_computed',
    provenanceNote: PROVENANCE,
    caveats: ['Clustering happens after ingest; source changes and threat activity also move these counts.'],
  };
}

/** One window's share as a step: "4 / 12 = 0.3333, shown as 33.3%". */
function shareStep(label: string, confirmed: number, evaluable: number, value: number | null, shown: string): ExplanationStep | null {
  if (!finite(value) || !(evaluable > 0)) return null;
  return step(label, `${count(confirmed)} / ${count(evaluable)}`, confirmed / evaluable, value, 4, `${plain(value, 4)}, shown as ${shown}`);
}

/** Confirmed-positive case share: confirmed over evaluable grades, both windows. */
export function explainPositiveOutcome(positive: AgentConfirmedPositiveCaseRateOutcome, shown: OutcomeShown): Explanation | null {
  const cur = positive.current;
  const base = positive.baseline;
  if (positive.status === 'unavailable' || !finite(cur.value)) return null;
  const steps = [
    shareStep('This window', cur.confirmed_positive_cases, cur.outcome_evaluable_cases, cur.value, shown.value),
    shareStep('Comparable prior', base.confirmed_positive_cases, base.outcome_evaluable_cases, base.value, shown.prior),
  ].filter((s): s is ExplanationStep => s !== null);
  const points = positive.delta.percentage_points;
  if (finite(points) && finite(base.value)) {
    const now = plain(cur.value, 4);
    const before = plain(base.value, 4);
    steps.push(
      step(
        'Change',
        `(${now} - ${before}) x 100`,
        (num(now) - num(before)) * 100,
        points,
        2,
        `${plain(points, 2)} percentage points${shown.delta ? `, shown as ${shown.delta}` : ''}`,
      ),
    );
  }
  return {
    metric: 'outcome_confirmed_positive_share',
    title: 'Confirmed-positive case share',
    value: cur.value,
    display: shown.value,
    summary: `${count(cur.confirmed_positive_cases)} of ${count(cur.outcome_evaluable_cases)} graded cases confirmed positive = ${shown.value}; ${priorClause(shown, base.value)}.`,
    formula: 'cases graded true positive or false negative / cases graded with an outcome',
    inputs: [
      { key: 'confirmed', label: 'Confirmed positive, this window', value: count(cur.confirmed_positive_cases), source: 'Latest valid grade per case' },
      { key: 'evaluable', label: 'Graded with an outcome, this window', value: count(cur.outcome_evaluable_cases), source: 'Latest valid grade per case' },
      { key: 'prior_confirmed', label: 'Confirmed positive, prior', value: count(base.confirmed_positive_cases), source: 'Latest valid grade per case' },
      { key: 'prior_evaluable', label: 'Graded with an outcome, prior', value: count(base.outcome_evaluable_cases), source: 'Latest valid grade per case' },
      ...windowInputs(shown),
    ],
    steps,
    rounding: 'Each share is rounded to 4 decimals before the change is worked. The tile shows one decimal of a percent.',
    provenance: 'server_computed',
    provenanceNote: PROVENANCE,
    caveats: ['A case-level mix of analyst outcomes, not detection precision; a rise is not better in itself.'],
  };
}
