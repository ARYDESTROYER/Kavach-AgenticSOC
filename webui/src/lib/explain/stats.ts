/**
 * Shares, percentiles and Wilson intervals explained (Round 16 SPEC §4.5 WP11; research
 * explainability R10 and §5.4).
 *
 * The arithmetic mirrors the server exactly (`engine/metrics.percentile`, linear
 * interpolation between closest ranks; `wilson_interval`, z = 1.96, 4 decimals) and
 * `explain.contract.json` pins it on both ends. Pure: plain data only.
 */
import type { StatBlock } from '@/lib/types';

import { count, percentOf, trimmed } from './rounding';
import type { Explanation, ExplanationStep } from './types';

/** Linear interpolation between closest ranks: [4, 9, 31, 62] gives p50 20 and p90 52.7. */
export function percentile(values: readonly number[], q: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
}

/** The Wilson score interval of `successes` of `n` (z defaults to 1.96), to 4 decimals. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!(n > 0) || !Number.isFinite(successes)) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return { low: round4(Math.max(0, centre - margin)), high: round4(Math.min(1, centre + margin)) };
}

/** A share: a numerator over a denominator, as a percentage. */
export function explainShare(
  numerator: number,
  denominator: number,
  options?: { metric?: string; label?: string },
): Explanation | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  const label = options?.label ?? 'items';
  const base = {
    metric: options?.metric ?? 'share',
    title: options?.label ? `Share of ${options.label}` : 'Share',
    formula: 'numerator / denominator x 100',
    inputs: [
      { key: 'numerator', label: 'Counted', value: count(numerator), source: 'This view' },
      { key: 'denominator', label: `All ${label}`, value: count(denominator), source: 'This view' },
    ],
    provenance: 'server_computed' as const,
  };
  if (denominator <= 0) {
    return {
      ...base,
      value: null,
      display: 'Not measured',
      summary: `No ${label} yet, so there is no share.`,
      steps: [],
      caveats: ['A share needs at least one item in the denominator.'],
    };
  }
  const ratio = numerator / denominator;
  return {
    ...base,
    value: ratio,
    display: percentOf(ratio),
    summary: `${count(numerator)} of ${count(denominator)} ${label} = ${percentOf(ratio)}.`,
    steps: [
      { label: 'Ratio', expression: `${count(numerator)} / ${count(denominator)}`, result: trimmed(ratio, 4) },
      { label: 'Percent', expression: `${trimmed(ratio, 4)} x 100`, result: percentOf(ratio) },
    ],
    rounding: 'The percentage is shown with at most one decimal.',
    caveats: [],
  };
}

function rankSteps(name: string, values: readonly number[], q: number, unit: string): ExplanationStep | null {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = q * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const result = percentile(sorted, q) ?? 0;
  const expression =
    lower === upper
      ? `rank ${trimmed(q, 2)} x (${sorted.length} - 1) = ${trimmed(rank)}, the value at that rank`
      : `rank ${trimmed(q, 2)} x (${sorted.length} - 1) = ${trimmed(rank)}; ${trimmed(sorted[lower])} + ${trimmed(rank - lower)} x (${trimmed(sorted[upper])} - ${trimmed(sorted[lower])})`;
  return { label: name, expression, result: `${trimmed(result)}${unit}` };
}

