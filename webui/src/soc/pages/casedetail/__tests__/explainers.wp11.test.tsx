/**
 * The case explainers (Round 16 SPEC §4.5 WP11; research explainability §3, R2 to R5).
 *
 * * `RiskExplain` prints the worked example's hover line and click panel exactly from the
 *   recorded inputs; a legacy case reads its reconstruction with today's weights once, on
 *   first open, and says so; the row variant is a mouse-only hover card.
 * * `DecisionExplain` reads the decision span and the forwarding gate once, and states both
 *   auto-close conditions with their numbers.
 * * `FactExplain` wraps a fact in the kit.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({
  getCaseStages: vi.fn(),
  getTimeline: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock('@/soc/pages/CaseDetail.api', () => ({
  getCaseStages: h.getCaseStages,
  getTimeline: h.getTimeline,
}));
vi.mock('@/lib/api', () => ({ api: { get: h.apiGet } }));

import contract from '@/lib/explain/explain.contract.json';
import { explainSeverity } from '@/lib/explain/builders';
import type { Case, RiskBreakdown, RiskInputs } from '@/lib/types';
import { DecisionExplain } from '../explain/DecisionExplain';
import { FactExplain } from '../explain/FactExplain';
import { RiskExplain } from '../explain/RiskExplain';

const WORKED = contract.risk.vectors[0];
const BREAKDOWN: RiskBreakdown = { ...WORKED.expected.breakdown, inputs: WORKED.expected.inputs as unknown as RiskInputs };

beforeEach(() => {
  h.getCaseStages.mockReset();
  h.getTimeline.mockReset();
  h.apiGet.mockReset();
});

describe('RiskExplain', () => {
  it('prints the worked example hover line and the click panel exactly', async () => {
    const user = userEvent.setup();
    render(
      <RiskExplain caseId="case-1" score={81.11} breakdown={BREAKDOWN}>
        <span>Risk 81</span>
      </RiskExplain>,
    );
    const trigger = screen.getByRole('button', { name: /Risk 81/ });
    await user.hover(trigger);
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent(WORKED.expected.hover_line);
    await user.click(trigger);
    const panel = await screen.findByTestId('explain-panel');
    const steps = screen.getByTestId('explain-steps');
    for (const text of [
      'min(100, 100 x ln(1 + 40) / ln(1 + 50))94.45',
      'min(100, 100 x 40 / (120 / 60) / 10)100 (capped from 200)',
      'clamp(75, 0, 100)75',
      'min(100, 100 x 3 / 5)60',
      'clamp(60, 0, 100)60',
      '0.25 x 94.45 + 0.20 x 100 + 0.30 x 75 + 0.15 x 60 + 0.10 x 6081.11',
      '81.11 / 1.0081.11',
      'floor(81.11 + 0.5)81',
    ]) {
      expect(steps).toHaveTextContent(text);
    }
    expect(panel).toHaveTextContent('Band Critical (74 to 100).');
    expect(panel).toHaveTextContent('Weights and inputs recorded when this case was scored, 2026-11-24T10:00:00+00:00.');
    // Recorded inputs need no request.
    expect(h.getCaseStages).not.toHaveBeenCalled();
  });

  it('reads the reconstruction with today\'s weights once for a legacy case, with the mismatch note', async () => {
    h.getCaseStages.mockResolvedValue({
      case_id: 'legacy',
      total: 1,
      stages: [
        {
          id: 'risk',
          kind: 'risk',
          label: 'Risk',
          status: 'done',
          deterministic: true,
          headline: '',
          steps: [],
          state: {
            risk_score: 61,
            risk_calculation: {
              factors: [{ factor: 'volume', label: 'Volume', value: 61, weight: 1, weighted_value: 61, contribution: 61 }],
              numerator: 61,
              denominator: 1,
              calculated_score: 55,
              recorded_score: 61,
              displayed_score: 61,
              matches_displayed_score: false,
              weight_basis: 'current_preferences',
            },
          },
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <RiskExplain caseId="legacy" score={61} breakdown={{ volume: 61, velocity: 0, reputation: 0, diversity: 0, asset_criticality: 0, total: 61 }}>
        <span>Risk 61</span>
      </RiskExplain>,
    );
    const trigger = screen.getByRole('button', { name: /Risk 61/ });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByTestId('explain-provenance')).toHaveTextContent("Reconstructed with today's settings"));
    expect(screen.getByTestId('explain-caveats')).toHaveTextContent(
      "Today's weights give 55, while this case records 61. The difference cannot be attributed exactly; the recorded score was not rewritten.",
    );
    await user.keyboard('{Escape}');
    await user.click(trigger);
    expect(h.getCaseStages).toHaveBeenCalledTimes(1);
  });

  it('a case with no breakdown still has a trigger that says so', async () => {
    const user = userEvent.setup();
    render(
      <RiskExplain caseId="bare" score={40} breakdown={null}>
        <span>Risk 40</span>
      </RiskExplain>,
    );
    await user.hover(screen.getByRole('button', { name: /Risk 40/ }));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent('Risk 40: no factor breakdown was recorded for this case.');
  });

  it('the row variant is a mouse-only hover card and never loads anything', async () => {
    const user = userEvent.setup();
    render(
      <button type="button" aria-label="CASE-1, risk 61">
        <RiskExplain caseId="row" score={61} breakdown={{ volume: 61, velocity: 0, reputation: 0, diversity: 0, asset_criticality: 0, total: 61 }} variant="row">
          <span data-testid="case-queue-risk">Risk 61</span>
        </RiskExplain>
      </button>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.hover(screen.getByTestId('case-queue-risk'));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent('the inputs were not recorded');
    expect(h.getCaseStages).not.toHaveBeenCalled();
  });
});

describe('DecisionExplain', () => {
  const CASE = {
    case_id: 'case-9',
    verdict: 'FALSE_POSITIVE',
    confidence: 0.97,
    risk_score: 45,
    status: 'needs_human',
    decision_by: 'system',
  } as unknown as Case;

  it('states the case\'s own numbers first, then both conditions once the span is read', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    h.getTimeline.mockReturnValue(new Promise((r) => { resolve = r; }));
    h.apiGet.mockResolvedValue({ gate: 'risk_floor', forwarded: true, sentence: 'Auto-investigated: routing score 72 reached the floor 70.' });
    const user = userEvent.setup();
    render(
      <DecisionExplain caseRecord={CASE}>
        <span>AI verdict False positive 97%</span>
      </DecisionExplain>,
    );
    const trigger = screen.getByRole('button', { name: /AI verdict False positive/ });
    await user.hover(trigger);
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent(
      'Routed to a person: AI verdict false positive, at 97% confidence, risk 45. Select it to compare them with the auto-close policy.',
    );
    resolve({
      case_id: 'case-9',
      total: 1,
      totals: { cost: null, tokens: null },
      spans: [
        {
          step_index: 0,
          kind: 'decision',
          name: 'case_manager',
          ts: '',
          latency_ms: null,
          cost: 0,
          tokens: 0,
          trusted: true,
          summary: '',
          payload_ref: { policy_clause: { verdict_class: 'FALSE_POSITIVE', enabled: true, min_confidence: 0.85, max_risk_score: 30 } },
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId('explain-hover')).toHaveTextContent(
        "Today's policy routes it to a person: confidence 97% >= 85% (met); risk 45 <= 30 (not met).",
      ),
    );
    await user.click(trigger);
    expect(await screen.findByTestId('decision-why-investigated')).toHaveTextContent(
      'Why was this investigated?Auto-investigated: routing score 72 reached the floor 70.',
    );
    expect(h.getTimeline).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith('cases/case-9/forwarding');
  });

  it('renders its children alone for a case with no verdict', () => {
    render(
      <DecisionExplain caseRecord={{ case_id: 'x' } as Case}>
        <span>No verdict</span>
      </DecisionExplain>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('loading and error states (WP11 review)', () => {
  const LEGACY = { volume: 61, velocity: 0, reputation: 0, diversity: 0, asset_criticality: 0, total: 61 };

  it('RiskExplain says it is reading, then that the timeline could not be read', async () => {
    let fail: (e: unknown) => void = () => undefined;
    h.getCaseStages.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const user = userEvent.setup();
    render(
      <RiskExplain caseId="legacy" score={61} breakdown={LEGACY}>
        <span>Risk 61</span>
      </RiskExplain>,
    );
    await user.click(screen.getByRole('button', { name: /Risk 61/ }));
    expect(await screen.findByTestId('explain-caveats')).toHaveTextContent("Reading today's weights from the case timeline.");
    fail(new Error('500'));
    await waitFor(() =>
      expect(screen.getByTestId('explain-caveats')).toHaveTextContent(
        "The case timeline could not be read, so the calculation with today's weights is not shown.",
      ),
    );
    expect(screen.getByTestId('explain-caveats')).not.toHaveTextContent('Reading today');
  });

  it('DecisionExplain says it is reading the decision record, then that it failed', async () => {
    let fail: (e: unknown) => void = () => undefined;
    h.getTimeline.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    h.apiGet.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    render(
      <DecisionExplain caseRecord={{ case_id: 'c-err', verdict: 'FALSE_POSITIVE', confidence: 0.9, risk_score: 20, status: 'open' } as unknown as Case}>
        <span>AI verdict False positive</span>
      </DecisionExplain>,
    );
    await user.click(screen.getByRole('button', { name: /AI verdict/ }));
    expect(await screen.findByTestId('explain-caveats')).toHaveTextContent('Reading the decision record.');
    fail(new Error('500'));
    await waitFor(() =>
      expect(screen.getByTestId('explain-caveats')).toHaveTextContent(
        'The decision record could not be read, so the auto-close thresholds are not shown.',
      ),
    );
  });
});

describe('FactExplain', () => {
  it('wraps a fact with its builder explanation', async () => {
    const user = userEvent.setup();
    const exp = explainSeverity({
      risk: { value: 62, band: 'high', breakdown: {}, inputs: {} },
      severity: { band: 'high', value: 62, raw: null, source: 'derived', inputs: {} },
      impact: { band: 'low', value: 0, criticality: 0, entity: '', inputs: {} },
      priority: { level: 'P3', impact: 'low', matched: true, default: 'P3', urgency: { band: 'high', value: 62, escalated: false }, inputs: {} },
    });
    render(
      <FactExplain explanation={exp}>
        <span>High severity</span>
      </FactExplain>,
    );
    await user.hover(screen.getByRole('button', { name: /High severity/ }));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent(
      'High severity: the source reported none, so it is derived from the risk score 62, in the High (48 to 73) band.',
    );
  });
});

void React;
