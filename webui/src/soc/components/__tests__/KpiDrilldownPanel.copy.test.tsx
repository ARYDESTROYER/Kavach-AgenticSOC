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
 *
 * The accessible names and the loading label name the panel's population as cases
 * (`casesNoun`): a tile label that already ends in "cases" ("Total cases", "Open cases")
 * is used as it is, so no name reads "Total cases cases"; any other label gets the noun.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DASH } from '@/lib/format';
import type { Case } from '@/lib/types';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listCases: listCasesMock } }));

import { casesNoun, KpiDrilldownPanel, type KpiDrilldownSpec } from '../KpiDrilldownPanel';

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

const THREE_CASES = [1, 2, 3].map((n) => ({
  case_id: `case-${n}`,
  case_number: `SOC-${n}`,
  created_at: `2026-10-2${n}T15:09:15Z`,
  title: `Brute force on vpn-gw-${n}`,
  severity_band: 'high',
  risk_score: 70 + n,
  status: 'open',
  // A detection source on the rows read is what mounts the source filter, so its
  // accessible name is checked with the others.
  detection_source: 'rule',
})) as unknown as Case[];

/** Each control, by test id, carries exactly this accessible name. */
function expectNames(root: HTMLElement, names: Record<string, string>) {
  for (const [testId, name] of Object.entries(names)) {
    const el = within(root).getByTestId(testId);
    // Radix' Select trigger is a combobox and the search field a textbox: both take their
    // name from `aria-label`, which is what a screen reader announces.
    expect({ testId, name: el.getAttribute('aria-label') }).toEqual({ testId, name });
  }
}

/** Every rendered string or accessible name that says "cases cases". */
function repeatedNoun(root: HTMLElement): string[] {
  return renderedCopy(root).filter((text) => /\bcases\s+cases\b/i.test(text));
}

const SPEC: KpiDrilldownSpec = {
  key: 'kpi-open-cases',
  title: 'Open cases',
  population: 'Every case that is still open, not filtered by the window.',
  match: () => true,
  defaultRange: 'all',
  windowHours: 24,
  populationResolvedBy: 'store',
};

function renderPanel(spec: KpiDrilldownSpec = SPEC) {
  return render(
    <KpiDrilldownPanel
      spec={spec}
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
      'Open cases, scrollable evidence',
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

  it('names a population whose label already says cases once', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    listCasesMock.mockReset();
    listCasesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    renderPanel({ ...SPEC, key: 'kpi-total-cases', title: 'Total cases' });
    const dialog = await screen.findByRole('dialog');

    // The loading label, while the first page is still being read.
    expect(within(dialog).getByRole('status', { name: 'Loading Total cases' })).toBeInTheDocument();

    // Three rows of a population of ten, served three at a time, so "Read more" shows.
    resolveFirst({ cases: THREE_CASES, total: 10, limit_applied: 3 });
    await within(dialog).findByText('SOC-3');

    expectNames(dialog, {
      'kpi-drilldown-search': 'Filter Total cases',
      'kpi-drilldown-severity': 'Filter Total cases by severity',
      'kpi-drilldown-status': 'Filter Total cases by status',
      'kpi-drilldown-source': 'Filter Total cases by detection source',
      'kpi-drilldown-sort': 'Sort Total cases',
      'kpi-drilldown-range': 'Time range for Total cases',
      'kpi-drilldown-scroll': 'Total cases, scrollable evidence',
      'kpi-drilldown-export': 'Download the 3 listed Total cases as CSV',
      'kpi-drilldown-more': 'Read the next 3 Total cases',
    });
    expect(repeatedNoun(dialog)).toEqual([]);
  });

  it('adds the noun to a population label that does not end in cases', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    listCasesMock.mockReset();
    listCasesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    renderPanel({ ...SPEC, key: 'kpi-awaiting-decision', title: 'Awaiting a decision' });
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByRole('status', { name: 'Loading Awaiting a decision cases' }),
    ).toBeInTheDocument();

    resolveFirst({ cases: THREE_CASES, total: 10, limit_applied: 3 });
    await within(dialog).findByText('SOC-3');

    expectNames(dialog, {
      'kpi-drilldown-search': 'Filter Awaiting a decision cases',
      'kpi-drilldown-severity': 'Filter Awaiting a decision cases by severity',
      'kpi-drilldown-status': 'Filter Awaiting a decision cases by status',
      'kpi-drilldown-source': 'Filter Awaiting a decision cases by detection source',
      'kpi-drilldown-sort': 'Sort Awaiting a decision cases',
      'kpi-drilldown-range': 'Time range for Awaiting a decision cases',
      'kpi-drilldown-scroll': 'Awaiting a decision cases, scrollable evidence',
      'kpi-drilldown-export': 'Download the 3 listed Awaiting a decision cases as CSV',
      'kpi-drilldown-more': 'Read the next 3 Awaiting a decision cases',
    });
    expect(repeatedNoun(dialog)).toEqual([]);
  });
});

describe('casesNoun', () => {
  it('uses a label that already ends in the word cases as it is', () => {
    expect(casesNoun('Total cases')).toBe('Total cases');
    expect(casesNoun('Open cases')).toBe('Open cases');
    expect(casesNoun('Open Cases')).toBe('Open Cases');
    expect(casesNoun('Cases')).toBe('Cases');
    expect(casesNoun('  Total cases  ')).toBe('Total cases');
  });

  it('adds the noun to any other label', () => {
    expect(casesNoun('Awaiting a decision')).toBe('Awaiting a decision cases');
    expect(casesNoun('Total critical')).toBe('Total critical cases');
    expect(casesNoun('Auto-closed')).toBe('Auto-closed cases');
    // A word that merely ends in the letters is not the noun.
    expect(casesNoun('Showcases')).toBe('Showcases cases');
    // The noun anywhere but last is not the ending either.
    expect(casesNoun('Cases closed')).toBe('Cases closed cases');
  });
});
