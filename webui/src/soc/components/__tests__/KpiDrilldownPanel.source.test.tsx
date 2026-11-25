/**
 * Round 16 B29: the KPI drill-down's "Source" column, its filter and its CSV name the
 * source a case came from (`source_name`, else `source_id`), the way the case facts rail
 * does. `detection_source` (detection, anomaly or rule) is only set for an event-feed
 * detection; an alert-sourced case has none, which used to leave the column blank on
 * every row and the filter missing. It now shows as "Detected by" only when a row has it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DASH } from '@/lib/format';
import type { Case } from '@/lib/types';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listCases: listCasesMock } }));

import { caseSource, KpiDrilldownPanel, type KpiDrilldownSpec } from '../KpiDrilldownPanel';

const base = {
  created_at: '2026-10-25T15:09:15Z',
  severity_band: 'high',
  risk_score: 73,
  status: 'open',
};
const CASES = [
  { ...base, case_id: 'a', case_number: 'SOC-1', title: 'Brute force', source_name: 'Splunk Enterprise Security (HEC)', detection_source: null },
  { ...base, case_id: 'b', case_number: 'SOC-2', title: 'Port scan', source_name: null, source_id: 'wazuh-prod', detection_source: null },
  { ...base, case_id: 'c', case_number: 'SOC-3', title: 'Odd login', source_name: 'Wazuh manager', detection_source: 'anomaly' },
  { ...base, case_id: 'd', case_number: 'SOC-4', title: 'No source', source_name: '  ', source_id: null, detection_source: null },
] as unknown as Case[];

const SPEC: KpiDrilldownSpec = {
  key: 'kpi-total-cases',
  title: 'Total cases',
  population: 'Every case created in the window.',
  match: () => true,
  defaultRange: 'all',
  windowHours: 24,
  populationResolvedBy: 'store',
};

function cellOf(dialog: HTMLElement, caseNumber: string): HTMLElement {
  const row = within(dialog).getByText(caseNumber).closest('tr') as HTMLElement;
  return within(row).getByTestId('kpi-drilldown-source-cell');
}

describe('KpiDrilldownPanel source (B29)', () => {
  beforeEach(() => {
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length, limit_applied: 200 });
  });

  it('reads source_name, else source_id, else nothing', () => {
    expect(CASES.map(caseSource)).toEqual(['Splunk Enterprise Security (HEC)', 'wazuh-prod', 'Wazuh manager', '']);
  });

  it('shows the source of an alert-sourced case and filters by it', async () => {
    render(<KpiDrilldownPanel spec={SPEC} panelId="p" headingId="h" onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('SOC-1');

    expect(cellOf(dialog, 'SOC-1')).toHaveTextContent(/^Splunk Enterprise Security \(HEC\)$/);
    expect(cellOf(dialog, 'SOC-2')).toHaveTextContent(/^wazuh-prod$/);
    expect(cellOf(dialog, 'SOC-3')).toHaveTextContent(/^Wazuh managerDetected by anomaly$/);
    expect(cellOf(dialog, 'SOC-4')).toHaveTextContent(new RegExp(`^${DASH}$`));

    // The filter is offered (alert feeds carry a source) and narrows to one source.
    const filter = within(dialog).getByTestId('kpi-drilldown-source');
    expect(filter).toHaveAttribute('aria-label', 'Filter Total cases by source');
    await userEvent.click(filter);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All sources', 'Splunk Enterprise Security (HEC)', 'Wazuh manager', 'wazuh-prod']);
    await userEvent.click(screen.getByRole('option', { name: 'wazuh-prod' }));
    expect(within(dialog).getAllByTestId('kpi-drilldown-row')).toHaveLength(1);
    expect(within(dialog).getByText('SOC-2')).toBeInTheDocument();
  });
});
