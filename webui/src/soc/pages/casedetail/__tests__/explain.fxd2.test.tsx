/**
 * Round 16 FXD2: "Why was this investigated?" says it reads today's settings and prints
 * the routing score as arithmetic with two decimals: (0.25 x 58.56 + 0.20 x 9.69 +
 * 0.15 x 20) / 0.60 = 32.63, never the integer cut "32".
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

import type { Case } from '@/lib/types';
import { DecisionExplain } from '../explain/DecisionExplain';
import { TODAY_SETTINGS, routingScoreLine } from '../explain/routing';

const TERMS = [
  { factor: 'volume', weight: 0.25, value: 58.56 },
  { factor: 'velocity', weight: 0.2, value: 9.69 },
  { factor: 'diversity', weight: 0.15, value: 20 },
];

beforeEach(() => {
  h.getCaseStages.mockReset();
  h.getTimeline.mockReset();
  h.apiGet.mockReset();
});

describe('routingScoreLine', () => {
  it('prints the terms that give the score, with two decimals', () => {
    expect(
      routingScoreLine({ routing_total: 32.63, risk_floor: 70, routing_gate_applied: true, routing_terms: TERMS, routing_weight_total: 0.6 }),
    ).toBe('Routing score: (0.25 x 58.56 + 0.20 x 9.69 + 0.15 x 20) / 0.60 = 32.63, against a floor of 70.');
  });

  it('says when the floor does not apply', () => {
    expect(
      routingScoreLine({ routing_total: 32.63, risk_floor: 70, routing_gate_applied: false, routing_terms: TERMS, routing_weight_total: 0.6 }),
    ).toContain('(the floor does not apply to these events)');
  });

  it('never prints arithmetic that gives another number, and falls back to the score', () => {
    expect(
      routingScoreLine({ routing_total: 40, risk_floor: 70, routing_terms: TERMS, routing_weight_total: 0.6 }),
    ).toBe('Routing score 40, against a floor of 70.');
    expect(routingScoreLine({ routing_total: 32.63, risk_floor: 70 })).toBe('Routing score 32.63, against a floor of 70.');
    expect(routingScoreLine({ routing_total: null })).toBeNull();
  });
});

describe('DecisionExplain: Why was this investigated?', () => {
  const CASE = {
    case_id: 'case-36',
    verdict: 'FALSE_POSITIVE',
    confidence: 0.71,
    risk_score: 32.6,
    status: 'closed',
    decision_by: 'system',
  } as unknown as Case;

  it("names today's settings and prints the routing arithmetic", async () => {
    h.getTimeline.mockResolvedValue({ spans: [] });
    h.apiGet.mockResolvedValue({
      gate: 'risk_floor',
      forwarded: false,
      sentence:
        'Registered as a candidate: its rules are not on the auto-forward allowlist and its available-signal routing score 32.63 is below the configured floor 70.',
      routing_total: 32.63,
      risk_floor: 70,
      routing_gate_applied: true,
      routing_terms: TERMS,
      routing_weight_total: 0.6,
    });
    const user = userEvent.setup();
    render(
      <DecisionExplain caseRecord={CASE}>
        <span>AI verdict False positive 71%</span>
      </DecisionExplain>,
    );
    await user.click(screen.getByRole('button', { name: /AI verdict False positive/ }));
    const why = await screen.findByTestId('decision-why-investigated');
    expect(await screen.findByTestId('decision-routing-score')).toHaveTextContent(
      '(0.25 x 58.56 + 0.20 x 9.69 + 0.15 x 20) / 0.60 = 32.63',
    );
    expect(why).toHaveTextContent(TODAY_SETTINGS);
    expect(why).toHaveTextContent("This reading uses today's settings");
  });
});
