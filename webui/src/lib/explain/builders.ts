/**
 * The Explain builders (Round 16 SPEC §4.5 WP11; WP01 fixed the signatures).
 *
 * One pure builder per kind of number. Each returns a typed `Explanation` (or `null`
 * when it cannot explain the value honestly) and never renders anything: the Explain
 * kit (`@/design-system/explain`) renders it. Every builder prints the numbers
 * `./explain.contract.json` pins for the server, so the two ends cannot disagree. Every
 * case-derived string stays a plain text value (#9).
 *
 * Each case builder lives in its own small file and is re-exported here; the dashboard
 * builders below (a change chip, a share of a whole-percent split, a sum of rows, a
 * quotient and a Wilson lower bound) live in this module. None of them reaches the entry
 * chunk (they are imported from lazy route chunks only).
 */
import { count, percentOf, plain, trimmed } from './rounding';
import { explainWilson, wilsonInterval } from './stats';
import type { Explanation, ExplanationStep } from './types';

export {
  explainRisk,
  explainRiskScore,
  recordedRiskInputs,
  riskHoverLine,
  memberCountNote,
  type AssetRangeReading,
  type RiskExplainSource,
} from './risk';
export {
  explainDecision,
  explainPolicyToday,
  readDecision,
  compareWithPolicy,
  comparisonSentence,
  type DecisionReading,
  type DecisionGate,
} from './decision';
export {
  explainSla,
  shownSlaClock,
  slaClockState,
  SLA_AT_RISK_FRACTION,
  type SlaReadingWire,
  type SlaClockWire,
  type SlaClockState,
} from './sla';
export { explainPriority, explainSeverity, triageBand } from './triage';
export { explainTimeToDetect } from './times';
export { explainShare, explainPercentile, explainWilson, percentile, wilsonInterval } from './stats';
export { explainCost, recomputeCost } from './cost';
export { explanationText, PROVENANCE_WORDS } from './text';

// --------------------------------------------------------------------------- //
// Dashboard builders (acceptance package FXD1)
// --------------------------------------------------------------------------- //

/** A signed value as a chip prints it: "+35", "-2.5", "0". */
function signed(value: number, term: (n: number) => string): string {
  if (value === 0) return term(0);
  return `${value > 0 ? '+' : '-'}${term(Math.abs(value))}`;
}

function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export interface ChangeExplainInput {
  metric: string;
  /** The figure the chip compares ("FP rate"). */
  title: string;
  /** Exactly what the chip shows ("+108.9%", "+35", "new"). */
  shown: string;
  /**
   * `relative`: (now - before) / before x 100, a percent of the earlier figure.
   * `difference`: now - before, in the figure's own unit.
   */
  kind: 'relative' | 'difference';
  now: number;
  before: number;
  /** A value as the hover line names it ("69.64%", "56 cases"). */
  words: (n: number) => string;
  /** A value inside the arithmetic, with no grouping ("69.64", "56"). */
  term: (n: number) => string;
  /** The unit after a difference (" minutes"), when it has one. */
  unit?: string;
  /** The window of `now` ("in the last 7 days") and of `before` ("in the 7 days before"). */
  window: string;
  beforeWindow: string;
  /** True when the two values are percentages: the change is then not in points. */
  ofPercent?: boolean;
  /** How the chip's figure was rounded. */
  rounding: string;
  /** Where the two values came from. */
  source: string;
  provenanceNote: string;
  caveats?: string[];
}

/**
 * A change chip explained: both values, the window of each and the arithmetic that gives
 * the chip. A relative change says it is relative, so "+108.9%" beside a rate never
 * reads as percentage points.
 */
