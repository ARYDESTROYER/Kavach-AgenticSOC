/**
 * The deterministic decision explanation (Round 16 SPEC §4.5 WP11; research
 * explainability R3, R4, D1 and D8).
 *
 * `decide()` closes a case only when its verdict class has auto-close on, the confidence
 * is at least the class's minimum AND the risk is at most its maximum. A needs-human
 * verdict never closes automatically: that is fixed by code, not by policy. This module
 * states both conditions with the real numbers, from the gate recorded at decision time
 * when the decision span carries one, otherwise from today's policy clause (labelled so).
 *
 * The decision span of a build before the recorded gate is a READ-TIME re-run with
 * today's policy. It is never presented as the recorded decision: the recorded decision
 * is the case's own status, decider and objection window (D1).
 *
 * Pure: plain data only (#9). Nothing here decides anything (#3).
 */
import type { Case } from '@/lib/types';
import type { DecisionPayload } from '@/soc/pages/CaseDetail.api';

import { trimmed } from './rounding';
import type { Explanation, ExplanationInput, ExplanationProvenance, ExplanationStep } from './types';

/** The gate recorded on the DECISION audit row (WP10), as the decision span carries it. */
export interface DecisionGate {
  verdict: string | null;
  confidence: number | null;
  risk_score: number | null;
  class_enabled: boolean | null;
  min_confidence: number | null;
  max_risk_score: number | null;
  objection_window_minutes: number | null;
  escalation_confidence: number | null;
  critical_severity: number | null;
  outcome: string | null;
}

/** One auto-close policy entry (enabled, the two bars, the objection window). */
export interface DecisionThresholds {
  enabled: boolean | null;
  min_confidence: number | null;
  max_risk_score: number | null;
  objection_window_minutes: number | null;
  /** A code-fixed note (a needs-human verdict never auto-closes). */
  note: string | null;
}

