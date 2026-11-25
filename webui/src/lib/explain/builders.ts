/**
 * The Explain builders (Round 16 SPEC §4.5 WP11; WP01 fixed the signatures).
 *
 * One pure builder per kind of number. Each returns a typed `Explanation` (or `null`
 * when it cannot explain the value honestly) and never renders anything: the Explain
 * kit (`@/design-system/explain`) renders it. Every builder prints the numbers
 * `./explain.contract.json` pins for the server, so the two ends cannot disagree. Every
 * case-derived string stays a plain text value (#9).
 *
 * This module only re-exports: each builder lives in its own small file, and none of
 * them reaches the entry chunk (they are imported from lazy route chunks only).
 */
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
