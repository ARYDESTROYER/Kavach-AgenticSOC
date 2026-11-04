/**
 * riskCopy: the ONE source of truth for the authored risk and active-risk help copy.
 *
 * First written for the retired per-case triage header, it is now read by the Overview's
 * Active Risk Index help (`ACTIVE_RISK_HELP_TEXT`, through `ActiveRiskIndex.tsx`) and the
 * RiskCard help tip; `__tests__/riskCopy.test.ts` pins it.
 *
 * SECURITY (#9): all copy here is author-controlled (trusted) and rendered ONLY as
 * plain text inside a HelpTip Tooltip/Popover, never as markup.
 */

/**
 * The canonical, authored help for the deterministic risk score: the ONE source of
 * truth for the per-factor definitions, default weights (25/20/30/15/10) and the honest
 * caveat. Authored VERBATIM from `backend/app/engine/risk.py` (Reputation is the
 * HEAVIEST factor at 0.30). Kept in sync with the backend copy in
 * `backend/app/engine/priority.py` (`risk_chip.inputs.definition`). Plain text (#9);
 * shown in the RiskCard HelpTip and used as the fallback when the backend omits the
 * `inputs.definition` string.
 */
export const RISK_HELP_TEXT =
  'Deterministic 0-100 risk score, a weighted blend of 5 factors: Reputation 30% ' +
  '(heaviest), Volume 25%, Velocity 20%, Diversity 15%, Asset criticality 10%. It only ' +
  'RANKS what an analyst looks at first; it never closes or escalates a case on its own.';

/**
 * Help copy for the Command-Center **Active Risk Index** instrument (#1). Explains the
 * exact math (mean deterministic risk over currently OPEN cases only, NOT scoped to
 * the selected time range) + the 4-band 0-100 ladder cuts (74/48/22, the palette.ts
 * `scoreBand` ladder the gauge uses), then folds in the full per-factor `RISK_HELP_TEXT`
 * so the operator sees what feeds the number. Plain text (#9).
 */
export const ACTIVE_RISK_HELP_TEXT =
  'Active Risk Index: the average deterministic risk score (0-100) across every ' +
  'currently OPEN case (excludes resolved/closed; not scoped to the time range). ' +
  'Critical ≥74 · High ≥48 · Medium ≥22 · Low <22. ' +
  RISK_HELP_TEXT;
