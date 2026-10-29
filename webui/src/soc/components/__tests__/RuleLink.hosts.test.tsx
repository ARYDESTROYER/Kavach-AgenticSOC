/**
 * RuleLink in its hosts outside chat (Round 14, SPEC §4.6.5): the Case Manager facts rail,
 * the Logs row detail, Auto-tuning (the rule inspector and the applied-changes ledger),
 * "Precedent by rule" in health diagnostics and the Cyber Defence Center's top signatures.
 * Each names the rule as a link that opens the ONE rule sheet, says where it was opened
 * and passes the window of the surface it sits on. A surface that refreshes on its own
 * keeps the sheet open while the row that opened it re-renders or leaves (the Logs live
 * tail pauses under it; a LIVE re-rank never closes it).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { summaryMock, logsMock, recsMock, getConfigMock, schedulerHealthMock, telemetryMock } = vi.hoisted(() => ({
  summaryMock: vi.fn(),
  logsMock: vi.fn(),
  recsMock: vi.fn(),
  getConfigMock: vi.fn(),
  schedulerHealthMock: vi.fn(),
  telemetryMock: vi.fn(),
}));

vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true, authEnabled: false });
  return { useAuth: auth, useOptionalAuth: auth };
});
vi.mock('@/soc/pages/Tuning.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/pages/Tuning.api')>();
  return {
    ...actual,
    tuningApi: {
      recommendations: recsMock,
      getConfig: getConfigMock,
      putConfig: vi.fn(),
      apply: vi.fn(),
      rollback: vi.fn(),
      schedulerHealth: schedulerHealthMock,
      sourceRecommendations: telemetryMock,
    },
  };
});
vi.mock('@/soc/hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/soc/pages/AgentEffectiveness', () => ({
  AgentEffectivenessSummary: () => <section aria-label="Observed outcomes" />,
}));

import type { Case, DiagnosticsHealth } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import { FactsRail } from '@/soc/pages/casedetail/FactsRail';
import { SignatureList, topSignatureItems } from '@/soc/pages/Overview';
import Tuning from '@/soc/pages/Tuning';
import type { TuningRecommendationsResponse } from '@/soc/pages/Tuning.api';
import { FutileRuleLinks } from '../HealthDiagnostics';
import { UnifiedLogsBody } from '../UnifiedLogsSheet';
import { resetRuleSheetStoreForTests } from '../rule-sheet-store';
import { latestFixture, summaryFixture } from './rule-sheet.fixtures';

beforeAll(async () => {
  await import('../RuleSheet');
});

beforeEach(() => {
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
  summaryMock.mockReset();
  logsMock.mockReset();
});

async function expectSheet(rule: string, from: string) {
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: rule })).toBeInTheDocument();
  expect(dialog).toHaveAccessibleDescription(`From ${from}`);
  return dialog;
}

const CASE = {
  case_id: 'case-7f2a',
  case_number: 'CASE-2026-0042',
  title: 'Repeated SSH failures',
  status: 'escalated',
  verdict: 'TRUE_POSITIVE',
  confidence: 0.9,
  risk_score: 80,
  source_name: 'IBM QRadar SIEM',
  entity: { type: 'ip', value: '203.0.113.9' },
  rule_ids: ['ssh_bruteforce', 'Fehlgeschlagene Anmeldung über SSH'],
  created_at: '2026-10-11T10:00:00Z',
  updated_at: '2026-10-11T10:05:00Z',
  history: [],
  tags: [],
} as unknown as Case;

describe('Case Manager facts rail', () => {
  it('names each detection rule as a link that opens the sheet from the case', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <FactsRail c={CASE} outcome={caseOutcome(CASE)} triage={null} users={[]} canAssign={false} onCaseChange={vi.fn()} />
      </TooltipProvider>,
    );
    const source = screen.getByTestId('facts-source');
    expect(within(source).getByText('Detection rules')).toBeInTheDocument();
    expect(within(source).getByRole('button', { name: 'Open rule Fehlgeschlagene Anmeldung über SSH' })).toBeInTheDocument();
    // The Ask AI chip keeps its row beside the rule (AskAiChip.hosts.test pins the chip).
    expect(within(source).getByRole('button', { name: 'Open rule ssh_bruteforce' }).closest('.group\\/ask')).not.toBeNull();
    await user.click(within(source).getByRole('button', { name: 'Open rule ssh_bruteforce' }));
    await expectSheet('ssh_bruteforce', 'CASE-2026-0042');
    await waitFor(() =>
      expect(summaryMock).toHaveBeenCalledWith({ rule: 'ssh_bruteforce', window: 'now-3d' }, expect.any(AbortSignal)),
    );
  });

  it('keeps a letter typed in the rule sheet from the case shortcuts behind it, and Esc closes only the sheet', async () => {
    // The case surface listens for A, C, E, H, R, M and T on the document (CaseDetail); a
    // key typed in the modal rule sheet must never open a case action behind it.
    const caseShortcuts = vi.fn();
    document.addEventListener('keydown', caseShortcuts);
    try {
      const user = userEvent.setup();
      render(
        <TooltipProvider>
          <FactsRail c={CASE} outcome={caseOutcome(CASE)} triage={null} users={[]} canAssign={false} onCaseChange={vi.fn()} />
        </TooltipProvider>,
      );
      const link = screen.getByRole('button', { name: 'Open rule ssh_bruteforce' });
      await user.click(link);
      const dialog = await expectSheet('ssh_bruteforce', 'CASE-2026-0042');
      const title = within(dialog).getByRole('heading', { name: 'ssh_bruteforce' });
      await waitFor(() => expect(document.activeElement).toBe(title));
      caseShortcuts.mockClear();
      for (const key of ['r', 'a', 'c', 'e', 'h', 'm', 't']) fireEvent.keyDown(title, { key });
      expect(caseShortcuts).not.toHaveBeenCalled();
      fireEvent.keyDown(title, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(link));
    } finally {
      document.removeEventListener('keydown', caseShortcuts);
    }
  });
});

describe('Logs row detail', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the rule of a row over the Logs window', async () => {
    const user = userEvent.setup();
    logsMock.mockResolvedValue({
      ...latestFixture(1),
      logs: [{ ...latestFixture(1).logs[0], id: 'evt-9', rule: 'auth.failed_login' }],
    });
    render(<UnifiedLogsBody initialFrom="now-24h" />);
    await screen.findByRole('table');
    await user.click(await screen.findByRole('button', { name: 'Show raw event for evt-9' }));
    const entities = screen.getByTestId('ulog-row-entities');
    await user.click(within(entities).getByRole('button', { name: 'Open rule auth.failed_login' }));
    await expectSheet('auth.failed_login', 'Logs');
    await waitFor(() =>
      expect(summaryMock).toHaveBeenCalledWith({ rule: 'auth.failed_login', window: 'now-24h' }, expect.any(AbortSignal)),
    );
  });

  it('keeps the rule sheet open while Logs live tail refreshes: the tail pauses under it and resumes on close', async () => {
    const base = latestFixture(1).logs[0];
    let tableReads = 0;
    logsMock.mockImplementation(async (params: { rule?: string }) => {
      if (params?.rule) return latestFixture();
      tableReads += 1;
      // The first read holds evt-9; every later one only a newer event, so a tick that ran
      // would drop the expanded row and its rule link.
      const row =
        tableReads === 1
          ? { ...base, id: 'evt-9', rule: 'auth.failed_login' }
          : { ...base, id: `evt-new-${tableReads}`, ts: '2030-01-01T00:00:00Z', rule: 'other' };
      return { ...latestFixture(1), logs: [row] };
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<UnifiedLogsBody initialFrom="now-24h" />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-refresh every 10 seconds' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show raw event for evt-9' }));
    const link = within(screen.getByTestId('ulog-row-entities')).getByRole('button', { name: 'Open rule auth.failed_login' });
    fireEvent.click(link);
    const dialog = await expectSheet('auth.failed_login', 'Logs');
    expect(tableReads).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    // No table read while the sheet covers the rows, so nothing it was opened from goes.
    expect(tableReads).toBe(1);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(link.isConnected).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
    // Closed: the tail resumes on its next tick.
    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    await waitFor(() => expect(tableReads).toBe(2));
  });
});

describe('Auto-tuning', () => {
  const RECS: TuningRecommendationsResponse = {
    enabled: true,
    cadence: 'nightly',
    fp_rate_target: 0.3,
    min_samples: 25,
    auto_apply_confirmed: true,
    window_cases: 120,
    rule_noise: [{ rule_id: 'auth-brute', total: 40, fp: 30, tp: 10, fp_rate: 0.62, volume_ewma: 4.2, over_target: true }],
    recommendations: [],
    applied: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'led-1', rule_id: 'rule-live', target: 'correlation_n', before: 3, after: 4, rolled_back: false, applied_at: '2026-07-01T10:00:00Z' } as any,
    ],
  };

  beforeEach(() => {
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue({
      config: { enabled: true, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3, wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly', shadow_eval: true },
    });
    schedulerHealthMock.mockResolvedValue({ scheduler_runtime_running: true, workers: {} });
    telemetryMock.mockResolvedValue({ recommendations: [] });
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('opens the inspected rule and a ledger rule from the page', async () => {
    window.location.hash = '#/tuning';
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    await waitFor(() => expect(recsMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect rule auth-brute' }));
    const detail = await screen.findByLabelText('Detail for rule auth-brute');
    const inspectorLink = within(detail).getByRole('button', { name: 'Open rule auth-brute' });
    // The page's rule links share one sheet that lives with the page, so a reload that
    // drops the inspected rule never closes the sheet being read.
    const pageHost = inspectorLink.dataset.ruleHost;
    expect(pageHost).toBeTruthy();
    fireEvent.click(inspectorLink);
    const sheet = await expectSheet('auth-brute', 'Auto-tuning');
    // On Auto-tuning already: the sheet keeps its tuning facts but offers no link to the
    // page the person is on.
    const about = await within(sheet).findByRole('region', { name: 'About this rule' });
    expect(about).toHaveTextContent('False-positive rate at least 12%');
    expect(within(about).queryByRole('link', { name: 'Open Auto-tuning' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), { key: 'Enter' });
    const ledgerLink = await screen.findByRole('button', { name: 'Open rule rule-live' });
    expect(ledgerLink).toHaveAttribute('title', 'rule-live');
    expect(ledgerLink.dataset.ruleHost).toBe(pageHost);
    fireEvent.click(ledgerLink);
    await expectSheet('rule-live', 'Auto-tuning');
  });
});

describe('Precedent by rule (health diagnostics)', () => {
  const effectiveness = (overrides: Record<string, unknown> = {}) =>
    ({
      futility_measured: true,
      futile_rule_count: 7,
      futile_rules: Array.from({ length: 7 }, (_, i) => ({ rule_identity: `rule-${i}`, rule_ids: [`rule-${i}`] })),
      ...overrides,
    }) as unknown as DiagnosticsHealth['precedent_effectiveness'];

  it('names the rules that are not helping, five at most, each opening the sheet', async () => {
    render(<FutileRuleLinks effectiveness={effectiveness()} />);
    const line = screen.getByTestId('futile-rule-links');
    // A lead that stands on its own for a screen reader, continuing the tile's sentence.
    expect(line).toHaveTextContent('Rules that still need a human: rule-0, rule-1, rule-2, rule-3, rule-4 and 2 more');
    fireEvent.click(within(line).getByRole('button', { name: 'Open rule rule-2' }));
    await expectSheet('rule-2', 'Health diagnostics');
  });

  it('never names a count it cannot back when the server listed only part of the rules', async () => {
    // The server lists at most 20 rule identities; `futile_rule_count` counts all 25. The
    // 5 unlisted may share rule ids with the listed ones, so the line gives a floor.
    render(
      <FutileRuleLinks
        effectiveness={effectiveness({
          futile_rule_count: 25,
          futile_rules: Array.from({ length: 20 }, (_, i) => ({ rule_identity: `rule-${i}`, rule_ids: [`rule-${i}`] })),
        })}
      />,
    );
    const line = screen.getByTestId('futile-rule-links');
    expect(line).toHaveTextContent('Rules that still need a human: rule-0, rule-1, rule-2, rule-3, rule-4 and at least 15 more');
    expect(line).not.toHaveTextContent(/and 15 more/);
  });

  it('says "and more" when every listed rule is named but more were not listed', () => {
    render(
      <FutileRuleLinks
        effectiveness={effectiveness({
          futile_rule_count: 22,
          futile_rules: [
            { rule_identity: 'a|b', rule_ids: ['rule-a', 'rule-b'] },
            { rule_identity: 'a', rule_ids: ['rule-a'] },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('futile-rule-links')).toHaveTextContent('Rules that still need a human: rule-a, rule-b and more');
  });

  it('names nothing when the report did not run or found nothing', () => {
    const { container } = render(<FutileRuleLinks effectiveness={effectiveness({ futility_measured: false })} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<FutileRuleLinks effectiveness={effectiveness({ futile_rules: [], futile_rule_count: 0 })} />);
    expect(empty.container).toBeEmptyDOMElement();
  });
});

describe('Cyber Defence Center top signatures', () => {
  const cases = [
    { case_id: 'a', title: 'ip:10.0.0.5 · demo_rdp_bruteforce', rule_ids: ['demo_rdp_bruteforce'] },
    { case_id: 'b', title: 'ip:10.0.0.5 · demo_rdp_bruteforce', rule_ids: ['demo_rdp_bruteforce'] },
    { case_id: 'c', title: 'Impossible travel', rule_ids: ['travel', 'geo_jump', 'admin_sign_in'] },
    { case_id: 'd', title: '', cluster_signature: '', rule_ids: [] },
  ] as unknown as Case[];

  it('keeps the signature grouping and carries the rules behind each, most frequent first', () => {
    const items = topSignatureItems(cases);
    expect(items.map((i) => [i.label, i.value, i.sub])).toEqual([
      ['ip:10.0.0.5 · demo_rdp_bruteforce', 2, '50% of cases'],
      ['Impossible travel', 1, '25% of cases'],
      ['Uncategorized', 1, '25% of cases'],
    ]);
    expect(items[0].rules).toEqual(['demo_rdp_bruteforce']);
    expect(items[1].rules).toEqual(['travel', 'geo_jump', 'admin_sign_in']);
    expect(items[2].rules).toEqual([]);
  });

  it('opens a signature rule over the dashboard window', async () => {
    const window = { from: 'now-7d', to: 'now', label: 'Last 7 days' };
    render(<SignatureList items={topSignatureItems(cases)} window={window} />);
    const list = screen.getByTestId('signature-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Rule demo_rdp_bruteforce · 50% of cases');
    expect(rows[1]).toHaveTextContent('Rules travel, geo_jump +1 more · 25% of cases');
    expect(rows[2]).toHaveTextContent('25% of cases');
    expect(within(rows[2]).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open rule demo_rdp_bruteforce' }));
    await expectSheet('demo_rdp_bruteforce', 'Cyber Defence Center');
    await waitFor(() =>
      expect(summaryMock).toHaveBeenCalledWith({ rule: 'demo_rdp_bruteforce', window: 'now-7d' }, expect.any(AbortSignal)),
    );
  });

  it('keeps the rule sheet open when a LIVE refresh drops the row that opened it', async () => {
    const range = { from: 'now-24h', to: 'now', label: 'Last 24 hours' };
    const { rerender } = render(<SignatureList items={topSignatureItems(cases)} window={range} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open rule travel' }));
    const dialog = await expectSheet('travel', 'Cyber Defence Center');
    // A LIVE tick: new cases re-rank the list and the "Impossible travel" row falls out.
    const refreshed = [
      ...Array.from({ length: 9 }, (_, i) => ({ case_id: `n${i}`, title: `Signature ${i}`, rule_ids: [`rule-${i}`] })),
      ...Array.from({ length: 9 }, (_, i) => ({ case_id: `m${i}`, title: `Signature ${i}`, rule_ids: [`rule-${i}`] })),
    ] as unknown as Case[];
    rerender(<SignatureList items={topSignatureItems(refreshed)} window={range} />);
    expect(screen.queryByRole('button', { name: 'Open rule travel', hidden: true })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('shows the empty state with no cases', () => {
    render(<SignatureList items={[]} window={{ from: 'now-24h', to: 'now', label: 'Last 24 hours' }} />);
    expect(screen.getByText('No signatures yet')).toBeInTheDocument();
  });
});
