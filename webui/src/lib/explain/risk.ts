/**
 * The risk score explanation (Round 16 SPEC §4.5 WP11; research explainability §3, R2
 * and D5; bug B13).
 *
 * The score is a weighted mean of five stored factors. When the case recorded its inputs
 * (`risk_breakdown.inputs`, written beside `compute_risk` at scoring time), every factor's
 * arithmetic is shown from those inputs with the weights that were in force. When it did
 * not, the explanation says so, lists the stored factors and never pairs the case's
 * current member count with the Volume factor: a case keeps gaining events after it was
 * scored, so that count is not the count the score used.
 *
 * Pure: builds plain data, never markup. Every case-derived string is a text value (#9).
 */
import type { Case, RiskBreakdown, RiskInputs, RiskWeightsSnapshot } from '@/lib/types';
import type { StageRiskCalculation, TriageChips } from '@/soc/pages/CaseDetail.api';

import { displayBand, displayScore, fixed, trimmed } from './rounding';
import type { Explanation, ExplanationInput, ExplanationStep } from './types';

export const RISK_FACTOR_KEYS = ['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const;
export type RiskFactorKey = (typeof RISK_FACTOR_KEYS)[number];

export const RISK_FACTOR_LABELS: Record<RiskFactorKey, string> = {
  volume: 'Volume',
  velocity: 'Velocity',
  reputation: 'Reputation',
  diversity: 'Diversity',
  asset_criticality: 'Asset criticality',
};

const BAND_WORDS: Record<string, string> = {
  critical: 'Critical (74 to 100)',
  high: 'High (48 to 73)',
  medium: 'Medium (22 to 47)',
  low: 'Low (0 to 21)',
};

const REPUTATION_SOURCE: Record<string, string> = {
  enrichment: 'from enrichment',
  not_ip_entity: 'not looked up: the entity is not an IP address',
  enrichment_off: 'not looked up: enrichment is off',
  not_looked_up: 'not looked up for this scoring run',
};

const ASSET_MATCH: Record<string, string> = {
  exact: 'exact entry for this entity',
  network: 'matched an internal network range',
  none: 'no asset entry for this entity',
};

const RECORDED_ROUNDING =
  'Each factor is stored with 2 decimals and the total from the unrounded factors, so a hand sum of the stored factors can differ by up to 0.01.';

/** A weight as the hover line prints it: 2 decimals ("0.20"), or up to 4 when it has more. */
export function weightText(weight: number): string {
  return Math.abs(weight * 100 - Math.round(weight * 100)) < 1e-9 ? fixed(weight) : trimmed(weight, 4);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The five stored factors, in the score's order, when every one is a number. */
function storedFactors(breakdown: RiskBreakdown | null | undefined): Record<RiskFactorKey, number> | null {
  if (!breakdown) return null;
  const out = {} as Record<RiskFactorKey, number>;
  for (const key of RISK_FACTOR_KEYS) {
    const value = finite(breakdown[key]);
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}

/** The numbers every recorded-input sentence and row prints (the arithmetic needs them). */
const RECORDED_NUMBERS = [
  'event_count',
  'span_seconds',
  'effective_window_seconds',
  'rule_type_count',
  'reputation_input',
  'asset_value',
  'total_weight',
] as const;

/**
 * The inputs recorded at scoring (`risk_breakdown.inputs`), or null when the case has
 * none or they are not of the recorded shape (a store that left them out, a partial
 * document): such a case reads "not recorded", never "undefined events".
 */
export function recordedRiskInputs(breakdown: RiskBreakdown | null | undefined): RiskInputs | null {
  const inputs = breakdown?.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  const weights = inputs.weights as RiskWeightsSnapshot | undefined;
  if (!weights || typeof weights !== 'object' || RISK_FACTOR_KEYS.some((key) => finite(weights[key]) === null)) return null;
  if (RECORDED_NUMBERS.some((key) => finite((inputs as unknown as Record<string, unknown>)[key]) === null)) return null;
  return inputs;
}

const recordedInputs = recordedRiskInputs;

/**
 * The internal network range of TODAY's settings that holds the case's entity, from the
 * triage read (`asset_cidr`), which the server sends only to a person who may read the
 * settings. Labelled "current configuration": the range in force at scoring is not stored.
 */
export interface AssetRangeReading {
  cidr: string;
  criticality: number | null;
  /** Whether today's range gives the criticality the score recorded (null: not known). */
  matchesRecorded: boolean | null;
}

/** Add today's internal network range to a risk explanation, when it was read. */
function withAssetRange(explanation: Explanation, range: AssetRangeReading | null | undefined, recorded: RiskInputs | null): Explanation {
  if (!range || !range.cidr) return explanation;
  const inputs = [
    ...explanation.inputs,
    {
      key: 'asset_cidr',
      label: 'Internal network range',
      value:
        range.criticality !== null
          ? `${range.cidr}, criticality ${trimmed(range.criticality)} (current configuration)`
          : `${range.cidr} (current configuration)`,
      source: "Today's settings",
    },
  ];
  const caveats = [...explanation.caveats];
  if (range.matchesRecorded === false && recorded && range.criticality !== null) {
    caveats.push(
      `Today's range gives criticality ${trimmed(range.criticality)}, not the ${trimmed(recorded.asset_value)} recorded at scoring: the settings changed since.`,
    );
  }
  return { ...explanation, inputs, caveats };
}

/** The weighted sum of the stored factors, as the hover line prints it. */
function weightedTerms(weights: Record<RiskFactorKey, number>, factors: Record<RiskFactorKey, number>): string {
  return RISK_FACTOR_KEYS.map((key) => `${weightText(weights[key])} x ${trimmed(factors[key])}`).join(' + ');
}

function weightedSum(weights: Record<RiskFactorKey, number>, factors: Record<RiskFactorKey, number>): number {
  return RISK_FACTOR_KEYS.reduce((sum, key) => sum + weights[key] * factors[key], 0);
}

function memberCount(caseRecord: Pick<Case, 'member_event_keys' | 'member_event_ids'> | null | undefined): number | null {
  const keys = caseRecord?.member_event_keys?.length || caseRecord?.member_event_ids?.length || 0;
  return keys > 0 ? keys : null;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** The B13 sentence: the case's current member count beside the count the score used. */
export function memberCountNote(current: number | null, scored: number | null): string | null {
  if (current === null) return null;
  if (scored !== null && current === scored) return null;
  return scored !== null
    ? `The case now holds ${plural(current, 'event')}; the score was computed from the ${plural(scored, 'event')} in its scoring run.`
    : `The case now holds ${plural(current, 'event')}; the score was computed from the events in its scoring run.`;
}

/** The hover line for a score with recorded inputs (the contract's worked example). */
export function riskHoverLine(score: number, breakdown: RiskBreakdown): string | null {
  const inputs = recordedInputs(breakdown);
  const factors = storedFactors(breakdown);
  if (!inputs || !factors) return null;
  const denominator = inputs.zero_weight_fallback ? 1 : inputs.total_weight;
  return `Risk ${trimmed(score)} = (${weightedTerms(inputs.weights, factors)}) / ${fixed(denominator)}. Click for inputs.`;
}

function factorSteps(inputs: RiskInputs, factors: Record<RiskFactorKey, number>): ExplanationStep[] {
  const refs = inputs.refs ?? { volume: 50, velocity: 10, diversity: 5 };
  const steps: ExplanationStep[] = [];
  steps.push({
    label: RISK_FACTOR_LABELS.volume,
    expression: `min(100, 100 x ln(1 + ${inputs.event_count}) / ln(1 + ${refs.volume}))`,
    result: trimmed(factors.volume),
  });
  if (inputs.velocity_rule === 'below_min_events' || inputs.rate_per_minute === null) {
    steps.push({
      label: RISK_FACTOR_LABELS.velocity,
      expression: `0, because the cluster had ${plural(inputs.event_count, 'event')} (velocity needs at least 3)`,
      result: trimmed(factors.velocity),
    });
  } else {
    const raw = (100 * inputs.rate_per_minute) / refs.velocity;
    steps.push({
      label: RISK_FACTOR_LABELS.velocity,
      expression: `min(100, 100 x ${trimmed(inputs.rate_per_minute)} / ${trimmed(refs.velocity)})`,
      result: raw > 100 ? `${trimmed(factors.velocity)} (capped from ${trimmed(raw)})` : trimmed(factors.velocity),
    });
  }
  steps.push({
    label: RISK_FACTOR_LABELS.reputation,
    expression: `clamp(${trimmed(inputs.reputation_input)}, 0, 100)`,
    result: trimmed(factors.reputation),
  });
  steps.push({
    label: RISK_FACTOR_LABELS.diversity,
    expression: `min(100, 100 x ${inputs.rule_type_count} / ${refs.diversity})`,
    result: trimmed(factors.diversity),
  });
  steps.push({
    label: RISK_FACTOR_LABELS.asset_criticality,
    expression: `clamp(${trimmed(inputs.asset_value)}, 0, 100)`,
    result: trimmed(factors.asset_criticality),
  });
  return steps;
}

function recordedInputRows(inputs: RiskInputs): ExplanationInput[] {
  const source = 'Recorded at scoring';
  const window =
    inputs.span_seconds < inputs.effective_window_seconds
      ? `${trimmed(inputs.span_seconds)} s, counted as ${trimmed(inputs.effective_window_seconds)} s (the floor is 1 s)`
      : `${trimmed(inputs.span_seconds)} s`;
  const rows: ExplanationInput[] = [
    { key: 'event_count', label: 'Events in the scoring cluster', value: inputs.event_count.toLocaleString('en-US'), source },
    { key: 'span_seconds', label: 'First to last event', value: window, source },
    {
      key: 'rate_per_minute',
      label: 'Events per minute',
      value:
        inputs.rate_per_minute === null
          ? 'Not used (fewer than 3 events)'
          : `${inputs.event_count.toLocaleString('en-US')} / (${trimmed(inputs.effective_window_seconds)} s / 60) = ${trimmed(inputs.rate_per_minute)}`,
      source,
    },
    { key: 'rule_type_count', label: 'Distinct rule types', value: String(inputs.rule_type_count), source },
    {
      key: 'reputation_input',
      label: 'Reputation input',
      value: `${trimmed(inputs.reputation_input)}, ${REPUTATION_SOURCE[inputs.reputation_source] ?? inputs.reputation_source}`,
      source,
    },
    {
      key: 'asset_value',
      label: 'Asset criticality input',
      value: `${trimmed(inputs.asset_value)}, ${ASSET_MATCH[inputs.asset_match] ?? inputs.asset_match}`,
      source,
    },
    {
      key: 'weights',
      label: 'Weights',
      value: RISK_FACTOR_KEYS.map((key) => `${RISK_FACTOR_LABELS[key]} ${weightText(inputs.weights[key])}`).join(', '),
      source: 'In force at scoring',
    },
  ];
  if (inputs.rule_values?.length) {
    rows.push({ key: 'rule_values', label: 'Rule types', value: inputs.rule_values.join(', '), source });
  }
  return rows;
}

export interface RiskExplainSource {
  score: number | null | undefined;
  breakdown: RiskBreakdown | null | undefined;
  /** The case's member events now (never the scoring input). */
  memberCount?: number | null;
  /** A read-time reconstruction with today's weights (the stage timeline's), when known. */
  calculation?: StageRiskCalculation | null;
  /** Today's internal network range that holds the entity (`settings:read` only). */
  assetRange?: AssetRangeReading | null;
}

/**
 * The risk explanation from a score, its stored breakdown and, for a case scored before
 * the inputs were recorded, the reconstruction with today's weights. With today's
 * internal network range (read only by a person who may read the settings), the asset
 * input names it, labelled as today's configuration.
 */
export function explainRiskScore(source: RiskExplainSource): Explanation | null {
  const explanation = baseRiskExplanation(source);
  return explanation ? withAssetRange(explanation, source.assetRange, recordedInputs(source.breakdown)) : null;
}

function baseRiskExplanation(source: RiskExplainSource): Explanation | null {
  const score = finite(source.score);
  if (score === null) return null;
  const shown = displayScore(score) ?? 0;
  const band = displayBand(score);
  const display = `Risk ${shown}`;
  const factors = storedFactors(source.breakdown);
  const inputs = recordedInputs(source.breakdown);
  const bandLine = `Shown as ${shown} (rounded half up). Band ${BAND_WORDS[band]}.`;
  const base = {
    metric: 'risk_score',
    title: 'Risk score',
    value: score,
    display,
    formula: 'sum(weight x factor) / sum(weights), or / 1 when every weight is 0',
  };

  if (inputs && factors && source.breakdown) {
    const denominator = inputs.zero_weight_fallback ? 1 : inputs.total_weight;
    const numerator = weightedSum(inputs.weights, factors);
    const fromStored = numerator / denominator;
    const caveats: string[] = [];
    const note = memberCountNote(source.memberCount ?? null, inputs.event_count);
    if (note) caveats.push(note);
    if (Math.abs(fromStored - score) > 0.01) {
      caveats.push(
        `The stored factors with the recorded weights give ${trimmed(fromStored)}, not the stored ${trimmed(score)}.`,
      );
    }
    if (inputs.zero_weight_fallback) caveats.push('Every weight was 0, so the sum is divided by 1 and the score is 0.');
    return {
      ...base,
      summary: riskHoverLine(score, source.breakdown) ?? `${display}.`,
      inputs: recordedInputRows(inputs),
      steps: [
        ...factorSteps(inputs, factors),
        {
          label: 'Weighted sum',
          expression: weightedTerms(inputs.weights, factors),
          result: trimmed(numerator),
        },
        { label: 'Total', expression: `${trimmed(numerator)} / ${fixed(denominator)}`, result: trimmed(score) },
        { label: 'Shown', expression: `floor(${trimmed(score)} + 0.5)`, result: String(shown) },
      ],
      rounding: `${RECORDED_ROUNDING} ${bandLine}`,
      provenance: 'recorded',
      caveats,
      provenanceNote: inputs.scored_at
        ? `Weights and inputs recorded when this case was scored, ${inputs.scored_at}.`
        : 'Weights and inputs recorded when this case was scored.',
    };
  }

  const memberNote = memberCountNote(source.memberCount ?? null, null);
  const calculation = source.calculation;
  if (calculation && calculation.factors?.length) {
    const recorded = calculation.weight_basis === 'recorded_at_scoring';
    const terms = calculation.factors
      .map((f) => `${weightText(f.weight)} x ${trimmed(f.value)}`)
      .join(' + ');
    const caveats: string[] = [];
    if (!recorded) {
      caveats.push('The weights used at scoring were not recorded for this case, so the table uses today\'s weights.');
      if (!calculation.matches_displayed_score) {
        caveats.push(
          `Today's weights give ${trimmed(calculation.calculated_score)}, while this case records ${trimmed(calculation.recorded_score)}. The difference cannot be attributed exactly; the recorded score was not rewritten.`,
        );
      }
    }
    if (memberNote) caveats.push(memberNote);
    return {
      ...base,
      summary: `Risk ${trimmed(score)} = (${terms}) / ${weightText(calculation.denominator)}${
        recorded ? '' : ', with today\'s weights'
      }. Click for details.`,
      inputs: calculation.factors.map((f) => ({
        key: f.factor,
        label: f.label || RISK_FACTOR_LABELS[f.factor as RiskFactorKey] || f.factor,
        value: trimmed(f.value),
        source: 'Stored factor',
      })),
      steps: [
        ...calculation.factors.map((f) => ({
          label: f.label || RISK_FACTOR_LABELS[f.factor as RiskFactorKey] || f.factor,
          expression: `${weightText(f.weight)} x ${trimmed(f.value)}`,
          result: `${trimmed(f.weighted_value, 4)} points`,
        })),
        {
          label: 'Total',
          expression: `${trimmed(calculation.numerator, 4)} / ${weightText(calculation.denominator)}`,
          result: trimmed(calculation.calculated_score),
        },
        { label: 'Shown', expression: `floor(${trimmed(score)} + 0.5)`, result: String(shown) },
      ],
      rounding: bandLine,
      provenance: recorded ? 'recorded' : 'reconstructed_current',
      caveats,
    };
  }

  if (factors) {
    const list = RISK_FACTOR_KEYS.map((key) => `${RISK_FACTOR_LABELS[key].toLowerCase()} ${trimmed(factors[key])}`).join(', ');
    return {
      ...base,
      summary: `Risk ${trimmed(score)}: the inputs were not recorded for this case. Stored factors: ${list}.`,
      inputs: RISK_FACTOR_KEYS.map((key) => ({
        key,
        label: RISK_FACTOR_LABELS[key],
        value: trimmed(factors[key]),
        source: 'Stored factor',
      })),
      steps: RISK_FACTOR_KEYS.map((key) => ({
        label: RISK_FACTOR_LABELS[key],
        expression: 'Stored factor (inputs not recorded)',
        result: trimmed(factors[key]),
      })),
      rounding: bandLine,
      provenance: 'not_recorded',
      caveats: [
        'This case was scored before the inputs were recorded, so the factor arithmetic and the weights in force cannot be shown.',
        ...(memberNote ? [memberNote] : []),
      ],
    };
  }

  return {
    ...base,
    summary: `Risk ${trimmed(score)}: no factor breakdown was recorded for this case.`,
    inputs: [],
    steps: [{ label: 'Shown', expression: `floor(${trimmed(score)} + 0.5)`, result: String(shown) }],
    rounding: bandLine,
    provenance: 'not_recorded',
    caveats: ['No factor breakdown was recorded, so the score cannot be broken down.'],
  };
}

/** The risk score of a case: its stored factors, recorded inputs and the weights. */
export function explainRisk(caseRecord: Case, chips?: TriageChips | null): Explanation | null {
  const breakdown =
    caseRecord.risk_breakdown ?? ((chips?.risk?.breakdown as RiskBreakdown | undefined) ?? null);
  const score = finite(caseRecord.risk_score) ?? finite(chips?.risk?.value);
  return explainRiskScore({ score, breakdown, memberCount: memberCount(caseRecord) });
}