export function explainChange(input: ChangeExplainInput): Explanation | null {
  const { now, before, term } = input;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  const nowWords = input.words(now);
  const beforeWords = input.words(before);
  const base = {
    metric: input.metric,
    title: `${input.title}, change`,
    display: input.shown,
    inputs: [
      { key: 'now', label: `Now, ${input.window.replace(/^in /, '')}`, value: nowWords, source: input.source },
      { key: 'before', label: `Before, ${input.beforeWindow.replace(/^in /, '')}`, value: beforeWords, source: input.source },
    ],
    rounding: input.rounding,
    provenance: 'server_computed' as const,
    provenanceNote: input.provenanceNote,
  };
  const lead = `${nowWords} ${input.window} and ${beforeWords} ${input.beforeWindow}.`;
  const diff = now - before;
  const unit = input.unit ?? '';
  if (input.kind === 'relative' && before === 0) {
    return {
      ...base,
      value: null,
      summary: `${lead} There is no earlier figure to divide by, so the change reads "${input.shown}".`,
      formula: '(now - before) / before x 100',
      steps: [],
      caveats: ['A change relative to zero has no size.', ...(input.caveats ?? [])],
    };
  }
  if (input.kind === 'difference') {
    const printed = `${signed(diff, term)}${unit}`;
    const steps: ExplanationStep[] = [{ label: 'Difference', expression: `${term(now)} - ${term(before)}`, result: printed }];
    if (printed !== input.shown) {
      steps.push({ label: 'Shown', expression: `${printed}, as the chip writes it`, result: input.shown });
    }
    // A chip that writes the difference in another form (a duration) says both, so the
    // hover line never equates minutes with "+1h 5m" without saying which is which.
    const result = printed === input.shown ? input.shown : `${printed}, shown ${input.shown}`;
    return {
      ...base,
      value: diff,
      summary: `${lead} ${term(now)} - ${term(before)} = ${result}.`,
      formula: 'now - before',
      steps,
      caveats: input.caveats ?? [],
    };
  }
  const rel = (100 * diff) / before;
  const relText = `${signed(Number(plain(rel, 2)), (n) => plain(n, 2))}%`;
  const points = input.ofPercent ? ' It is relative to the earlier figure, not a difference in percentage points.' : '';
  return {
    ...base,
    value: rel,
    summary: `${lead} (${term(now)} - ${term(before)}) / ${term(before)} x 100 = ${input.shown}.${points}`,
    formula: '(now - before) / before x 100',
    steps: [
      { label: 'Difference', expression: `${term(now)} - ${term(before)}`, result: signed(diff, term) },
      { label: 'Relative change', expression: `(${term(now)} - ${term(before)}) / ${term(before)} x 100`, result: relText },
      { label: 'Shown', expression: `${relText}, rounded`, result: input.shown },
    ],
    caveats: [
      ...(input.ofPercent ? ['The change is relative: a rate that goes from 10% to 15% is +50%, not +5 points.'] : []),
      ...(input.caveats ?? []),
    ],
  };
}

export interface PartitionPart {
  key: string;
  /** The part in words ("closed by the AI agent"). */
  label: string;
  count: number;
}

/**
 * Whole percents of `whole` that add up to exactly 100 (largest remainder, ties to the
 * earlier part): each share is rounded down, and the points left go to the largest
 * fractions. The close-attribution card's own rule, so the explanation prints the
 * percent the card shows. Null when the parts do not add up to the whole.
 */