/** What a decision span says, read defensively from any build's payload. */
export interface DecisionReading {
  /** `recorded` when the span reports the decision recorded at the time. */
  source: 'recorded' | 'read_time' | null;
  gate: DecisionGate | null;
  /** Today's policy for the verdict class (the clause of an older build, or `current_policy`). */
  current: DecisionThresholds | null;
  /** True when today's policy would decide differently from the recorded decision. */
  policyChanged: boolean | null;
  status: string | null;
  decisionBy: string | null;
  objectionWindowExpiresAt: string | null;
  ts: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function thresholds(value: unknown): DecisionThresholds | null {
  const entry = record(value);
  if (!entry) return null;
  return {
    enabled: bool(entry.enabled) ?? bool(entry.auto_closable) ?? bool(entry.class_enabled),
    min_confidence: num(entry.min_confidence),
    max_risk_score: num(entry.max_risk_score),
    objection_window_minutes: num(entry.objection_window_minutes),
    note: str(entry.note),
  };
}

/** Read a decision span payload of any build into one shape. */
export function readDecision(payload: DecisionPayload | Record<string, unknown> | null | undefined): DecisionReading | null {
  const p = record(payload);
  if (!p) return null;
  const g = record(p.gate);
  const gate: DecisionGate | null = g
    ? {
        verdict: str(g.verdict),
        confidence: num(g.confidence),
        risk_score: num(g.risk_score),
        class_enabled: bool(g.class_enabled),
        min_confidence: num(g.min_confidence),
        max_risk_score: num(g.max_risk_score),
        objection_window_minutes: num(g.objection_window_minutes),
        escalation_confidence: num(g.escalation_confidence),
        critical_severity: num(g.critical_severity),
        outcome: str(g.outcome),
      }
    : null;
  const source = str(p.source);
  return {
    source: source === 'recorded' ? 'recorded' : source ? 'read_time' : null,
    gate,
    current: thresholds(p.current_policy) ?? thresholds(p.policy_clause),
    policyChanged: bool(p.policy_changed),
    status: str(p.decision_status) ?? str(p.status),
    decisionBy: str(p.decision_by),
    objectionWindowExpiresAt: str(p.objection_window_expires_at),
    ts: str(p.ts),
  };
}

/** The verdict class a policy entry applies to (B27's rule). */
export function verdictClass(verdict: unknown): 'false_positive' | 'true_positive' | 'needs_human' {
  const v = typeof verdict === 'string' ? verdict.trim().toUpperCase() : '';
  if (v === 'FALSE_POSITIVE' || v === 'BENIGN') return 'false_positive';
  if (v === 'TRUE_POSITIVE') return 'true_positive';
  return 'needs_human';
}

const CLASS_WORDS = {
  false_positive: 'false positives',
  true_positive: 'true positives',
  needs_human: 'this verdict',
} as const;

/** "97%" for a 0..1 confidence (a whole percent, half up). */
function pct(fraction: number): string {
  return `${Math.floor(fraction * 100 + 0.5)}%`;
}

/**
 * Two numbers of one comparison, shown with just enough decimals that the shown pair
 * never contradicts the comparison: 0.849 against a 0.85 bar reads "84.9% >= 85% (not
 * met)", never "85% >= 85% (not met)". `format(value, digits)` prints one number.
 */
function comparisonPair(
  value: number,
  bar: number,
  met: boolean,
  startDigits: number,
  format: (n: number, digits: number) => string,
): [string, string] {
  let digits = startDigits;
  let pair: [string, string] = [format(value, digits), format(bar, digits)];
  while (!met && value !== bar && pair[0] === pair[1] && digits < startDigits + 4) {
    digits += 1;
    pair = [format(value, digits), format(bar, digits)];
  }
  return pair;
}

const percentDigits = (fraction: number, digits: number): string =>
  digits === 0 ? pct(fraction) : `${trimmed(fraction * 100, digits)}%`;

/** True when `decision_by` names a person (never the analyst-policy declaration). */
export function decidedByPerson(decisionBy: unknown): boolean {
  const d = typeof decisionBy === 'string' ? decisionBy.trim().toLowerCase() : '';
  if (!d || d === 'analyst_policy') return false;
  return d.includes('analyst') || d.includes('human') || d.includes('operator');
}

export interface DecisionComparison {
  verdict: string | null;
  confidence: number | null;
  risk: number | null;
  klass: 'false_positive' | 'true_positive' | 'needs_human';
  enabled: boolean | null;
  minConfidence: number | null;
  maxRisk: number | null;
  confidenceMet: boolean | null;
  riskMet: boolean | null;
  /** What the policy alone does with these numbers. */
  policyOutcome: 'closes' | 'routes' | 'fixed_by_code' | 'class_off' | 'unknown';
}

/** Compare a verdict, confidence and risk with one policy entry, as `decide()` does. */
export function compareWithPolicy(
  verdict: string | null,
  confidence: number | null,
  risk: number | null,
  policy: Pick<DecisionThresholds, 'enabled' | 'min_confidence' | 'max_risk_score'> | null,
): DecisionComparison {
  const klass = verdictClass(verdict);
  const minConfidence = policy?.min_confidence ?? null;
  const maxRisk = policy?.max_risk_score ?? null;
  const confidenceMet = confidence !== null && minConfidence !== null ? confidence >= minConfidence : null;
  const riskMet = risk !== null && maxRisk !== null ? risk <= maxRisk : null;
  const enabled = policy?.enabled ?? null;
  let policyOutcome: DecisionComparison['policyOutcome'] = 'unknown';
  if (klass === 'needs_human') policyOutcome = 'fixed_by_code';
  else if (enabled === false) policyOutcome = 'class_off';
  else if (enabled === true && confidenceMet !== null && riskMet !== null) {
    policyOutcome = confidenceMet && riskMet ? 'closes' : 'routes';
  }
  return { verdict, confidence, risk, klass, enabled, minConfidence, maxRisk, confidenceMet, riskMet, policyOutcome };
}

/** One condition as a sentence fragment: "confidence 97% >= 85% (met)". */
export function conditionText(kind: 'confidence' | 'risk', c: DecisionComparison): string | null {
  if (kind === 'confidence') {
    if (c.confidence === null || c.minConfidence === null) return null;
    const [value, bar] = comparisonPair(c.confidence, c.minConfidence, Boolean(c.confidenceMet), 0, percentDigits);
    return `confidence ${value} >= ${bar} (${c.confidenceMet ? 'met' : 'not met'})`;
  }
  if (c.risk === null || c.maxRisk === null) return null;
  const [value, bar] = comparisonPair(c.risk, c.maxRisk, Boolean(c.riskMet), 2, trimmed);
  return `risk ${value} <= ${bar} (${c.riskMet ? 'met' : 'not met'})`;
}

/**
 * The one-line reading of a comparison, for the hover and the case's policy line. With
 * `basis: 'current'` the thresholds are today's policy, not the ones in force at the
 * decision, and the sentence says so rather than reading as what happened (D1).
 */
export function comparisonSentence(c: DecisionComparison, basis?: 'current'): string {
  if (c.policyOutcome === 'fixed_by_code') {
    return 'Needs a person: a needs-human verdict never closes automatically. This is fixed by code, not by policy.';
  }
  const today = basis === 'current';
  const routes = today ? "Today's policy routes it to a person" : 'Routed to a person';
  if (c.policyOutcome === 'class_off') {
    return `${routes}: auto-close is off for ${CLASS_WORDS[c.klass]}.`;
  }
  const conf = conditionText('confidence', c);
  const risk = conditionText('risk', c);
  if (c.policyOutcome === 'closes') {
    return `${today ? "Today's policy closes it automatically" : 'Closes automatically'}: ${conf} and ${risk}.`;
  }
  if (c.policyOutcome === 'routes') return `${routes}: ${conf}; ${risk}.`;
  return 'The auto-close thresholds are not known for this decision.';
}

/** Sentence-case words for a verdict token ("False positive"). */
export function verdictLabel(verdict: string | null): string {
  const v = (verdict || '').trim().toUpperCase();
  if (v === 'FALSE_POSITIVE') return 'False positive';
  if (v === 'TRUE_POSITIVE') return 'True positive';
  if (v === 'NEEDS_HUMAN') return 'Needs human review';
  if (v === 'BENIGN') return 'Benign';
  const words = v.toLowerCase().replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'No verdict';
}

function outcomeWords(status: string | null, decisionBy: string | null): string {
  const s = (status || '').toLowerCase();
  const person = decidedByPerson(decisionBy);
  if (s === 'closed' || s === 'resolved') {
    if ((decisionBy || '').toLowerCase() === 'analyst_policy') return 'Closed by an analyst policy';
    return person ? 'Closed by a person' : 'Closed automatically';
  }
  if (s === 'escalated') return 'Escalated';
  if (!s) return 'Not decided yet';
  return person ? 'Handled by a person' : 'Routed to a person';
}

/** How the deterministic decision compared the verdict with the auto-close policy. */
export function explainDecision(caseRecord: Case, decision?: DecisionPayload | null): Explanation | null {
  if (!caseRecord) return null;
  const reading = readDecision(decision ?? null);
  const gate = reading?.gate ?? null;
  const verdict = gate?.verdict ?? (typeof caseRecord.verdict === 'string' ? caseRecord.verdict : null);
  if (!verdict) return null;
  const confidence =
    gate?.confidence ?? num(decision?.confidence) ?? num(caseRecord.confidence);
  const risk = gate?.risk_score ?? num(decision?.risk_score) ?? num(caseRecord.risk_score);
  const recordedThresholds: DecisionThresholds | null = gate
    ? {
        enabled: gate.class_enabled,
        min_confidence: gate.min_confidence,
        max_risk_score: gate.max_risk_score,
        objection_window_minutes: gate.objection_window_minutes,
        note: null,
      }
    : null;
  const policy = recordedThresholds ?? reading?.current ?? null;
  const comparison = compareWithPolicy(verdict, confidence, risk, policy);

  // The recorded decision: the case's own fields, unless the span says it reports the
  // recorded decision (an older span is a read-time re-run and never wins, D1).
  const recordedSpan = reading?.source === 'recorded';
  const status = (recordedSpan ? reading?.status : null) ?? (typeof caseRecord.status === 'string' ? caseRecord.status : null);
  const decisionBy =
    (recordedSpan ? reading?.decisionBy : null) ?? (typeof caseRecord.decision_by === 'string' ? caseRecord.decision_by : null);
  const outcome = outcomeWords(status, decisionBy);

  let provenance: ExplanationProvenance = 'not_recorded';
  let provenanceNote = 'The thresholds were not recorded for this decision.';
  if (recordedThresholds) {
    provenance = 'recorded';
    provenanceNote = 'Thresholds recorded when the decision was made.';
  } else if (policy) {
    provenance = 'reconstructed_current';
    provenanceNote = "Thresholds not recorded for this decision; these are today's policy values.";
  }
  if (comparison.klass === 'needs_human') {
    provenance = recordedThresholds ? 'recorded' : 'server_computed';
    provenanceNote = 'A needs-human verdict never closes automatically. This is fixed by code.';
  }

  const inputs: ExplanationInput[] = [
    { key: 'verdict', label: 'AI verdict', value: verdictLabel(verdict), source: gate ? 'Recorded at decision' : 'The case' },
  ];
  // The confidence and its bar share their decimals, so the two inputs never read equal
  // when the comparison says they differ.
  const [confidenceText, minConfidenceText] =
    confidence !== null && policy?.min_confidence != null
      ? comparisonPair(confidence, policy.min_confidence, Boolean(comparison.confidenceMet), 0, percentDigits)
      : [confidence !== null ? pct(confidence) : '', policy?.min_confidence != null ? pct(policy.min_confidence) : ''];
  if (confidence !== null) {
    inputs.push({ key: 'confidence', label: 'AI confidence', value: confidenceText, source: gate ? 'Recorded at decision' : 'The case' });
  }
  if (risk !== null) {
    inputs.push({ key: 'risk_score', label: 'Risk score', value: trimmed(risk), source: gate ? 'Recorded at decision' : 'The case' });
  }
  if (policy && comparison.klass !== 'needs_human') {
    const where = recordedThresholds ? 'Policy at decision' : "Today's policy";
    inputs.push({
      key: 'class_enabled',
      label: `Auto-close for ${CLASS_WORDS[comparison.klass]}`,
      value: policy.enabled === null ? 'Not known' : policy.enabled ? 'On' : 'Off',
      source: where,
    });
    if (policy.min_confidence !== null) {
      inputs.push({ key: 'min_confidence', label: 'Minimum confidence', value: minConfidenceText, source: where });
    }
    if (policy.max_risk_score !== null) {
      inputs.push({ key: 'max_risk_score', label: 'Maximum risk', value: trimmed(policy.max_risk_score), source: where });
    }
  }

  const steps: ExplanationStep[] = [];
  if (comparison.klass === 'needs_human') {
    steps.push({ label: 'Verdict class', expression: 'Needs a person', result: 'Never closes automatically' });
  } else {
    if (comparison.enabled !== null) {
      steps.push({
        label: 'Auto-close on',
        expression: `Auto-close for ${CLASS_WORDS[comparison.klass]}`,
        result: comparison.enabled ? 'On' : 'Off',
      });
    }
    const conf = conditionText('confidence', comparison);
    if (conf) steps.push({ label: 'Confidence', expression: conf.replace(/ \((?:met|not met)\)$/, ''), result: comparison.confidenceMet ? 'Met' : 'Not met' });
    const riskLine = conditionText('risk', comparison);
    if (riskLine) steps.push({ label: 'Risk', expression: riskLine.replace(/ \((?:met|not met)\)$/, ''), result: comparison.riskMet ? 'Met' : 'Not met' });
  }
  const policyResult: Record<DecisionComparison['policyOutcome'], string> = {
    closes: 'Closes automatically',
    routes: 'Routed to a person',
    fixed_by_code: 'Routed to a person',
    class_off: 'Routed to a person',
    unknown: 'Not known',
  };
  steps.push({ label: 'Policy result', expression: 'Both conditions met closes; otherwise a person decides', result: policyResult[comparison.policyOutcome] });
  steps.push({ label: 'Recorded decision', expression: decisionBy ? `Decided by ${decisionBy}` : 'The case status', result: outcome });

  const caveats: string[] = [];
  const s = (status || '').toLowerCase();
  if (decidedByPerson(decisionBy) && (s === 'closed' || s === 'resolved') && comparison.policyOutcome !== 'unknown') {
    steps.push({
      label: 'Policy check',
      expression: 'Would the policy alone have closed it?',
      result: comparison.policyOutcome === 'closes' ? 'Agrees' : 'Differs',
    });
    if (comparison.policyOutcome !== 'closes') {
      caveats.push('A person closed this case; the policy alone would have routed it to a person.');
    }
  }
  if (reading?.policyChanged) {
    // A changed policy does not always change the outcome: state today's reading with its
    // numbers instead of claiming a different decision.
    const today = recordedThresholds && reading.current ? compareWithPolicy(verdict, confidence, risk, reading.current) : null;
    caveats.push(
      today && today.policyOutcome !== 'unknown'
        ? `The auto-close policy changed after this decision. ${comparisonSentence(today, 'current')}`
        : 'The auto-close policy changed after this decision; today it would decide differently.',
    );
  }
  if (reading && !recordedSpan && !gate) {
    caveats.push('The decision record shows the case\'s own status and decider. The thresholds are today\'s values, not the ones in force at the time.');
  }

  const known = comparison.policyOutcome !== 'unknown';
  const numbers = [
    `AI verdict ${verdictLabel(verdict).toLowerCase()}`,
    confidence !== null ? `at ${pct(confidence)} confidence` : null,
    risk !== null ? `risk ${trimmed(risk)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    metric: 'decision',
    title: 'Deterministic decision',
    value: outcome,
    display: outcome,
    summary: known
      ? comparisonSentence(comparison, recordedThresholds ? undefined : 'current')
      : `${outcome}: ${numbers}. Select it to compare them with the auto-close policy.`,
    formula: 'Closes when auto-close is on for the verdict class, confidence >= minimum and risk <= maximum',
    inputs,
    steps,
    provenance,
    provenanceNote,
    caveats,
  };
}
