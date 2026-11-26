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
  /**
   * Where the window comes from ("The time range above" when omitted). A stock measured
   * now, such as the cases open now, says it is not limited by the time range.
   */
  windowSource?: string;
  /** The provenance note (`SERVER_COUNTED`, "over the cases in the window", when omitted). */
  provenanceNote?: string;
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
      { key: 'window', label: 'Window', value: input.window, source: input.windowSource ?? 'The time range above' },
    ],
    steps: [],
    provenance: 'server_computed',
    provenanceNote: input.provenanceNote ?? SERVER_COUNTED,
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
        : `${count(numerator)} ${nounFor(numerator, input.numeratorLabel)} of ${count(denominator)} ${nounFor(denominator, input.denominatorLabel)} = ${share}, ${input.window}.`,
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

const SINGULAR: Record<string, string> = { cases: 'case', verdicts: 'verdict', closes: 'close' };

/**
 * A counted noun phrase for its count: "1 verdicted case", never "1 verdicted cases".
 * Only the first counted noun of the phrase changes ("open cases whose AI verdict is
 * Needs human" reads "open case whose ...").
 */
export function nounFor(n: number, plural: string): string {
  if (n !== 1) return plural;
  return plural.replace(/\b(cases|verdicts|closes)\b/, (word) => SINGULAR[word] ?? word);
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

/**
 * The noise flow's Detailed "Reduced by" figure (`reduction.overall_pct`): the share of
 * ingested alerts that did not end in a Needs a human case, `1 - needs human / ingested`.
 * Not Alert reduction (`1 - cases / ingested`): the numerator is the Needs a human stage,
 * which is narrower than Escalated, so it never claims to count every case a person
 * touched. Null when it cannot be computed from the counts.
 */
export function explainNeverReachedPerson(input: {
  ingested: number | null | undefined;
  needsHuman: number | null | undefined;
  escalated?: number | null;
  /** The figure the server returned (0 to 100, one decimal). */
  shownPct: number;
  window: string;
}): Explanation | null {
  const { ingested, needsHuman } = input;
  if (typeof ingested !== 'number' || typeof needsHuman !== 'number' || !(ingested > 0) || needsHuman > ingested) return null;
  const ratio = needsHuman / ingested;
  const shown = `${trimmed(input.shownPct, 1)}%`;
  // The step prints what its own counts give, so its arithmetic always holds.
  const fromCounts = `${trimmed(100 * (1 - ratio), 1)}%`;
  const caveats = [
    'The numerator is the Needs a human stage: cases with a Needs human verdict, and open cases that were not escalated. Escalated cases, and closed cases without a Needs human verdict, are not in it, so it does not count every case a person touched.',
  ];
  if (typeof input.escalated === 'number') {
    caveats.push(`Escalated (${count(input.escalated)}) is a different stage, so 1 - ${count(input.escalated)} / ${count(ingested)} is not this figure.`);
  }
  caveats.push('Alert reduction in the Simple view is a different measure: 1 - cases opened / alerts ingested.');
  if (fromCounts !== shown) {
    caveats.unshift(`These counts give ${fromCounts}, not the ${shown} the server returned.`);
  }
  return {
    metric: 'never_reached_person',
    title: 'Reduced by',
    value: input.shownPct / 100,
    display: shown,
    summary: `1 - ${count(needsHuman)} needed a human / ${count(ingested)} alerts ingested = ${fromCounts}, ${input.window}.`,
    formula: '1 - cases that needed a human / alerts ingested',
    inputs: [
      { key: 'ingested', label: 'Alerts ingested', value: count(ingested), source: 'Alert counters' },
      { key: 'needs_human', label: 'Needed a human', value: count(needsHuman), source: 'Case count (Needs a human stage)' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps: [
      { label: 'Ratio', expression: `${count(needsHuman)} / ${count(ingested)}`, result: trimmed(ratio, 4) },
      { label: 'Reduced by', expression: `100 x (1 - ${count(needsHuman)} / ${count(ingested)})`, result: fromCounts },
    ],
    rounding: 'The server rounds the percentage to one decimal.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server from the alert counters and the case tally for this window.',
    caveats,
  };
}

/**
 * Average risk on the Analytics page (`GET /api/metrics` `avg_risk_score`): the mean
 * risk score of the scored cases in the analysed population (which can be the newest N
 * cases). The server sends the mean to one decimal and, since this review, how many
 * scored cases it divides by (`avg_risk_case_count`); it does not send the sum, so the
 * arithmetic shown is the rounding of the mean the tile prints. Null without a mean.
 */
export function explainAverageRisk(input: {
  mean: number | null | undefined;
  scoredCases: number | null | undefined;
  /** The population caption ("all time", "newest 500 of 1,204 cases"). */
  population: string;
}): Explanation | null {
  const { mean } = input;
  if (typeof mean !== 'number' || !Number.isFinite(mean)) return null;
  const n = typeof input.scoredCases === 'number' && Number.isFinite(input.scoredCases) ? input.scoredCases : null;
  const shown = Math.floor(mean + 0.5);
  const where = input.population === 'all time' ? 'every case, all time' : `the ${input.population}`;
  return {
    metric: 'avg_risk_score',
    title: 'Average risk',
    value: mean,
    display: String(shown),
    summary:
      n !== null
        ? `Mean risk ${trimmed(mean, 1)} over ${count(n)} scored ${n === 1 ? 'case' : 'cases'}: the sum of their risk scores / ${count(n)}, ${where}.`
        : `Mean risk ${trimmed(mean, 1)}: the sum of the risk scores of the scored cases / their number, ${where}.`,
    formula: 'sum of the risk scores of the scored cases / the number of scored cases',
    inputs: [
      { key: 'mean', label: 'Mean risk', value: trimmed(mean, 1), source: 'Server, to one decimal' },
      { key: 'scored', label: 'Scored cases', value: n === null ? 'Not reported' : count(n), source: 'Server count' },
      { key: 'population', label: 'Population', value: input.population, source: 'The cases this page analysed' },
    ],
    steps: [{ label: 'Shown', expression: `floor(${trimmed(mean, 1)} + 0.5)`, result: String(shown) }],
    rounding: 'The server rounds the mean to one decimal. The tile shows a whole number, rounded half up.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server over the cases this page analysed.',
    caveats: [
      'A case without a numeric risk score is left out.',
      ...(input.population === 'all time' ? [] : ['The page read only the newest cases, so older cases are not in the mean.']),
    ],
  };
}

/**
 * A figure the server computed that the Console cannot recompute from what it holds (a
 * rate whose numerator the payload does not carry): what it measures, over which window,
 * and that the server counted it. No arithmetic is printed rather than arithmetic that
 * does not give the figure.
 */
export function explainServerFigure(input: {
  metric: string;
  title: string;
  display: string;
  value: number;
  summary: string;
  formula: string;
  window: string;
  windowSource?: string;
  caveats?: string[];
}): Explanation {
  return {
    metric: input.metric,
    title: input.title,
    value: input.value,
    display: input.display,
    summary: input.summary,
    formula: input.formula,
    inputs: [{ key: 'window', label: 'Window', value: input.window, source: input.windowSource ?? 'The time range above' }],
    steps: [],
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server for this reading.',
    caveats: input.caveats ?? [],
  };
}

/**
 * Team activity's median time to acknowledge: the middle of the times from each case's
 * detection or creation to the first acknowledgement a person made inside the window
 * (`engine/team_activity.acknowledgement_seconds`). The server sends the median and the
 * number of cases, not the times, so the panel names the population and the rule. Null
 * when it was not measured.
 */
export function explainTeamAckMedian(input: {
  medianSeconds: number | null | undefined;
  samples: number;
  /** The median as the tile shows it ("2m 10s"). */
  shown: string;
  window: string;
}): Explanation | null {
  const { medianSeconds, samples } = input;
  if (typeof medianSeconds !== 'number' || !Number.isFinite(medianSeconds) || !(samples > 0)) return null;
  const middle =
    samples % 2 === 1
      ? `the time at rank ${count((samples + 1) / 2)} of ${count(samples)} sorted times`
      : `the mean of the times at ranks ${count(samples / 2)} and ${count(samples / 2 + 1)} of ${count(samples)} sorted times`;
  return {
    metric: 'team_median_ack',
    title: 'Median time to acknowledge',
    value: medianSeconds,
    display: input.shown,
    summary: `Median ${input.shown} over ${count(samples)} ${samples === 1 ? 'case' : 'cases'} a person first acknowledged, ${input.window}.`,
    formula: 'the middle of the sorted times from case detection or creation to the first acknowledgement by a person',
    inputs: [
      { key: 'samples', label: 'Cases measured', value: count(samples), source: 'Server count' },
      { key: 'median', label: 'Median', value: `${input.shown} (${trimmed(medianSeconds, 1)} seconds)`, source: 'Server' },
      { key: 'window', label: 'Window', value: input.window, source: 'The range above' },
    ],
    steps: [{ label: 'Median', expression: middle, result: input.shown }],
    rounding: 'The tile shows seconds under a minute, minutes and seconds under 10 minutes, then minutes and hours.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server from the audit rows and each case\'s own times.',
    caveats: [
      'A case counts when its first acknowledgement by a person falls inside the range. An acknowledgement by the agent or a system rule is not counted.',
      'Moving a case to investigating, escalated or on hold counts as an acknowledgement.',
    ],
  };
}

/**
 * SLA attainment before its explanation is read: the figure on screen and what it
 * divides (`MetricExplain` replaces it with the counts on open). Shared by the Analytics
 * Posture tab and the dashboard strip, so both say the same thing.
 */
export function slaAttainmentInitial(shown: string, window: string): Explanation {
  return {
    metric: 'sla_attainment',
    title: 'SLA attainment',
    value: shown,
    display: shown,
    summary: `${shown} of the cases scored against a target met them, ${window}.`,
    formula: 'cases that met every target / cases scored against a target',
    inputs: [{ key: 'window', label: 'Window', value: window, source: 'The time range above' }],
    steps: [],
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server over the cases in the window.',
    caveats: [],
  };
}

/**
 * The Posture tab's "At risk" count: the Console's sum of the response and resolve
 * clocks the server counted at risk (still running, at least 0.8 of the target passed).
 * One case can have both clocks at risk, so it can count twice.
 */
export function explainSlaAtRisk(input: {
  responseAtRisk: number | null | undefined;
  resolveAtRisk: number | null | undefined;
  window: string;
}): Explanation | null {
  const response = typeof input.responseAtRisk === 'number' ? input.responseAtRisk : 0;
  const resolve = typeof input.resolveAtRisk === 'number' ? input.resolveAtRisk : 0;
  if (typeof input.responseAtRisk !== 'number' && typeof input.resolveAtRisk !== 'number') return null;
  const total = response + resolve;
  return {
    metric: 'sla_at_risk',
    title: 'At risk',
    value: total,
    display: count(total),
    summary: `${count(response)} response + ${count(resolve)} resolve clocks at risk = ${count(total)}, ${input.window}.`,
    formula: 'response clocks at risk + resolve clocks at risk',
    inputs: [
      { key: 'response_at_risk', label: 'Response clocks at risk', value: count(response), source: 'Server count' },
      { key: 'resolve_at_risk', label: 'Resolve clocks at risk', value: count(resolve), source: 'Server count' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps: [{ label: 'Sum', expression: `${count(response)} + ${count(resolve)}`, result: count(total) }],
    provenance: 'server_computed',
    provenanceNote: CONSOLE_DIVIDED.replace('divided', 'added'),
    caveats: [
      'A clock is at risk while it still runs and at least 80% of its target has passed.',
      'A case with both clocks at risk counts twice.',
    ],
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
  /**
   * The rank (0-based, in the sorted times of all `sampleCount` samples) of the first
   * listed sample. A long list is the run around the median, so the rank lines read the
   * ranks of the whole population, never the ranks inside the listed run.
   */
  samplesOffset?: number;
  /** Where the window comes from ("The time range above" when omitted). */
  windowSource?: string;
  link?: ExplanationLink;
}

/**
 * One percentile's rank line over ALL `total` sorted samples, when only the run
 * `listed` (sorted, starting at rank `offset`) is in hand. `null` when either rank the
 * percentile interpolates between falls outside the listed run: no line is better than a
 * line that computes a different number from the one shown.
 */
export function rankLineOverRun(
  name: string,
  q: number,
  listed: readonly number[],
  offset: number,
  total: number,
): ExplanationStep | null {
  if (!(total > 0) || !listed.length) return null;
  const rank = q * (total - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = listed[lower - offset];
  const hi = listed[upper - offset];
  if (lower < offset || upper - offset >= listed.length || lo === undefined || hi === undefined) return null;
  const result = lo + (rank - lower) * (hi - lo);
  const expression =
    lower === upper
      ? `rank ${trimmed(q, 2)} x (${count(total)} - 1) = ${trimmed(rank)}, the value at that rank`
      : `rank ${trimmed(q, 2)} x (${count(total)} - 1) = ${trimmed(rank)}; ${trimmed(lo)} + ${trimmed(rank - lower)} x (${trimmed(hi)} - ${trimmed(lo)})`;
  return { label: name, expression, result: `${trimmed(result)} minutes` };
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
      inputs: [{ key: 'window', label: 'Window', value: input.window, source: input.windowSource ?? 'The time range above' }],
      caveats: [],
      link: input.link,
    };
  }
  const n = block.count;
  const decider = deciderSteps(input.byDecider);
  let caveats = [...base.caveats];
  let rankLines = base.steps;
  const listed = input.samples;
  if (listed && input.sampleCount && listed.length < input.sampleCount) {
    // Only the run around the median is listed: the rank lines read the ranks of all
    // `sampleCount` samples (from `samplesOffset`), so they reproduce the shown figure.
    const offset = Math.max(0, Math.floor(input.samplesOffset ?? 0));
    const sorted = listed.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
    const p50 = rankLineOverRun('p50', 0.5, sorted, offset, input.sampleCount);
    const p90 = rankLineOverRun('p90', 0.9, sorted, offset, input.sampleCount);
    rankLines = [p50, p90].filter((line): line is ExplanationStep => line !== null);
    caveats = [
      `The list holds ranks ${count(offset + 1)} to ${count(offset + sorted.length)} of ${count(input.sampleCount)}, the cases around the median.`,
      ...(p90 ? [] : ['The p90 ranks fall outside the listed cases, so its line is not shown.']),
    ];
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
      { key: 'window', label: 'Window', value: input.window, source: input.windowSource ?? 'The time range above' },
    ],
    steps: [...rankLines, ...decider],
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
  dwell:
    'From case creation (or detection when recorded) to the first response by a person: investigating, escalated, on hold, resolved or closed. Automatic closes are not counted, so dwell equals time to acknowledge unless a person closes a case without acknowledging it first.',
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
