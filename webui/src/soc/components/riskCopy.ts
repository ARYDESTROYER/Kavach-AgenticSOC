/**
 * riskCopy: the ONE source of truth for the authored risk and active-risk help copy.
 *
 * First written for the retired per-case triage header, it is now read by the Overview's
 * Active Risk Index help (`ACTIVE_RISK_HELP_TEXT`, through `ActiveRiskIndex.tsx`) and the
 * RiskCard help tip; `__tests__/riskCopy.test.ts` pins it.
 *
 * Round 16 (research explainability D7): the weights are not fixed. `riskHelpText` renders
 * the copy from the weights in force (an operator's `prefs.risk_weights`, or the snapshot
 * recorded when a case was scored); the constants are that rendering for the defaults.
 *
 * SECURITY (#9): all copy here is author-controlled (trusted) and rendered ONLY as
 * plain text inside a HelpTip Tooltip/Popover, never as markup.
 */

/** The five risk weights (`prefs.risk_weights`, or a recorded snapshot). */
export interface RiskWeightSet {
  volume: number;
  velocity: number;
  reputation: number;
  diversity: number;
  asset_criticality: number;
}

/** The shipped default weights (`backend/app/engine/risk.py`). */
export const DEFAULT_RISK_WEIGHTS: RiskWeightSet = {
  volume: 0.25,
  velocity: 0.2,
  reputation: 0.3,
  diversity: 0.15,
  asset_criticality: 0.1,
};

const FACTOR_WORDS: Array<[keyof RiskWeightSet, string]> = [
  ['volume', 'Volume'],
  ['velocity', 'Velocity'],
  ['reputation', 'Reputation'],
  ['diversity', 'Diversity'],
  ['asset_criticality', 'Asset criticality'],
];

const RISK_HELP_TAIL =
  'It only RANKS what an analyst looks at first; it never closes or escalates a case on its own.';

/**
 * The risk help copy for a set of weights: each factor's share of the score, heaviest
 * first, the heaviest marked when it is the only one. All weights 0 says so (the score is
 * then 0).
 */
export function riskHelpText(weights: Partial<RiskWeightSet> | null | undefined): string {
  const w = { ...DEFAULT_RISK_WEIGHTS, ...(weights ?? {}) };
  const values = FACTOR_WORDS.map(([key]) => (Number.isFinite(w[key]) && w[key] > 0 ? w[key] : 0));
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return `Deterministic 0-100 risk score, a weighted blend of 5 factors. Every weight is 0, so every score is 0. ${RISK_HELP_TAIL}`;
  }
  const shares = FACTOR_WORDS.map(([, label], index) => ({ label, share: Math.round((values[index] / total) * 100) }))
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.share - a.share || a.index - b.index);
  const heaviestUnique = shares.length > 1 && shares[0].share > shares[1].share;
  const parts = shares.map((entry, i) => `${entry.label} ${entry.share}%${i === 0 && heaviestUnique ? ' (heaviest)' : ''}`);
  return `Deterministic 0-100 risk score, a weighted blend of 5 factors: ${parts.join(', ')}. ${RISK_HELP_TAIL}`;
}

/**
 * The canonical, authored help for the deterministic risk score with the DEFAULT weights:
 * the per-factor definitions, default weights (25/20/30/15/10) and the honest caveat.
 * Authored from `backend/app/engine/risk.py` (Reputation is the HEAVIEST factor at 0.30).
 * Kept in sync with the backend copy in `backend/app/engine/priority.py`
 * (`risk_chip.inputs.definition`). Plain text (#9); shown in the RiskCard HelpTip and used
 * as the fallback when the backend omits the `inputs.definition` string.
 */
export const RISK_HELP_TEXT = riskHelpText(DEFAULT_RISK_WEIGHTS);

/**
 * Help copy for the Command-Center **Active Risk Index** instrument (#1). Explains the
 * exact math (mean deterministic risk over currently OPEN cases only, NOT scoped to
 * the selected time range) + the 4-band 0-100 ladder cuts (74/48/22, the palette.ts
 * `scoreBand` ladder the gauge uses), then folds in the full per-factor risk help for the
 * given weights (the defaults when none are given). Plain text (#9).
 */
export function activeRiskHelpText(weights?: Partial<RiskWeightSet> | null): string {
  return (
    'Active Risk Index: the average deterministic risk score (0-100) across every ' +
    'currently OPEN case (excludes resolved/closed; not scoped to the time range). ' +
    'Critical ≥74 · High ≥48 · Medium ≥22 · Low <22. ' +
    riskHelpText(weights)
  );
}

/** `activeRiskHelpText` for the default weights. */
export const ACTIVE_RISK_HELP_TEXT = activeRiskHelpText(DEFAULT_RISK_WEIGHTS);
