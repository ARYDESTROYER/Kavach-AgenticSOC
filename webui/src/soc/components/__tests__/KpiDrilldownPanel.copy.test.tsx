/**
 * The KPI drill-down's own sentences and accessible names carry no em dash (Round 14
 * rule: plain sentence-case copy, no em dashes anywhere).
 *
 * Four strings predated the rule and were rewritten in the closing fix: the range
 * narrowing sentence, the metric switcher's group name, the scroll region's name and
 * the table caption. Each is pinned to its new wording, and every text node and
 * `aria-label` the open panel renders is checked, so a dash cannot come back through
 * a string these four do not cover. The one exception is the design system's own
 * missing-value glyph (`DASH` from `lib/format`), which a cell with no value shows on
 * its own and which is a placeholder, not a sentence.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DASH } from '@/lib/format';
import type { Case } from '@/lib/types';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listCases: listCasesMock } }));

import { KpiDrilldownPanel, type KpiDrilldownSpec } from '../KpiDrilldownPanel';

const CASES = [
  {
    case_id: 'case-1',
    case_number: 'SOC-1',
    created_at: '2026-10-25T15:09:15Z',
    title: 'Brute force on vpn-gw-2',
    severity_band: 'high',
    risk_score: 73,
    status: 'open',
  },
] as unknown as Case[];

const SPEC: KpiDrilldownSpec = {
  key: 'kpi-open-cases',
  title: 'Open cases',
  population: 'Every case that is still open, not filtered by the window.',
  match: () => true,
  defaultRange: 'all',
  windowHours: 24,
  populationResolvedBy: 'store',
};

function renderPanel() {
  return render(
    <KpiDrilldownPanel
      spec={SPEC}
      panelId="kpi-panel"
      headingId="kpi-panel-heading"
      onClose={() => undefined}
      metrics={[
        { key: 'kpi-open-cases', label: 'Open cases', value: '1' },
        { key: 'kpi-total-cases', label: 'Total cases', value: '4' },
      ]}
      onSelectMetric={() => undefined}
    />,
  );
}

/** Every text node and accessible-name attribute in the open dialog. */
function renderedCopy(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim()) out.push(node.textContent);
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = el.getAttribute(attr);
      if (value) out.push(value);
    }
  }
  return out;
}

describe('KpiDrilldownPanel copy', () => {
  beforeEach(() => {
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length, limit_applied: 200 });
  });

  it('words the narrowing, switcher, scroll region and caption without an em dash', async () => {
    renderPanel();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('SOC-1');

    // Narrow the all-time stock to a bounded range, which adds the narrowing sentence.
    await userEvent.click(within(dialog).getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('kpi-drilldown-population')).toHaveTextContent(
        'Narrowed here to Last 7 days. The list below is a slice of that population, not the whole of it.',
      ),
    );
    await within(dialog).findByText('SOC-1');

    expect(within(dialog).getByTestId('kpi-drilldown-metrics')).toHaveAttribute(
      'aria-label',
      "Switch metric. Values are the dashboard's own numerals",
    );
    expect(within(dialog).getByTestId('kpi-drilldown-scroll')).toHaveAttribute(
      'aria-label',
      'Open cases cases, scrollable evidence',
    );
    expect(dialog.querySelector('caption')).toHaveTextContent(
      'Open cases: the cases read for the current filters',
    );

    const EM_DASH = String.fromCharCode(0x2014);
    const dashed = renderedCopy(dialog).filter(
      (text) => text.includes(EM_DASH) && text.trim() !== DASH,
    );
    expect(dashed).toEqual([]);
  });
});
