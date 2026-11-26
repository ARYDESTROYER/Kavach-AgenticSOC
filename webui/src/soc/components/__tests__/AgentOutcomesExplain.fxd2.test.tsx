/**
 * Round 16 FXD2: Agent effectiveness's four headline comparisons can be reproduced.
 *
 * The checker saw "$0.015 / Comparable prior: $0.020 / -22.9%": the shown values give
 * -25%, because the server compares the unrounded figures. Each tile's figure now opens
 * a panel that works both windows from their counts and the change from the figures the
 * server compared, ending on the chip.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/ui/tooltip';
import { AgentOperationalOutcomes } from '../AgentOperationalOutcomes';
import { explainCostOutcome, explainTimingOutcome } from '../AgentOutcomesExplain';
import { evidence, outcomes } from './agent-outcome-fixtures';

const WINDOWS = { currentWindow: 'Nov 19 to 25, 2026', priorWindow: 'Nov 12 to 18, 2026' };

describe('the outcome explanations reproduce the tiles', () => {
  it('cost per case: the change worked from the 6-decimal figures gives -22.9%', () => {
    const cost = outcomes().recorded_case_cost;
    cost.current = { total_cost: 0.123456, call_count: 9, costed_cases: 8, cost_per_costed_case: 0.015432, cost_per_day: 0.017637 };
    cost.baseline = { total_cost: 0.16012, call_count: 11, costed_cases: 8, cost_per_costed_case: 0.020015, cost_per_day: 0.022874 };
    cost.delta.cost_per_costed_case_relative = -0.229;
    const e = explainCostOutcome(cost, { value: '$0.015', prior: '$0.020', delta: '-22.9%', ...WINDOWS });
    expect(e?.steps).toEqual([
      { label: 'This window', expression: '$0.123456 / 8 cases', result: '$0.015432, shown as $0.015' },
      { label: 'Comparable prior', expression: '$0.16012 / 8 cases', result: '$0.020015, shown as $0.020' },
      { label: 'Change', expression: '($0.015432 - $0.020015) / $0.020015', result: '-0.229, shown as -22.9%' },
    ]);
    expect(e?.formula).toBe('recorded cost of model calls tied to a case / cases with such a call; change = (now - prior) / prior');
    expect(JSON.stringify(e)).not.toMatch(/UsageDoc|case_id/);
  });

  it('elapsed-time difference: medians minus medians, then the change (15.5, not 15)', () => {
    const timing = outcomes().observed_time_saved;
    Object.assign(timing.current, { human_owned_closure_p50_minutes: 106.4, agent_closed_p50_minutes: 0.4, observed_difference_minutes_per_case: 106 });
    Object.assign(timing.baseline, { human_owned_closure_p50_minutes: 90.9, agent_closed_p50_minutes: 0.4, observed_difference_minutes_per_case: 90.5 });
    timing.delta.minutes_per_case = 15.5;
    const e = explainTimingOutcome(timing, { value: '1h 46m faster / case', prior: '1h 31m faster / case', delta: '+15.5 min / case', ...WINDOWS });
    expect(e?.steps.map((s) => [s.expression, s.result])).toEqual([
      ['106.4 - 0.4', '106 minutes per case, shown as 1h 46m faster / case'],
      ['90.9 - 0.4', '90.5 minutes per case, shown as 1h 31m faster / case'],
      ['106 - 90.5', '15.5 minutes per case, shown as +15.5 min / case'],
    ]);
  });

  it('never prints arithmetic that disagrees with the server figure', () => {
    // $1 / 3 cases is 0.333333, not the 0.5 sent: the step says where the figure came from.
    const e = explainCostOutcome(
      { ...outcomes().recorded_case_cost, current: { total_cost: 1, call_count: 1, costed_cases: 3, cost_per_costed_case: 0.5, cost_per_day: 1 } },
      { value: '$0.500', prior: '$0.500', ...WINDOWS },
    );
    expect(e?.steps[0]).toEqual({ label: 'This window', expression: 'As the server computed it', result: '$0.5, shown as $0.500' });
  });
});

describe('the tiles carry the explanations', () => {
  it('each of the four figures is an explain trigger', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <AgentOperationalOutcomes evidence={evidence()} />
      </TooltipProvider>,
    );
    const metrics = Array.from(container.querySelectorAll('[data-explain-trigger]')).map((n) => n.getAttribute('data-explain-metric'));
    expect(metrics).toEqual([
      'outcome_confirmed_positive_share',
      'outcome_elapsed_difference',
      'outcome_alerts_per_day',
      'outcome_cost_per_case',
    ]);
    const tile = screen.getByTestId('comparison-outcome-recorded_case_cost');
    await user.click(within(tile).getByRole('button', { name: /explain/ }));
    expect(await screen.findByTestId('explain-panel')).toHaveTextContent('Change');
  });
});
