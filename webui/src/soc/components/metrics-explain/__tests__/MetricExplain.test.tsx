/**
 * Round 16 WP16: the Active risk index and SLA attainment explain themselves from their
 * own server explanation (`GET /api/metrics/explain?metric=active_risk_index` and
 * `metric=sla_attainment`), and the risk index says how a case's risk is scored with the
 * weights in force (research explainability D7), not the shipped defaults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { MetricExplainResponse } from '@/lib/types-metrics-explain';

const h = vi.hoisted(() => ({
  explain: vi.fn(),
  settings: vi.fn(),
  canReadSettings: true,
}));
vi.mock('@/lib/api-metrics-explain', () => ({ getMetricExplain: h.explain }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { getSettings: h.settings },
}));
vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => ({ hasPermission: (r: string, a: string) => (r === 'settings' && a === 'read' ? h.canReadSettings : true) }),
}));

import { activeRiskHelpText, DEFAULT_RISK_WEIGHTS } from '@/soc/components/riskCopy';
import { activeRiskInitial } from '@/soc/dashboard/widgets/risk';
import { slaAttainmentInitial } from '@/soc/dashboard/widgets/strip';

import { MetricExplain, explainActiveRisk, explainSlaAttainment } from '../MetricExplain';

function response(over: Partial<MetricExplainResponse> = {}): MetricExplainResponse {
  return {
    metric: 'active_risk_index',
    kind: 'mean',
    unit: 'score',
    window_hours: 0,
    window: 'all time',
    generated_at: '2026-11-25T12:00:00Z',
    population: 'Every case that is not resolved or closed, all time.',
    population_size: 12,
    headline: 'mean',
    value: 59,
    available: true,
    reason: '',
    numerator: 708,
    denominator: 12,
    sample_count: 12,
    visible_count: 12,
    hidden_by_scope: 0,
    samples: [],
    samples_offset: 0,
    samples_truncated: false,
    samples_order: 'value_descending',
    samples_withheld: '',
    truncated: false,
    store_total: 40,
    fetched: 40,
    ...over,
  };
}

beforeEach(() => {
  h.explain.mockReset();
  h.settings.mockReset();
  h.canReadSettings = true;
});

describe('the Active risk index explained', () => {
  it('reads metric=active_risk_index on open and prints the sum over the open cases', async () => {
    h.explain.mockResolvedValue(response());
    h.settings.mockResolvedValue({
      prefs: { risk_weights: { volume: 0, velocity: 0, reputation: 1, diversity: 0, asset_criticality: 0 } },
    });
    const user = userEvent.setup();
    render(
      <MetricExplain metric="active_risk_index" title="Active risk index" windowHours={0} initial={activeRiskInitial(59, 12)}>
        <span>59</span>
      </MetricExplain>,
    );
    expect(h.explain).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /59/ }));
    await waitFor(() => expect(h.explain).toHaveBeenCalledWith('active_risk_index', 0, expect.anything()));
    const panel = await screen.findByRole('dialog');
    await waitFor(() => expect(panel).toHaveTextContent('Mean risk 59 over 12 open cases: 708 / 12.'));
    // The weights in force, not the shipped defaults.
    const help = await screen.findByTestId('metric-explain-risk-help');
    expect(help).toHaveTextContent('Reputation 100% (heaviest)');
    expect(help.textContent).toBe(
      activeRiskHelpText({ volume: 0, velocity: 0, reputation: 1, diversity: 0, asset_criticality: 0 }),
    );
    expect(h.settings).toHaveBeenCalledTimes(1);
  });

  it('says it shows the default weights when the settings cannot be read', async () => {
    h.explain.mockResolvedValue(response());
    h.canReadSettings = false;
    const user = userEvent.setup();
    render(
      <MetricExplain metric="active_risk_index" title="Active risk index" windowHours={0} initial={activeRiskInitial(59, 12)}>
        <span>59</span>
      </MetricExplain>,
    );
    await user.click(screen.getByRole('button', { name: /59/ }));
    const help = await screen.findByTestId('metric-explain-risk-help');
    expect(help.textContent).toBe(
      `${activeRiskHelpText(DEFAULT_RISK_WEIGHTS)} These are the default weights: the settings in force could not be read.`,
    );
    expect(h.settings).not.toHaveBeenCalled();
  });

  it('builds the mean from the server numbers, and says when nothing is open', () => {
    const exp = explainActiveRisk(response({ value: 58.3, numerator: 699.6 }));
    expect(exp?.steps).toEqual([{ label: 'Mean', expression: '699.6 / 12', result: '58.3' }]);
    // The gauge shows 58: the panel says why its figure has a decimal.
    expect(exp?.rounding).toBe('The server rounds the mean to one decimal. The gauge shows it to the nearest whole number.');
    expect(exp?.caveats).toContain('Cases counted: Every case that is not resolved or closed, all time.');
    const none = explainActiveRisk(response({ value: null, numerator: 0, denominator: 0, available: false, reason: 'no case is open, so there is no index' }));
    expect(none?.summary).toBe('No case is open, so there is no index.');
    expect(none?.steps).toEqual([]);
    expect(explainActiveRisk(null)).toBeNull();
  });
});

describe('SLA attainment explained', () => {
  it('reads metric=sla_attainment for the board window and prints met over scored', async () => {
    h.explain.mockResolvedValue(
      response({
        metric: 'sla_attainment',
        kind: 'ratio',
        unit: 'percent',
        window_hours: 168,
        window: 'the last 7 days',
        population: 'Cases created in the last 7 days whose priority has an SLA target.',
        value: 70,
        numerator: 7,
        denominator: 10,
      }),
    );
    const user = userEvent.setup();
    render(
      <MetricExplain metric="sla_attainment" title="SLA attainment" windowHours={168} initial={slaAttainmentInitial('70%', 'last 7 days')}>
        <span>70%</span>
      </MetricExplain>,
    );
    await user.click(screen.getByRole('button', { name: /70%/ }));
    await waitFor(() => expect(h.explain).toHaveBeenCalledWith('sla_attainment', 168, expect.anything()));
    const panel = await screen.findByRole('dialog');
    await waitFor(() => expect(panel).toHaveTextContent('7 cases that met their targets of 10 scored cases'));
    expect(screen.queryByTestId('metric-explain-risk-help')).toBeNull();
    expect(h.settings).not.toHaveBeenCalled();
  });

  it('shares the server counts and the formula', () => {
    const exp = explainSlaAttainment(response({ metric: 'sla_attainment', numerator: 3, denominator: 4, window: 'the last 24 hours' }));
    expect(exp?.formula).toBe('cases that met every target / cases scored against a target');
    expect(exp?.summary).toMatch(/^3 cases that met their targets of 4 scored cases = 75/);
  });
});
