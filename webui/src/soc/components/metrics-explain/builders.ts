/**
 * Dashboard figures explained (Round 16 SPEC §4.5 WP12; research explainability R8, R9,
 * R11 and D10).
 *
 * Pure builders over the numbers a dashboard already holds: counts, shares, the
 * lifecycle medians and the Alert reduction. Each returns a typed `Explanation` the
 * Explain kit renders, built on the shared builders of `@/lib/explain` (the same
 * arithmetic the server's contract vectors pin). A figure the Console computes from
 * server counts says so in its provenance note. Every value is plain text (#9).
 *
 * Lazy-only: imported by the Overview, the Analytics page and the dashboard widgets,
 * never by an entry module.
 */
import { explainPercentile, explainShare } from '@/lib/explain/builders';
import { count, percentOf, trimmed } from '@/lib/explain/rounding';
import type { Explanation, ExplanationLink, ExplanationStep } from '@/lib/explain/types';
import type { MetricExplainSample, MttrByDecider, MttrDecider } from '@/lib/types-metrics-explain';
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';
import { humanizeMinutes } from '@/soc/pages/posture.format';

/** The provenance note of a figure the server counted. */
export const SERVER_COUNTED = 'Counted by the server over the cases in the window.';
/** The provenance note of a share the Console divides from two server counts. */
export const CONSOLE_DIVIDED = 'The Console divided two counts the server returned for this window.';

/** A Console hash (`#/cases?window=24`) as an explanation link. */
export function linkFromHash(label: string, hash: string): ExplanationLink {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { label, route: path, params: Object.fromEntries(new URLSearchParams(query)) };
}

export interface CountExplainInput {
  metric: string;
  title: string;
  value: number | null | undefined;
  /** What one unit counts, plural ("cases"). */
  noun: string;
  /** The window in words ("the last 24 hours"), or a sentence for a stock. */
  window: string;
  /** The hover line when the value is measured. */
  summary: string;
  formula: string;
  caveats?: string[];
  link?: ExplanationLink;
}

