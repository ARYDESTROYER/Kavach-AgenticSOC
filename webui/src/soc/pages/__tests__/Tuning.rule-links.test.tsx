/**
 * Auto-tuning's rule list names every monitored rule as a RuleLink (Round 14, SPEC
 * §4.6.5, closing QA qa2-03): the rule opens the ONE rule sheet from the row itself,
 * beside the row's inspect control, never nested in it. The row's link shares the page's
 * sheet host with the inspector and the ledger, so a refresh that re-renders the list
 * never closes the sheet being read.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
vi.mock('@/soc/hooks/useMediaQuery', () => ({ useMediaQuery: () => true, useIsMobile: () => false }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/soc/pages/AgentEffectiveness', () => ({
  AgentEffectivenessSummary: () => <section aria-label="Observed outcomes" />,
}));

import { TooltipProvider } from '@/ui/tooltip';
import { resetRuleSheetStoreForTests } from '@/soc/components/rule-sheet-store';
import { latestFixture, summaryFixture } from '@/soc/components/__tests__/rule-sheet.fixtures';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

const RECS: TuningRecommendationsResponse = {
  enabled: true,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
  auto_apply_confirmed: false,
  window_cases: 62,
  rule_noise: [
    { rule_id: 'demo_noisy_scanner', total: 40, fp: 30, tp: 10, fp_rate: 0.62, volume_ewma: 4.2, over_target: true },
    { rule_id: 'demo_rdp_bruteforce', total: 30, fp: 3, tp: 27, fp_rate: 0.08, volume_ewma: 1.1, over_target: false },
  ],
  recommendations: [],
  applied: [],
};

beforeAll(async () => {
  await import('@/soc/components/RuleSheet');
});

beforeEach(() => {
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
  recsMock.mockResolvedValue(RECS);
  getConfigMock.mockResolvedValue({
    config: { enabled: true, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3, wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly', shadow_eval: true },
  });
  schedulerHealthMock.mockResolvedValue({ scheduler_runtime_running: true, workers: {} });
  telemetryMock.mockResolvedValue({ recommendations: [] });
  window.location.hash = '#/tuning';
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
  summaryMock.mockReset();
  logsMock.mockReset();
  window.location.hash = '';
});

async function renderTuning() {
  render(
    <TooltipProvider>
      <Tuning />
    </TooltipProvider>,
  );
  await waitFor(() => expect(recsMock).toHaveBeenCalled());
  return screen.findByLabelText('Monitored rules');
}

describe('Auto-tuning rule list: every rule name is a RuleLink', () => {
  it('gives every row its rule link and its inspect control, as siblings', async () => {
    const list = await renderTuning();
    const rows = await within(list).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const [row, rule] of rows.map((r, i) => [r, RECS.rule_noise[i].rule_id] as const)) {
      const link = within(row).getByRole('button', { name: `Open rule ${rule}` });
      const inspect = within(row).getByRole('button', { name: `Inspect rule ${rule}` });
      expect(inspect).not.toContainElement(link);
      expect(link).not.toContainElement(inspect);
    }
    // Before the fix the list had none: the rule sheet was only in the inspector.
    expect(within(list).getAllByRole('button', { name: /^Open rule / })).toHaveLength(2);
  });

  it('opens the one rule sheet from the row, from Auto-tuning, without inspecting the row', async () => {
    const list = await renderTuning();
    const link = await within(list).findByRole('button', { name: 'Open rule demo_noisy_scanner' });
    const inspect = within(list).getByRole('button', { name: 'Inspect rule demo_noisy_scanner' });
    fireEvent.click(link);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'demo_noisy_scanner' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('From Auto-tuning');
    expect(link).toHaveAttribute('aria-current', 'true');
    expect(inspect).toHaveAttribute('aria-expanded', 'false');
    // Closing hands focus back to the row's link.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('shares the page host with the inspector link, so a list refresh keeps the sheet open', async () => {
    const list = await renderTuning();
    const rowLink = await within(list).findByRole('button', { name: 'Open rule demo_rdp_bruteforce' });
    fireEvent.click(within(list).getByRole('button', { name: 'Inspect rule demo_rdp_bruteforce' }));
    const detail = await screen.findByLabelText('Detail for rule demo_rdp_bruteforce');
    const inspectorLink = within(detail).getByRole('button', { name: 'Open rule demo_rdp_bruteforce' });
    expect(rowLink.dataset.ruleHost).toBeTruthy();
    expect(rowLink.dataset.ruleHost).toBe(inspectorLink.dataset.ruleHost);
  });
});