/** A median or other percentile of a distribution, with its samples when given. */
export function explainPercentile(
  block: StatBlock,
  samples?: readonly number[],
  options?: { metric?: string; label?: string; unit?: string },
): Explanation | null {
  if (!block) return null;
  const unit = options?.unit ?? ' minutes';
  const label = options?.label ?? 'Median';
  const p50 = typeof block.p50 === 'number' ? block.p50 : null;
  if (!block.available || p50 === null) {
    return {
      metric: options?.metric ?? 'percentile',
      title: label,
      value: null,
      display: 'Not measured',
      summary: block.reason || 'Not measured: no sample made this transition.',
      formula: 'linear interpolation between closest ranks',
      inputs: [{ key: 'count', label: 'Samples', value: count(block.count ?? 0), source: 'This view' }],
      steps: [],
      provenance: 'server_computed',
      caveats: block.reason ? [block.reason] : [],
    };
  }
  const numberOr = (v: number | string) => (typeof v === 'number' ? `${trimmed(v)}${unit}` : String(v));
  const steps: ExplanationStep[] = [];
  if (samples?.length) {
    const s50 = rankSteps('p50', samples, 0.5, unit);
    const s90 = rankSteps('p90', samples, 0.9, unit);
    if (s50) steps.push(s50);
    if (s90) steps.push(s90);
  }
  return {
    metric: options?.metric ?? 'percentile',
    title: label,
    value: p50,
    display: `${trimmed(p50)}${unit}`,
    summary: `Median (p50) ${numberOr(block.p50)} over ${count(block.count)} samples; p90 ${numberOr(block.p90)}, mean ${numberOr(block.mean)}.`,
    formula: 'sort the samples; rank = q x (n - 1); interpolate between the two closest ranks',
    inputs: [
      { key: 'count', label: 'Samples', value: count(block.count), source: 'This view' },
      { key: 'p90', label: 'p90', value: numberOr(block.p90), source: 'Server' },
      { key: 'mean', label: 'Mean', value: numberOr(block.mean), source: 'Server' },
      { key: 'max', label: 'Largest', value: numberOr(block.max), source: 'Server' },
    ],
    steps,
    provenance: 'server_computed',
    caveats: samples && samples.length < block.count ? [`Showing ${count(samples.length)} of ${count(block.count)} samples.`] : [],
  };
}

/** A Wilson score interval of `successes` out of `n` (z defaults to 1.96). */
export function explainWilson(successes: number, n: number, z = 1.96): Explanation | null {
  const interval = wilsonInterval(successes, n, z);
  if (!interval) return null;
  const p = successes / n;
  const zz = z * z;
  const denom = 1 + zz / n;
  const centre = (p + zz / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + zz / (4 * n * n))) / denom;
  return {
    metric: 'wilson_interval',
    title: '95% interval',
    value: `${interval.low} to ${interval.high}`,
    display: `${percentOf(interval.low)} to ${percentOf(interval.high)}`,
    summary: `Wilson ${z === 1.96 ? '95% interval' : `interval at z = ${trimmed(z)}`} for ${count(successes)} of ${count(n)}: ${percentOf(interval.low)} to ${percentOf(interval.high)}.`,
    formula: '(p + z^2 / 2n) / (1 + z^2 / n), plus or minus z x sqrt(p(1 - p) / n + z^2 / 4n^2) / (1 + z^2 / n)',
    inputs: [
      { key: 'successes', label: 'Successes', value: count(successes), source: 'This view' },
      { key: 'n', label: 'Total', value: count(n), source: 'This view' },
      { key: 'z', label: 'z', value: trimmed(z), source: z === 1.96 ? '95% confidence' : 'Configured' },
    ],
    steps: [
      { label: 'p', expression: `${count(successes)} / ${count(n)}`, result: trimmed(p, 4) },
      { label: 'Centre', expression: `(${trimmed(p, 4)} + ${trimmed(zz, 4)} / ${2 * n}) / ${trimmed(denom, 4)}`, result: trimmed(centre, 4) },
      { label: 'Margin', expression: `${trimmed(z)} x sqrt(${trimmed(p, 4)} x ${trimmed(1 - p, 4)} / ${n} + ${trimmed(zz, 4)} / ${4 * n * n}) / ${trimmed(denom, 4)}`, result: trimmed(margin, 4) },
      { label: 'Low', expression: `max(0, ${trimmed(centre, 4)} - ${trimmed(margin, 4)})`, result: trimmed(interval.low, 4) },
      { label: 'High', expression: `min(1, ${trimmed(centre, 4)} + ${trimmed(margin, 4)})`, result: trimmed(interval.high, 4) },
    ],
    rounding: 'Bounds are rounded to 4 decimals.',
    provenance: 'server_computed',
    caveats: ['The interval describes the counted cases only.'],
  };
}
