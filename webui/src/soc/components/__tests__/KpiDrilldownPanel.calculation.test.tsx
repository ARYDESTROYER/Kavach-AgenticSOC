/**
 * Round 16 WP12 review: the drill-down's "Show the calculation" opens the full arithmetic
 * in the panel's fixed identity band. Unbounded, it grew that band past the dialog's
 * fixed height and left the evidence list a 12px sliver at 1440 by 900 (0px on a phone)
 * until the calculation was hidden again. It now scrolls in its own bounded, keyboard
 * reachable port, so the list keeps its room.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Case } from '@/lib/types';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listCases: listCasesMock } }));

import { explainKpiShare } from '../metrics-explain/builders';
import { KpiDrilldownPanel, type KpiDrilldownSpec } from '../KpiDrilldownPanel';

const CASES = [1, 2, 3].map((n) => ({
  case_id: `c${n}`,
  case_number: `SOC-${n}`,
  title: `Case ${n}`,
  created_at: '2026-10-25T15:09:15Z',
  severity_band: 'high',
  risk_score: 70,
  status: 'open',
})) as unknown as Case[];

const SPEC: KpiDrilldownSpec = {
  key: 'kpi-false-positive-rate',
  title: 'AI-verdict FP rate',
  population: 'Cases the agent verdicted false positive.',
  match: () => true,
  defaultRange: 'all',
  windowHours: 24,
  populationResolvedBy: 'store',
  explanation: explainKpiShare({
    metric: 'fp_rate',
    title: 'AI-verdict FP rate',
    numerator: 32,
    denominator: 38,
    numeratorLabel: 'false positive verdicts',
    denominatorLabel: 'verdicted cases',
    window: 'the last 24 hours',
    dividedBy: 'server',
  }),
};

describe('KpiDrilldownPanel calculation', () => {
  beforeEach(() => {
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length, limit_applied: 200 });
  });

  it('opens the arithmetic in a bounded, keyboard-reachable scroll port', async () => {
    const user = userEvent.setup();
    render(<KpiDrilldownPanel spec={SPEC} panelId="p" headingId="h" onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kpi-drilldown-formula')).toHaveTextContent(
      '32 false positive verdicts of 38 verdicted cases = 84.2%, the last 24 hours.',
    );
    const toggle = within(dialog).getByRole('button', { name: 'Show the calculation' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const port = within(dialog).getByRole('group', { name: 'How AI-verdict FP rate is calculated, scrollable' });
    expect(port).toHaveAttribute('id', toggle.getAttribute('aria-controls'));
    expect(port).toHaveAttribute('tabindex', '0');
    // A height bound and its own scroll: the band can no longer outgrow the dialog.
    expect(port.className).toMatch(/\bmax-h-\[/);
    expect(port.className).toMatch(/\boverflow-y-auto\b/);
    expect(within(port).getByTestId('explain-panel')).toBeInTheDocument();

    await user.click(toggle);
    expect(within(dialog).queryByRole('group', { name: /is calculated, scrollable$/ })).toBeNull();
  });
});