export function wholePercentSplit(parts: readonly number[], whole: number): number[] | null {
  if (!Number.isFinite(whole) || whole <= 0 || !parts.length) return null;
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.reduce((a, b) => a + b, 0) !== whole) return null;
  const exact = parts.map((p) => (p / whole) * 100);
  const out = exact.map((v) => Math.floor(v));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && left > 0; k += 1) {
    out[order[k].i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * One part of a split into whole percents explained: its count over the whole, the exact
 * percent, and how the largest-remainder rule gives the whole percent shown, so "45 73%"
 * reads 45 / 62 = 72.58%, shown 73%.
 */
export function explainPartitionShare(input: {
  metric: string;
  title: string;
  parts: readonly PartitionPart[];
  index: number;
  /** What the whole counts, plural ("closed cases"). */
  wholeLabel: string;
  window: string;
  source: string;
  caveats?: string[];
}): Explanation | null {
  const { parts, index } = input;
  const part = parts[index];
  if (!part) return null;
  const whole = parts.reduce((a, p) => a + p.count, 0);
  const split = wholePercentSplit(
    parts.map((p) => p.count),
    whole,
  );
  if (!split) return null;
  const exact = parts.map((p) => (100 * p.count) / whole);
  const floors = exact.map((v) => Math.floor(v));
  const floorSum = floors.reduce((a, b) => a + b, 0);
  const left = 100 - floorSum;
  const shown = split[index];
  const got = shown - floors[index];
  const steps: ExplanationStep[] = [
    { label: 'Share', expression: `${count(part.count)} / ${count(whole)} x 100`, result: `${plain(exact[index], 2)}%` },
    {
      label: 'Rounded down',
      expression: exact.map((v) => `floor(${plain(v, 2)})`).join(' + '),
      result: `${floors.join(' + ')} = ${floorSum}`,
    },
  ];
  if (left > 0) {
    const takers = split.map((v, i) => (v > floors[i] ? parts[i].label : null)).filter(Boolean);
    steps.push({ label: 'Points left', expression: `100 - ${floorSum}, to the largest fractions (${takers.join('; ')})`, result: String(left) });
  }
  steps.push({ label: 'Shown', expression: got > 0 ? `${floors[index]} + ${got}` : `${floors[index]}`, result: `${shown}%` });
  return {
    metric: input.metric,
    title: input.title,
    value: part.count / whole,
    display: `${shown}%`,
    summary: `${count(part.count)} ${part.label} of ${count(whole)} ${input.wholeLabel} = ${plain(exact[index], 1)}%, shown ${shown}%, ${input.window}.`,
    formula: 'part / whole x 100, as whole percents that add up to 100',
    inputs: [
      ...parts.map((p) => ({ key: p.key, label: capitalise(p.label), value: count(p.count), source: input.source })),
      { key: 'whole', label: capitalise(input.wholeLabel), value: count(whole), source: input.source },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps,
    rounding:
      'Each share is rounded down to a whole percent, and the points left go to the largest fractions, so the shares add up to 100.',
    provenance: 'server_computed',
    provenanceNote: 'The Console divided counts the server returned for this window.',
    caveats: input.caveats ?? [],
  };
}

/** The close-attribution bands, in the card's order, as the explanation names them. */
const CLOSE_BANDS = [
  { key: 'ai', label: 'closed by the AI agent' },
  { key: 'human', label: 'closed by a person' },
  { key: 'system', label: 'closed by the system or with no recorded decider' },
] as const;

/**
 * One Human vs AI figure explained (FXD1): the band's count over the window's closed
 * cases, with the card's whole-percent rule. The base is said out loud, because a strip
 * beside it may show the same count over the decided cases instead.
 */
export function explainCloseShare(
  totals: { ai: number; human: number; system: number; closed: number },
  band: 'ai' | 'human' | 'system',
  window: string,
): Explanation | null {
  const parts = CLOSE_BANDS.map((b) => ({ key: b.key, label: b.label, count: totals[b.key] }));
  if (parts.reduce((a, p) => a + p.count, 0) !== totals.closed) return null;
  return explainPartitionShare({
    metric: `close_share_${band}`,
    title: 'Human vs AI',
    parts,
    index: CLOSE_BANDS.findIndex((b) => b.key === band),
    wholeLabel: 'closed cases',
    window,
    source: 'Server count',
    caveats: [
      'The base is the closed cases that arrived in this window. A share of decided cases counts every first decision instead, so the same count can read a different percent there.',
      'Who closed a case is the last decider it records, and analyst rule policy closes are left out.',
    ],
  });
}

/**
 * A total explained as the sum of its rows ("$0.100062 + $0.036219 = $0.136281"): each
 * row at full precision, the sum, and the rounding to the figure shown. A total the rows
 * do not reach says so instead of printing a sum that does not give it.
 */
export function explainRowSum(input: {
  metric: string;
  title: string;
  rows: ReadonlyArray<{ label: string; value: number }>;
  /** The total the server returned (what the tile shows, before rounding). */
  total: number;
  /** The figure the tile shows. */
  shown: string;
  /** A value inside the arithmetic, at full precision. */
  term: (n: number) => string;
  /** What one row is ("model"). */
  rowNoun: string;
  window: string;
  /** Where the window comes from (default "The time range above"). */
  windowSource?: string;
  source: string;
  rounding: string;
  /**
   * How far the rows may fall from the total because the server rounds each row on its
   * own (for spend, half a millionth per row). Within it the sum is still printed, with
   * the residue said; beyond it the rows do not reach the total. Default: exact.
   */
  tolerance?: number;
  /** Why the rows can fall short of the total ("The summary lists at most 10 models."). */
  shortfall?: string;
  caveats?: string[];
}): Explanation | null {
  const { rows, total, term } = input;
  if (!Number.isFinite(total)) return null;
  const sum = rows.reduce((a, r) => a + (Number.isFinite(r.value) ? r.value : 0), 0);
  const diff = Math.abs(sum - total);
  const exact = diff <= Math.max(1e-9, Math.abs(total) * 1e-9);
  const adds = exact || diff <= (input.tolerance ?? 0) + 1e-12;
  const terms = rows.map((r) => term(r.value)).join(' + ');
  const nouns = `${rows.length} ${input.rowNoun}${rows.length === 1 ? '' : 's'}`;
  const caveats = [...(input.caveats ?? [])];
  if (rows.length && !adds) {
    const why = input.shortfall ? ` ${input.shortfall}` : '';
    caveats.unshift(`The ${nouns} listed add up to ${term(sum)}; the total the server returned is ${term(total)}.${why}`);
  } else if (rows.length && !exact) {
    caveats.unshift(
      `The server rounds each row and the total on their own, so the rows add up to ${term(sum)} against its total of ${term(total)}.`,
    );
  }
  const steps: ExplanationStep[] = rows.length && adds ? [{ label: 'Sum', expression: terms, result: term(sum) }] : [];
  if (rows.length && adds && !exact) {
    steps.push({ label: 'Server total', expression: 'the total the server returned', result: term(total) });
  }
  if (term(total) !== input.shown) {
    steps.push({ label: 'Shown', expression: `${term(total)}, rounded`, result: input.shown });
  }
  return {
    metric: input.metric,
    title: input.title,
    value: total,
    display: input.shown,
    summary:
      rows.length && adds
        ? rows.length <= 4
          ? `${input.shown} = ${terms} over ${nouns}, ${input.window}.`
          : `${input.shown} is the sum of ${nouns}, ${input.window}.`
        : `${input.shown}, ${input.window}.`,
    formula: `sum of the ${input.rowNoun} rows`,
    inputs: [
      ...rows.map((r, i) => ({ key: `row_${i}`, label: r.label, value: term(r.value), source: input.source })),
      { key: 'window', label: 'Window', value: input.window, source: input.windowSource ?? 'The time range above' },
    ],
    steps,
    rounding: input.rounding,
    provenance: 'server_computed',
    provenanceNote: 'The Console added up the rows the server returned for this window.',
    caveats,
  };
}

/** A quotient explained: "$0.1416 investigation spend / 14 verdicted cases = $0.0101". */
export function explainQuotient(input: {
  metric: string;
  title: string;
  numerator: number;
  denominator: number;
  /** The numerator and the denominator in words ("investigation spend", "verdicted cases"). */
  numeratorLabel: string;
  denominatorLabel: string;
  /** The numerator inside the arithmetic. */
  numeratorTerm: (n: number) => string;
  /** The quotient at full precision. */
  resultTerm: (n: number) => string;
  /** The figure shown. */
  shown: string;
  window: string;
  rounding: string;
  caveats?: string[];
}): Explanation | null {
  const { numerator, denominator } = input;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !(denominator > 0)) return null;
  const value = numerator / denominator;
  const expression = `${input.numeratorTerm(numerator)} / ${count(denominator)}`;
  return {
    metric: input.metric,
    title: input.title,
    value,
    display: input.shown,
    summary: `${input.numeratorTerm(numerator)} ${input.numeratorLabel} / ${count(denominator)} ${input.denominatorLabel} = ${input.shown}, ${input.window}.`,
    formula: `${input.numeratorLabel} / ${input.denominatorLabel}`,
    inputs: [
      { key: 'numerator', label: capitalise(input.numeratorLabel), value: input.numeratorTerm(numerator), source: 'Server sum' },
      { key: 'denominator', label: capitalise(input.denominatorLabel), value: count(denominator), source: 'Server count' },
      { key: 'window', label: 'Window', value: input.window, source: 'The time range above' },
    ],
    steps: [
      { label: 'Quotient', expression, result: input.resultTerm(value) },
      { label: 'Shown', expression: `${input.resultTerm(value)}, rounded`, result: input.shown },
    ],
    rounding: input.rounding,
    provenance: 'server_computed',
    provenanceNote: 'The Console divided two figures the server returned for this window.',
    caveats: input.caveats ?? [],
  };
}

/**
 * A rate the tuner stores as a Wilson lower bound explained: the counts, the bound
 * recomputed from them, and the whole percent shown, so "89%" beside "30 of 30" reads as
 * the lower end of a 95% range, not as a ratio no count gives.
 */
export function explainWilsonLowerBound(input: {
  metric: string;
  title: string;
  successes: number;
  n: number;
  /** The bound the server stored (0..1). */
  stored: number;
  /** The figure shown ("89%"). */
  shown: string;
  /** What `successes` and `n` count ("false positives", "graded cases"). */
  successLabel: string;
  totalLabel: string;
  z?: number;
  caveats?: string[];
}): Explanation | null {
  const z = input.z ?? 1.96;
  const base = explainWilson(input.successes, input.n, z);
  const interval = wilsonInterval(input.successes, input.n, z);
  if (!base || !interval || !Number.isFinite(input.stored)) return null;
  const stored = `${plain(input.stored * 100, 2)}%`;
  const caveats = [...(input.caveats ?? [])];
  const range = z === 1.96 ? '95% range' : `range at z = ${trimmed(z)}`;
  const counts = `${count(input.successes)} ${input.successLabel} in ${count(input.n)} ${input.totalLabel}`;
  // A stored bound these counts do not give is never presented as their 95% bound: the
  // hover line says what the counts give and that the figure is the stored one.
  const matches = Math.abs(interval.low - input.stored) <= 0.0001;
  if (!matches) {
    caveats.unshift(
      `These counts give ${plain(interval.low * 100, 2)}%; the stored ${stored} may come from an earlier evaluation or another confidence level.`,
    );
  }
  const steps = matches
    ? [...base.steps, { label: 'Shown', expression: `${stored}, to a whole percent`, result: input.shown }]
    : [
        ...base.steps,
        { label: 'Stored', expression: 'the lower bound the tuner stored', result: stored },
        { label: 'Shown', expression: `${stored}, to a whole percent`, result: input.shown },
      ];
  return {
    ...base,
    metric: input.metric,
    title: input.title,
    value: input.stored,
    display: input.shown,
    summary: matches
      ? `${input.shown} is the lower end of the ${range} for ${counts} (${stored}).`
      : `${input.shown} is the lower bound the tuner stored (${stored}). The ${range} for ${counts} starts at ${plain(interval.low * 100, 2)}%.`,
    inputs: base.inputs.map((i) =>
      i.key === 'successes'
        ? { ...i, label: capitalise(input.successLabel), source: 'This rule' }
        : i.key === 'n'
          ? { ...i, label: capitalise(input.totalLabel), source: 'This rule' }
          : i,
    ),
    steps,
    rounding: 'The bound is stored with 4 decimals and shown as a whole percent.',
    caveats: [
      `It is a lower bound, not the observed ratio (${count(input.successes)} / ${count(input.n)} = ${percentOf(input.successes / input.n)}).`,
      ...caveats,
    ],
  };
}