/** A count the server returned: no arithmetic, but what it counts and over which window. */
export function explainCount(input: CountExplainInput): Explanation | null {
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) return null;
  return {
    metric: input.metric,
    title: input.title,
    value: input.value,
    display: count(input.value),
    summary: input.summary,
    formula: input.formula,
    inputs: [
      { key: 'count', label: `Counted ${input.noun}`, value: count(input.value), source: 'Server count' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps: [],
    provenance: 'server_computed',
    provenanceNote: SERVER_COUNTED,
    caveats: input.caveats ?? [],
    link: input.link,
  };
}

export interface ShareExplainInput {
  metric: string;
  title: string;
  numerator: number | null | undefined;
  denominator: number | null | undefined;
  /** What the numerator counts ("critical cases"). */
  numeratorLabel: string;
  /** What the denominator counts ("cases"). */
  denominatorLabel: string;
  window: string;
  /** Who divided: the server (its own rate) or the Console (from two counts). */
  dividedBy: 'server' | 'console';
  /** How the tile rounds the share it shows. */
  tileRounding?: string;
  caveats?: string[];
  link?: ExplanationLink;
}

/**
 * A share: numerator over denominator with the real counts ("12 of 40 cases = 30%"),
 * from `explainShare`, titled and sourced for the tile.
 */
export function explainKpiShare(input: ShareExplainInput): Explanation | null {
  const { numerator, denominator } = input;
  if (typeof numerator !== 'number' || typeof denominator !== 'number') return null;
  const base = explainShare(numerator, denominator, { metric: input.metric, label: input.denominatorLabel });
  if (!base) return null;
  const share = base.value === null ? null : percentOf(base.value as number);
  return {
    ...base,
    title: input.title,
    summary:
      share === null
        ? `No ${input.denominatorLabel} in ${input.window}, so there is no share.`
        : `${count(numerator)} ${input.numeratorLabel} of ${count(denominator)} ${input.denominatorLabel} = ${share}, ${input.window}.`,
    inputs: [
      { key: 'numerator', label: capitalise(input.numeratorLabel), value: count(numerator), source: 'Server count' },
      { key: 'denominator', label: capitalise(input.denominatorLabel), value: count(denominator), source: 'Server count' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    rounding: input.tileRounding ?? base.rounding,
    provenance: 'server_computed',
    provenanceNote: input.dividedBy === 'console' ? CONSOLE_DIVIDED : 'Computed by the server over the cases in the window.',
    caveats: [...base.caveats, ...(input.caveats ?? [])],
    link: input.link,
  };
}

/** Alert reduction: one minus cases opened over alerts ingested (research R11). */
export function explainAlertReduction(
  ingested: number | null | undefined,
  cases: number | null | undefined,
  window: string,
): Explanation | null {
  if (typeof ingested !== 'number' || typeof cases !== 'number' || !(ingested > 0) || cases > ingested) return null;
  const ratio = cases / ingested;
  const reduction = 1 - ratio;
  return {
    metric: 'alert_reduction',
    title: 'Alert reduction',
    value: reduction,
    display: percentOf(reduction),
    summary: `1 - ${count(cases)} cases / ${count(ingested)} alerts = ${percentOf(reduction)}, ${window}.`,
    formula: '1 - cases opened / alerts ingested',
    inputs: [
      { key: 'ingested', label: 'Alerts ingested', value: count(ingested), source: 'Alert counters' },
      { key: 'cases', label: 'Cases opened', value: count(cases), source: 'Case count' },
      { key: 'window', label: 'Window', value: window, source: 'The time range above' },
    ],
    steps: [
      { label: 'Ratio', expression: `${count(cases)} / ${count(ingested)}`, result: trimmed(ratio, 4) },
      { label: 'Reduction', expression: `1 - ${trimmed(ratio, 4)}`, result: percentOf(reduction) },
    ],
    rounding: 'The percentage is shown with at most one decimal.',
    provenance: 'server_computed',
    provenanceNote: CONSOLE_DIVIDED,
    caveats: [],
  };
}

/** The deciders an MTTR split names, in words. */
export const DECIDER_WORDS: Record<MttrDecider, string> = {
  agent: 'Closed by the AI agent',
  analyst: 'Closed by a person',
  analyst_policy: 'Closed by an analyst rule policy',
  system: 'Closed by a system rule',
  unrecorded: 'No decider recorded',
};

/** One step line per decider with cases: "180 cases, median 24m". */
export function deciderSteps(split: MttrByDecider | undefined): ExplanationStep[] {
  if (!split) return [];
  const out: ExplanationStep[] = [];
  for (const key of Object.keys(DECIDER_WORDS) as MttrDecider[]) {
    const block = split[key];
    if (!block || !(block.count > 0)) continue;
    out.push({
      label: DECIDER_WORDS[key],
      expression: `${count(block.count)} ${block.count === 1 ? 'case' : 'cases'}`,
      result: `median ${humanizeMinutes(block.p50)}`,
    });
  }
  return out;
}

export interface TimingExplainInput {
  metric: 'mtta' | 'mttr' | 'dwell' | 'mttd';
  title: string;
  block: StatBlock | undefined;
  window: string;
  /** The clock in words: where it starts and what stops it. */
  definition: string;
  /** The sample minutes, once loaded, so the rank arithmetic can be printed. */
  samples?: readonly number[];
  byDecider?: MttrByDecider;
  /** How many samples exist when only some are listed. */
  sampleCount?: number;
  link?: ExplanationLink;
}

/**
 * A lifecycle median (MTTA, MTTR, dwell, MTTD): p50, p90, mean and the count, from
 * `explainPercentile`, with the durations in words, the clock's definition and, for
 * MTTR, the split by who closed the case.
 */
export function explainTiming(input: TimingExplainInput): Explanation | null {
  const base = explainPercentile(input.block as StatBlock, input.samples, {
    metric: `${input.metric}_p50`,
    label: input.title,
    unit: ' minutes',
  });
  if (!base) return null;
  const block = input.block as StatBlock;
  if (!block.available || typeof block.p50 !== 'number') {
    return {
      ...base,
      summary: `${input.title} is not measured for ${input.window}: ${block.reason || 'no case made this transition'}.`,
      formula: TIMING_FORMULA,
      provenanceNote: `${input.definition} Computed by the server from each case's own timestamps.`,
      inputs: [{ key: 'window', label: 'Window', value: input.window, source: 'The time range above' }],
      caveats: [],
      link: input.link,
    };
  }
  const n = block.count;
  const decider = deciderSteps(input.byDecider);
  const caveats = [...base.caveats];
  if (input.samples && input.sampleCount && input.samples.length < input.sampleCount) {
    caveats.splice(0, caveats.length, `The rank lines use the ${count(input.samples.length)} listed samples around the median, of ${count(input.sampleCount)}.`);
  }
  if (decider.length) {
    caveats.push('Who closed a case is the last decider the case records, not proof of who did the work.');
  }
  return {
    ...base,
    title: input.title,
    display: humanizeMinutes(block.p50),
    summary: `Median (p50) ${humanizeMinutes(block.p50)} over ${count(n)} ${n === 1 ? 'case' : 'cases'} in ${input.window}; p90 ${humanizeMinutes(block.p90)}, mean ${humanizeMinutes(block.mean)}.`,
    formula: TIMING_FORMULA,
    inputs: [
      { key: 'count', label: 'Cases measured', value: count(n), source: 'Server' },
      { key: 'p50', label: 'Median (p50)', value: `${humanizeMinutes(block.p50)} (${trimmed(block.p50 as number, 1)} minutes)`, source: 'Server' },
      { key: 'p90', label: 'p90', value: humanizeMinutes(block.p90), source: 'Server' },
      { key: 'mean', label: 'Mean', value: humanizeMinutes(block.mean), source: 'Server' },
      { key: 'max', label: 'Longest', value: humanizeMinutes(block.max), source: 'Server' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps: [...base.steps, ...decider],
    rounding: 'The server rounds each figure to one decimal of a minute; durations are shown in whole minutes.',
    provenance: 'server_computed',
    // The clock's definition is prose, so it sits with the provenance, not in the formula.
    provenanceNote: `${input.definition} Computed by the server from each case's own timestamps.`,
    caveats,
    link: input.link,
  };
}

/** The arithmetic of a lifecycle median, the same for every clock. */
export const TIMING_FORMULA = 'p50 = the middle of the sorted times: rank 0.5 x (n - 1), interpolated';

/** The clock definitions, in the server's terms (`engine/metrics.lifecycle_intervals`). */
export const TIMING_DEFINITIONS: Record<TimingExplainInput['metric'], string> = {
  mttd: 'From the first event of the case to the case being opened.',
  mtta: 'From case creation (or detection when recorded) to the first human acknowledgement, or a human move to investigating, escalated or on hold. Assigning a case alone does not stop it.',
  mttr: 'From case creation (or detection when recorded) to the first time the case was resolved or closed, for cases that are resolved or closed now.',
  dwell: 'From case creation (or detection when recorded) to the first response: investigating, escalated, on hold, resolved or closed.',
};

/** The agreement rate and its own population (D10). */
export function explainAgreement(fb: {
  agreement_rate?: number | null;
  agreement_signals?: number;
  agreement_agreed?: number;
  agreement_partial?: number;
  agreement_disagreed?: number;
  feedback_count?: number;
  graded_cases?: number;
}, window: string): Explanation | null {
  const signals = fb.agreement_signals;
  if (typeof signals !== 'number') return null;
  const agreed = fb.agreement_agreed;
  const partial = fb.agreement_partial;
  const hasCounts = typeof agreed === 'number' && typeof partial === 'number';
  const rate = typeof fb.agreement_rate === 'number' ? fb.agreement_rate : null;
  const population =
    'Every grade entry that compares the analyst with the AI (agree, partial or disagree). Partial counts as half. Review grades of automatic closes and analyst rule policy closes are left out.';
  if (rate === null || signals <= 0) {
    return {
      metric: 'agreement_rate',
      title: 'Agreement rate',
      value: null,
      display: 'Not measured',
      summary: 'No grade compares an analyst with the AI yet, so there is no agreement rate.',
      formula: '(agreed + 0.5 x partial) / grade entries with an assessment',
      inputs: [{ key: 'signals', label: 'Grade entries with an assessment', value: count(Math.max(0, signals)), source: 'Server' }],
      steps: [],
      provenance: 'server_computed',
      caveats: [population],
    };
  }
  const steps: ExplanationStep[] = hasCounts
    ? [
        { label: 'Weighted', expression: `${count(agreed!)} + 0.5 x ${count(partial!)}`, result: trimmed(agreed! + 0.5 * partial!, 1) },
        { label: 'Rate', expression: `${trimmed(agreed! + 0.5 * partial!, 1)} / ${count(signals)}`, result: percentOf(rate) },
      ]
    : [];
  return {
    metric: 'agreement_rate',
    title: 'Agreement rate',
    value: rate,
    display: percentOf(rate),
    summary: hasCounts
      ? `(${count(agreed!)} agreed + 0.5 x ${count(partial!)} partial) / ${count(signals)} grade entries = ${percentOf(rate)}, ${window}.`
      : `${percentOf(rate)} over ${count(signals)} grade entries with an assessment, ${window}.`,
    formula: '(agreed + 0.5 x partial) / grade entries with an assessment',
    inputs: [
      ...(hasCounts
        ? [
            { key: 'agreed', label: 'Agreed', value: count(agreed!), source: 'Server' },
            { key: 'partial', label: 'Partly agreed', value: count(partial!), source: 'Server' },
            { key: 'disagreed', label: 'Disagreed', value: count(fb.agreement_disagreed ?? 0), source: 'Server' },
          ]
        : []),
      { key: 'signals', label: 'Grade entries with an assessment', value: count(signals), source: 'Server' },
      ...(typeof fb.graded_cases === 'number' ? [{ key: 'graded', label: 'Graded cases', value: count(fb.graded_cases), source: 'Server' }] : []),
    ],
    steps,
    rounding: 'The rate is shown as a whole percent on the tile.',
    provenance: 'server_computed',
    caveats: [population, 'One case can carry more than one grade entry, so the entries can outnumber the graded cases.'],
  };
}

/** The anchor words a sample's end (or start) came from. */
export const ANCHOR_WORDS: Record<string, string> = {
  acknowledged_at: 'Acknowledged',
  first_response_at: 'First response',
  status_history: 'Status change',
  updated_at: 'Last update (no status change recorded)',
  created_at: 'Case opened',
  detected_at: 'Detected',
  first_seen_millis: 'First event',
};

/** A sample's minutes in words with the exact figure: "24m (23.6 minutes)". */
export function sampleMinutes(sample: MetricExplainSample): string {
  const minutes = typeof sample.minutes === 'number' ? sample.minutes : sample.value;
  return `${humanizeMinutes(minutes)} (${trimmed(minutes, 1)} minutes)`;
}

function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
