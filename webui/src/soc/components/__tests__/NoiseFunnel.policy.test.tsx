/**
 * NoiseFunnel — the `policy_closed` terminal stage.
 *
 * A case closed by an operator's analyst RULE POLICY is neither AI auto-clear (no model
 * ran) nor human case work (nobody worked it). Before this stage existed the backend's
 * residual fold swallowed it into "Escalated", so a declaration that REMOVED analyst
 * load rendered as analyst load — a silent mis-attribution with no error anywhere.
 *
 * The stage is additive: a deployment with no declarations must render the exact
 * previous six-stage flow.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NoiseFunnel, deriveFunnel } from '../NoiseFunnel';
import type { NoiseReduction, NoiseStage } from '@/lib/types';

const stage = (key: string, label: string, total: number): NoiseStage => ({
  key,
  label,
  source: 'cases',
  deterministic: true,
  total,
  by_severity: {},
});

function fixture(policyClosed: number): NoiseReduction {
  return {
    window_hours: 24,
    generated_at: '2026-08-16T00:00:00Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      { ...stage('ingested', 'Alerts ingested', 1000), source: 'counters' },
      { ...stage('clustered', 'After clustering', 200), source: 'counters' },
      { ...stage('cases', 'Cases opened', 40), deterministic: false },
      stage('auto_cleared', 'Auto-cleared by AI', 25),
      stage('escalated', 'Escalated', 15 - policyClosed),
      stage('needs_human', 'Needs a human', 5),
      { ...stage('closed', 'Closed by human', 7), deterministic: false },
      stage('policy_closed', 'Closed by analyst policy', policyClosed),
    ],
    drops: { suppressed: 0, ignored: 0 },
    reduction: { overall_pct: 50, human_pct: 50 },
    counters: { available: true, since: '2026-08-16T00:00:00Z', incomplete: false },
    truncated: false,
    store_total: 40,
    fetched: 40,
  } as unknown as NoiseReduction;
}

describe('NoiseFunnel — analyst-policy closes', () => {
  it('renders its own terminal stage instead of folding into Escalated', () => {
    const derived = deriveFunnel(fixture(6));
    const keys = derived.rows.map((r) => r.key);
    expect(keys).toContain('policy_closed');
    expect(derived.rows.find((r) => r.key === 'policy_closed')?.total).toBe(6);
    // It is a terminal outcome view, like auto_cleared / escalated / closed.
    expect(derived.rows.find((r) => r.key === 'policy_closed')?.isOutcome).toBe(true);
  });

  it('is ADDITIVE — a deployment with no declarations keeps the previous flow', () => {
    const derived = deriveFunnel(fixture(0));
    expect(derived.rows.map((r) => r.key)).toEqual([
      'ingested',
      'clustered',
      'cases',
      'auto_cleared',
      'escalated',
      'closed',
    ]);
  });

  it('labels the stage so it can never read as AI or as human case work', () => {
    render(<NoiseFunnel data={fixture(6)} />);
    expect(screen.getAllByText('Closed by analyst policy').length).toBeGreaterThanOrEqual(1);
  });
});
