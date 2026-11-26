/**
 * The Agent effectiveness comparison figures explained (Round 16 package FXF): verdict
 * agreement, material correction and human review turnaround each get the hover line and
 * the click arithmetic the other tiles have.
 *
 * Agreement and correction are re-weighted by the server to a source and severity mix the
 * two windows share, so the shown figure is not the plain ratio of the counts. Each
 * explanation therefore prints the plain ratio from the counts the server returned, then
 * says the shown figure is the mix-adjusted one it computed. Turnaround is the median of
 * the elapsed review times, with the quartiles and p90 beside it. Aggregates only (#7);
 * plain text throughout (#9). Lives in the lazy Agent effectiveness chunk.
 */
import { count, percentOf, trimmed } from '@/lib/explain/rounding';
import type { Explanation } from '@/lib/explain/types';
import type { AgentComparisonMetric, AgentComparisonReading } from '@/lib/types';
import { humanizeMinutes } from '../posture.format';

/** The window each reading covers, as the page's caption says. */
const CURRENT = 'the last 7 complete days';
const BASELINE = 'the 28 days before';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function feedback(reading: AgentComparisonReading): { agree: number; partial: number; disagree: number } | null {
  const raw = reading.feedback_counts as Record<string, unknown> | undefined;
  const agree = num(raw?.agree);
  const partial = num(raw?.partial);
  const disagree = num(raw?.disagree);
  return agree === null || partial === null || disagree === null ? null : { agree, partial, disagree };
}

const ADJUSTED_CAVEAT =
  'The shown figure is re-weighted by the server to the source and severity mix both windows share, so it can differ from the plain ratio of the counts.';

/** The baseline figure in words, for the inputs. */
function baselineWords(metric: AgentComparisonMetric, shown: (value: number) => string): string {
  const value = num(metric.baseline.value);
  return value === null ? 'Not measured' : shown(value);
}

/**
 * Verdict agreement: (agreed + 0.5 x partial) / graded, the plain ratio from the counts,
 * then the mix-adjusted figure the server shows. `shown` is exactly the tile's text.
 */
export function agreementComparisonExplanation(metric: AgentComparisonMetric, shown: string): Explanation | null {
  const value = num(metric.current.value);
  const counts = feedback(metric.current);
  const graded = num(metric.current.total_graded_cases);
  if (value === null || !counts || graded === null || graded <= 0) return null;
  const comparable = num(metric.current.comparable_graded_cases) ?? metric.current.sample_count;
  const weighted = counts.agree + 0.5 * counts.partial;
  const plain = weighted / graded;
  return {
    metric: 'analyst_reported_verdict_agreement',
    title: metric.label,
    value,
    display: shown,
    summary: `${shown} is adjusted for the source and severity mix over ${count(comparable)} comparable grades, ${CURRENT}. From the counts: (${count(counts.agree)} agreed + 0.5 x ${count(counts.partial)} partial) / ${count(graded)} graded = ${percentOf(plain)}.`,
    formula: metric.definition.formula,
    inputs: [
      { key: 'agree', label: 'Agreed', value: count(counts.agree), source: 'Analyst grades' },
      { key: 'partial', label: 'Partly agreed', value: count(counts.partial), source: 'Analyst grades' },
      { key: 'disagree', label: 'Disagreed', value: count(counts.disagree), source: 'Analyst grades' },
      { key: 'graded', label: 'Graded cases', value: count(graded), source: 'Analyst grades' },
      { key: 'comparable', label: 'Comparable grades', value: count(comparable), source: 'Server' },
      { key: 'baseline', label: `Baseline, ${BASELINE}`, value: baselineWords(metric, (v) => percentOf(v)), source: 'Server' },
    ],
    steps: [
      { label: 'Weighted', expression: `${count(counts.agree)} + 0.5 x ${count(counts.partial)}`, result: trimmed(weighted, 1) },
      { label: 'Plain ratio', expression: `${trimmed(weighted, 1)} / ${count(graded)}`, result: percentOf(plain) },
      { label: 'Shown', expression: 'the mix-adjusted agreement the server computed', result: shown },
    ],
    rounding: 'Shown as a percent with one decimal.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server from the latest valid analyst grade of each case.',
    caveats: [ADJUSTED_CAVEAT, metric.definition.caveats].filter(Boolean),
  };
}

