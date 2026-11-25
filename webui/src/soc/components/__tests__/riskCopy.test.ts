/**
 * riskCopy: the authored risk help copy, pinned at its source.
 *
 * The per-case triage header that used to carry these assertions had no production
 * consumer and was removed in Round 14. The copy itself still reaches operators through
 * the Overview's Active Risk Index help (`ACTIVE_RISK_HELP_TEXT` folds in
 * `RISK_HELP_TEXT`), so its contract is pinned here: the five factors, their default
 * weights from `backend/app/engine/risk.py` (Reputation heaviest at 30%) and the honest
 * caveat that the score only ranks.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_RISK_HELP_TEXT,
  DEFAULT_RISK_WEIGHTS,
  RISK_HELP_TEXT,
  activeRiskHelpText,
  riskHelpText,
} from '../riskCopy';

describe('riskCopy', () => {
  it('names every factor with its default weight, never an empty "weights shown" promise', () => {
    expect(RISK_HELP_TEXT).toContain('Reputation 30%');
    expect(RISK_HELP_TEXT).toContain('(heaviest)');
    expect(RISK_HELP_TEXT).toContain('Volume 25%');
    expect(RISK_HELP_TEXT).toContain('Velocity 20%');
    expect(RISK_HELP_TEXT).toContain('Diversity 15%');
    expect(RISK_HELP_TEXT).toContain('Asset criticality 10%');
    expect(RISK_HELP_TEXT).not.toContain('default weights shown');
  });

  it('keeps the caveat that the score ranks and never decides', () => {
    expect(RISK_HELP_TEXT).toContain('never closes or escalates');
  });

  it('uses no em or en dashes in copy an operator reads', () => {
    expect(RISK_HELP_TEXT).not.toMatch(/[\u2013\u2014]/);
    expect(ACTIVE_RISK_HELP_TEXT).not.toMatch(/[\u2013\u2014]/);
  });

  it('folds the per-factor help into the Active Risk Index help', () => {
    expect(ACTIVE_RISK_HELP_TEXT.endsWith(RISK_HELP_TEXT)).toBe(true);
  });
});

describe('riskHelpText (Round 16 WP11, research explainability D7)', () => {
  it('renders the defaults exactly as the authored copy', () => {
    expect(riskHelpText(DEFAULT_RISK_WEIGHTS)).toBe(RISK_HELP_TEXT);
    expect(activeRiskHelpText()).toBe(ACTIVE_RISK_HELP_TEXT);
    expect(RISK_HELP_TEXT).toBe(
      'Deterministic 0-100 risk score, a weighted blend of 5 factors: Reputation 30% (heaviest), Volume 25%, Velocity 20%, Diversity 15%, Asset criticality 10%. It only RANKS what an analyst looks at first; it never closes or escalates a case on its own.',
    );
  });

  it('renders an operator weight set instead of the hard-coded defaults', () => {
    const text = riskHelpText({ volume: 0.5, velocity: 0.1, reputation: 0.2, diversity: 0.1, asset_criticality: 0.1 });
    expect(text).toContain('Volume 50% (heaviest), Reputation 20%, Velocity 10%, Diversity 10%, Asset criticality 10%.');
    expect(text).not.toContain('Reputation 30%');
  });

  it('says so when every weight is 0', () => {
    expect(riskHelpText({ volume: 0, velocity: 0, reputation: 0, diversity: 0, asset_criticality: 0 })).toContain(
      'Every weight is 0, so every score is 0.',
    );
  });
});