/** Material correction: corrected / graded, then the mix-adjusted figure the server shows. */
export function correctionComparisonExplanation(metric: AgentComparisonMetric, shown: string): Explanation | null {
  const value = num(metric.current.value);
  const corrected = num(metric.current.material_corrections);
  const graded = num(metric.current.total_graded_cases);
  if (value === null || corrected === null || graded === null || graded <= 0) return null;
  const comparable = num(metric.current.comparable_graded_cases) ?? metric.current.sample_count;
  const plain = corrected / graded;
  return {
    metric: 'material_analyst_correction_rate',
    title: metric.label,
    value,
    display: shown,
    summary: `${shown} is adjusted for the source and severity mix over ${count(comparable)} comparable grades, ${CURRENT}. From the counts: ${count(corrected)} corrected / ${count(graded)} graded = ${percentOf(plain)}.`,
    formula: metric.definition.formula,
    inputs: [
      { key: 'corrected', label: 'Materially corrected', value: count(corrected), source: 'Analyst grades' },
      { key: 'graded', label: 'Graded cases', value: count(graded), source: 'Analyst grades' },
      { key: 'comparable', label: 'Comparable grades', value: count(comparable), source: 'Server' },
      { key: 'baseline', label: `Baseline, ${BASELINE}`, value: baselineWords(metric, (v) => percentOf(v)), source: 'Server' },
    ],
    steps: [
      { label: 'Plain ratio', expression: `${count(corrected)} / ${count(graded)}`, result: percentOf(plain) },
      { label: 'Shown', expression: 'the mix-adjusted correction rate the server computed', result: shown },
    ],
    rounding: 'Shown as a percent with one decimal.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server from the latest valid analyst grade of each case.',
    caveats: [ADJUSTED_CAVEAT, metric.definition.eligibility, metric.definition.caveats].filter(Boolean),
  };
}

/** Human review turnaround: the median of the elapsed review times, with the quartiles and p90. */
export function turnaroundComparisonExplanation(metric: AgentComparisonMetric, shown: string): Explanation | null {
  const p50 = num(metric.current.value);
  const n = metric.current.sample_count;
  if (p50 === null || !(n > 0)) return null;
  const q1 = num(metric.current.q1_minutes);
  const q3 = num(metric.current.q3_minutes);
  const p90 = num(metric.current.p90_minutes);
  const words = (v: number | null) => (v === null ? 'Not measured' : humanizeMinutes(v));
  return {
    metric: 'human_review_turnaround',
    title: metric.label,
    value: p50,
    display: shown,
    summary: `Median ${shown} over ${count(n)} human-reviewed ${n === 1 ? 'case' : 'cases'}, ${CURRENT}; the middle half took ${words(q1)} to ${words(q3)}, p90 ${words(p90)}.`,
    formula: metric.definition.formula,
    inputs: [
      { key: 'count', label: 'Human-reviewed cases', value: count(n), source: 'Server' },
      { key: 'p50', label: 'Median (p50)', value: `${humanizeMinutes(p50)} (${trimmed(p50, 1)} minutes)`, source: 'Server' },
      { key: 'q1', label: 'First quartile', value: words(q1), source: 'Server' },
      { key: 'q3', label: 'Third quartile', value: words(q3), source: 'Server' },
      { key: 'p90', label: 'p90', value: words(p90), source: 'Server' },
      { key: 'baseline', label: `Baseline median, ${BASELINE}`, value: baselineWords(metric, humanizeMinutes), source: 'Server' },
    ],
    steps: [
      {
        label: 'Median',
        expression: `the middle of the ${count(n)} elapsed times, ordered (rank 0.5 x (${count(n)} - 1))`,
        result: `${trimmed(p50, 1)} minutes`,
      },
      { label: 'Shown', expression: `${trimmed(p50, 1)} minutes in words`, result: shown },
    ],
    rounding: 'The server rounds each figure to one decimal of a minute; durations are shown in whole minutes.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server from each case\'s own status history.',
    caveats: [metric.definition.eligibility, metric.definition.caveats].filter(Boolean),
  };
}
