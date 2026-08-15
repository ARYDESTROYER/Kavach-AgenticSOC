/**
 * Tuning page tests (Round 4 / Wave 4 — WB).
 *
 * Mocks the co-located Tuning.api module (no network) + the auth context (grant-all)
 * and asserts:
 *   - recommendations render with rule id, FP rate, and the proposed before→after
 *     change as PLAIN text (#9),
 *   - the honest-framing banner is present (tuning never closes a case, #3),
 *   - a suppression DROP shows a "needs approval" affordance + links to Approvals
 *     (never auto-applied),
 *   - Apply calls tuningApi.apply for an eligible recommendation,
 *   - the config panel reflects the loaded policy.
 *
 * The api module is fully mocked; the config-save path is exercised via the apply
 * button (a full StickySaveBar flow is left to manual QA).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const {
  recsMock,
  getConfigMock,
  putConfigMock,
  applyMock,
  rollbackMock,
  schedulerHealthMock,
  telemetryMock,
  hasPermissionMock,
  mediaQueryMock,
} = vi.hoisted(() => ({
    recsMock: vi.fn(),
    getConfigMock: vi.fn(),
    putConfigMock: vi.fn(),
  applyMock: vi.fn(),
  rollbackMock: vi.fn(),
  schedulerHealthMock: vi.fn(),
  telemetryMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  mediaQueryMock: vi.fn(),
}));

vi.mock('@/soc/pages/Tuning.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Tuning.api')>();
  return {
    ...actual,
    tuningApi: {
      recommendations: recsMock,
      getConfig: getConfigMock,
      putConfig: putConfigMock,
      apply: applyMock,
      rollback: rollbackMock,
      schedulerHealth: schedulerHealthMock,
      sourceRecommendations: telemetryMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    hasPermission: hasPermissionMock,
    authEnabled: false,
  }),
}));

vi.mock('@/soc/hooks/useMediaQuery', () => ({
  useMediaQuery: mediaQueryMock,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/soc/pages/AgentEffectiveness', () => ({
  AgentEffectivenessSummary: ({ onOpenFull }: { onOpenFull: () => void }) => (
    <section aria-label="Observed outcomes">
      <button type="button" onClick={onOpenFull}>
        View full evidence
      </button>
    </section>
  ),
}));

import { TooltipProvider } from '@/ui/tooltip';
import { RouterProvider } from '@/soc/router';
import { useHasUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

const RECS: TuningRecommendationsResponse = {
  enabled: true,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
  auto_apply_confirmed: true,
  window_cases: 120,
  rule_noise: [
    { rule_id: 'auth-brute', total: 40, fp: 30, tp: 10, fp_rate: 0.62, volume_ewma: 4.2, over_target: true },
  ],
  recommendations: [
    {
      rule_id: 'auth-brute',
      kind: 'correlation_n',
      before: 3,
      after: 4,
      feed_key: null,
      source_id: null,
      feed_id: null,
      fp_rate: 0.62,
      samples: 40,
      auto_apply: true,
      shadow_blocked: false,
      reason: 'auto_apply_candidate',
    },
    {
      rule_id: 'noisy-web',
      kind: 'suppression',
      before: null,
      after: 'drop',
      feed_key: 'src-1:feed-2',
      source_id: 'src-1',
      feed_id: 'feed-2',
      fp_rate: 0.85,
      samples: 55,
      auto_apply: false,
      shadow_blocked: false,
      reason: 'suppression_drop',
    },
  ],
  applied: [],
};

const CONFIG = {
  config: {
    enabled: true,
    min_samples: 25,
    max_n_step: 1,
    fp_rate_target: 0.3,
    wilson_z: 1.96,
    ewma_alpha: 0.2,
    cadence: 'nightly' as const,
    shadow_eval: true,
    auto_apply_confirmed: true,
  },
};

function renderTuning(onNavigate = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <Tuning onNavigate={onNavigate} />
      <DirtyProbe />
    </TooltipProvider>,
  );
  return { ...utils, onNavigate };
}

function DirtyProbe() {
  return <output data-testid="tuning-dirty-probe">{useHasUnsavedChanges() ? 'dirty' : 'clean'}</output>;
}

describe('Tuning page', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    applyMock.mockReset();
    schedulerHealthMock.mockReset();
    telemetryMock.mockReset();
    hasPermissionMock.mockReset();
    hasPermissionMock.mockReturnValue(true);
    mediaQueryMock.mockReset();
    mediaQueryMock.mockReturnValue(true);
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue(CONFIG);
    applyMock.mockResolvedValue({
      ok: true,
      rule_id: 'auth-brute',
      applied: [{ id: 'led-1', rule_id: 'auth-brute', target: 'correlation_n', before: 3, after: 4, active: true }],
      queued_proposals: [],
      shadow_blocked: [],
    });
    schedulerHealthMock.mockResolvedValue({
      scheduler_runtime_running: true,
      workers: {
        threshold_tuner: {
          enabled: true,
          gated: false,
          running: false,
          cadence: 'nightly',
          last_attempt_at: '2026-08-01T01:00:00Z',
          last_success_at: '2026-08-01T01:00:01Z',
          last_error: '',
          processed: 3,
        },
      },
    });
    telemetryMock.mockResolvedValue({
      status: 'available',
      scanned_cases: 12,
      truncated: false,
      evidence_schema: 'case.telemetry_gaps.v1',
      capture_status: 'available',
      capture_not_available_reason: '',
      not_available_reason: '',
      recommendations: [
        {
          field: 'dns.question.name',
          source_type: 'dns',
          source_label: 'Outgoing DNS logs',
          benefit: 'Resolve the destination domain observed during command-and-control review.',
          affected_case_count: 2,
          case_ids: ['case-1', 'case-2'],
          evidence: [{ result: 'DNS context was missing', query: 'source.ip:10.0.0.5' }],
        },
      ],
    });
  });

  it('states when controlled telemetry-gap capture is unavailable', async () => {
    telemetryMock.mockResolvedValue({
      status: 'not_available',
      scanned_cases: 12,
      truncated: false,
      evidence_schema: 'agentic-soc.telemetry-gap/v1',
      capture_status: 'not_available',
      capture_not_available_reason:
        'Automatic telemetry-gap capture is not available in this build.',
      not_available_reason: 'No query-backed telemetry gap has been recorded.',
      recommendations: [],
    });

    renderTuning();
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'Outcomes' }), {
      key: 'Enter',
    });

    expect(
      await screen.findByText('Telemetry evidence capture not available'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Automatic telemetry-gap capture is not available in this build.'),
    ).toBeInTheDocument();
  });

  it('renders recommendations with rule id, FP rate, and the proposed change as plain text', async () => {
    renderTuning();
    await waitFor(() => expect(recsMock).toHaveBeenCalled());

    expect(await screen.findByText('Auto-tuning')).toBeInTheDocument();
    // Rule id renders as escaped plain text in the review workspace.
    expect(screen.getAllByText('auth-brute').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule auth-brute' }));
    // The focused inspector names conservative evidence and compares it with policy.
    expect(
      screen.getAllByText(/conservative false-positive estimate is 62%/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/32 percentage points above/i).length).toBeGreaterThan(0);
    // The action explains the actual threshold move and operational effect.
    expect(screen.getAllByText('Raise the correlation threshold').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/raise the threshold from 3 to 4/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/source events remain available/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Can apply after safety check').length).toBeGreaterThan(0);
    // Proposed change values remain plain text inside the explanatory instruction.
    expect(screen.getAllByText(/from 3 to 4/i).length).toBeGreaterThan(0);
  });

  it('uses one page heading and one continuous responsive health strip', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    const pageHeadings = screen.getAllByRole('heading', { level: 1 });
    expect(pageHeadings).toHaveLength(1);
    expect(pageHeadings[0]).toHaveTextContent('Auto-tuning');

    const healthStrip = screen.getByTestId('tuning-health-strip');
    expect(healthStrip).toHaveClass('grid', 'border-y');
    expect(healthStrip.className).toMatch(/(?:sm|md|lg|xl):grid-cols-/);
    expect(healthStrip.className).not.toMatch(/rounded|shadow|bg-card/);

    const cells = Array.from(healthStrip.children);
    expect(cells).toHaveLength(3);
    expect(cells[1]).toHaveClass('border-t', 'sm:border-l', 'sm:border-t-0');
    expect(cells[2]).toHaveClass('border-t', 'sm:border-l', 'sm:border-t-0');
    expect(screen.getByTestId('kpi-needs-attention')).toHaveClass('min-h-0', 'py-3');
  });

  it('uses task-focused workspace tabs and opens on Operations', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    const tabs = screen.getByRole('tablist', { name: 'Auto-tuning workspace' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
    expect(within(tabs).getByRole('tab', { name: 'Operations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('region', { name: 'Observed outcomes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Tuning policy')).not.toBeInTheDocument();
  });

  it('uses one shared centered blocking loader on the initial page load', () => {
    recsMock.mockReturnValue(new Promise(() => {}));
    getConfigMock.mockReturnValue(new Promise(() => {}));
    const view = renderTuning();

    expect(screen.getByRole('status', { name: 'Loading auto-tuning' })).toHaveAttribute(
      'data-loading-layout',
      'page',
    );
    expect(
      view.container.querySelectorAll('[data-loading-motion="indeterminate-ring"]'),
    ).toHaveLength(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps usable tuning evidence mounted during a refresh and contains a refresh failure', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    let rejectRefresh: (reason?: unknown) => void = () => {};
    recsMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );
    getConfigMock.mockResolvedValueOnce(CONFIG);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('progressbar', { name: /refreshing auto-tuning/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('auth-brute').length).toBeGreaterThan(0);

    await act(async () => {
      rejectRefresh(new Error('refresh failed'));
    });
    expect(await screen.findByText('refresh failed')).toBeInTheDocument();
    expect(screen.getAllByText('auth-brute').length).toBeGreaterThan(0);
  });

  it('uses one rule-review workspace instead of duplicating an attention queue', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    expect(screen.getByRole('heading', { name: 'Rule review', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Rule review' }).className).not.toMatch(
      /rounded|shadow|bg-card/,
    );
    expect(screen.getByRole('region', { name: 'Approval path summary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All monitored rules' })).not.toBeInTheDocument();
  });

  it('opens rule evidence in a focused panel linked to its trigger', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    const trigger = screen.getByRole('button', { name: 'Inspect rule auth-brute' });
    fireEvent.click(trigger);

    const detail = screen.getByRole('complementary', {
      name: 'Detail for rule auth-brute',
    });
    expect(trigger).toHaveAttribute('aria-controls', 'tuning-rule-detail');
    expect(detail).toHaveAttribute('id', 'tuning-rule-detail');
    expect(detail).toHaveClass('border-y');

    const statCells = Array.from(detail.querySelector('dl')?.children ?? []);
    expect(statCells).toHaveLength(3);
    expect(statCells[1]).toHaveClass('sm:border-l');
    expect(statCells[2]).toHaveClass('sm:border-l');
    expect(within(detail).getByText('Why this rule needs attention')).toBeInTheDocument();
    expect(within(detail).getByText('Recommended action')).toBeInTheDocument();
    expect(within(detail).getByText('Expected operational effect')).toBeInTheDocument();
    expect(within(detail).getByText('Safety replay')).toBeInTheDocument();
    expect(within(detail).getByText('Supporting measurements')).toBeInTheDocument();
  });

  it('uses a focus-managed sheet for rule evidence below the wide breakpoint', async () => {
    mediaQueryMock.mockReturnValue(false);
    renderTuning();
    await screen.findAllByText('auth-brute');

    const trigger = screen.getByRole('button', { name: 'Inspect rule auth-brute' });
    fireEvent.click(trigger);

    const detail = screen.getByRole('dialog', {
      name: 'Rule evidence for auth-brute',
    });
    expect(trigger).toHaveAttribute('aria-controls', 'tuning-rule-detail');
    expect(detail).toHaveAttribute('id', 'tuning-rule-detail');
    expect(within(detail).getByText('Rule review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes an inspector when search removes its rule from the visible context', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule auth-brute' }));
    expect(
      screen.getByRole('complementary', { name: 'Detail for rule auth-brute' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search monitored rules' }), {
      target: { value: 'different-rule' },
    });
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('states the honest authority boundary without a separate banner', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');
    expect(screen.getByText(/tuning never decides a case/i)).toBeInTheDocument();
  });

  it('routes a suppression drop to Approvals instead of applying it', async () => {
    const { onNavigate } = renderTuning();
    await screen.findByText('noisy-web');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule noisy-web' }));

    // The suppression row is marked for a human decision and offers an Approvals link.
    expect(screen.getAllByText(/approval required/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/nothing is suppressed from this page/i)).toBeInTheDocument();
    const detail = screen.getByRole('complementary', { name: 'Detail for rule noisy-web' });
    const openApprovals = within(detail).getByRole('button', { name: /open approvals/i });
    fireEvent.click(openApprovals);
    expect(onNavigate).toHaveBeenCalledWith('approvals');
    // A suppression is NEVER auto-applied from here.
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('explains an inconclusive safety replay without claiming a hidden true positive', async () => {
    recsMock.mockResolvedValueOnce({
      ...RECS,
      recommendations: [
        {
          ...RECS.recommendations[0],
          auto_apply: false,
          shadow_blocked: true,
          reason: 'shadow_eval_would_hide_tp',
        },
      ],
    });
    renderTuning();

    await screen.findAllByText('auth-brute');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule auth-brute' }));
    expect(
      screen.getAllByText(/retrospective replay could not prove this change safe/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/requires a human decision in approvals/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/would hide a true positive/i)).not.toBeInTheDocument();
  });

  it('applies an eligible recommendation via tuningApi.apply', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule auth-brute' }));

    const applyBtn = screen.getByRole('button', {
      name: 'Process all changes for auth-brute',
    });
    fireEvent.click(applyBtn);
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith('auth-brute'));
  });

  it('routes an otherwise safe bounded change to Approvals in review-first mode', async () => {
    recsMock.mockResolvedValueOnce({ ...RECS, auto_apply_confirmed: false });
    getConfigMock.mockResolvedValueOnce({
      config: { ...CONFIG.config, auto_apply_confirmed: false },
    });
    renderTuning();

    await screen.findAllByText('auth-brute');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule auth-brute' }));
    expect(screen.getAllByText('Approval required').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Process all changes for auth-brute' }))
      .toHaveTextContent('Send to Approvals');
  });

  it('labels under-sampled rules as Collecting instead of Healthy', async () => {
    recsMock.mockResolvedValueOnce({
      ...RECS,
      rule_noise: [
        {
          rule_id: 'rare-cloud-rule',
          total: 8,
          fp: 1,
          tp: 7,
          fp_rate: 0.04,
          volume_ewma: 0.3,
          over_target: false,
        },
      ],
      recommendations: [],
    });
    renderTuning();

    await screen.findByText('rare-cloud-rule');
    expect(screen.getAllByText('Collecting').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/8 of 25 analyst-confirmed closed cases have been collected/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/17 more are required/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/context only until the evidence minimum is met/i).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-collecting-evidence')).toHaveTextContent('1');
  });

  it('reflects the loaded policy in the config panel', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    // The min-samples input carries the loaded value.
    const minSamples = screen.getByLabelText(/minimum samples/i) as HTMLInputElement;
    expect(minSamples.value).toBe('25');
    expect(screen.getByRole('switch', {
      name: 'Auto-apply confirmed bounded changes',
    })).toBeChecked();
  });

  it('keeps automatic writes coupled to the mandatory shadow replay', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });

    const shadow = screen.getByRole('switch', { name: 'Shadow-evaluate first' });
    fireEvent.click(screen.getByText('Advanced statistical controls'));
    const autoApply = screen.getByRole('switch', {
      name: 'Auto-apply confirmed bounded changes',
    });
    expect(shadow).toBeChecked();
    expect(autoApply).toBeChecked();

    fireEvent.click(shadow);
    expect(shadow).not.toBeChecked();
    expect(autoApply).not.toBeChecked();

    fireEvent.click(autoApply);
    expect(autoApply).toBeChecked();
    expect(shadow).toBeChecked();
  });

  it('shows scheduler evidence and query-backed telemetry opportunities', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Outcomes' }), { key: 'Enter' });
    expect(await screen.findByText('Outgoing DNS logs')).toBeInTheDocument();
    expect(screen.getByText('DNS context was missing')).toBeInTheDocument();
    expect(screen.getByText('source.ip:10.0.0.5')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    expect(await screen.findByText('Threshold tuner')).toBeInTheDocument();
    expect(screen.getByText('Scheduler running')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('registers an unsaved tuning policy until it is discarded', async () => {
    renderTuning();
    await screen.findAllByText('auth-brute');
    expect(screen.getByTestId('tuning-dirty-probe')).toHaveTextContent('clean');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable auto-tuning' }));
    await waitFor(() =>
      expect(screen.getByTestId('tuning-dirty-probe')).toHaveTextContent('dirty'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.getByTestId('tuning-dirty-probe')).toHaveTextContent('clean'),
    );
  });

  it('opens the full Agent Effectiveness evidence from the compact summary', async () => {
    const { onNavigate } = renderTuning();
    await screen.findAllByText('auth-brute');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Outcomes' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'View full evidence' }));
    expect(onNavigate).toHaveBeenCalledWith('metrics', { tab: 'effectiveness' });
  });

  it('drills through to the Analytics host when navigation comes from router context', async () => {
    window.location.hash = '#/tuning';
    render(
      <RouterProvider>
        <TooltipProvider>
          <Tuning />
        </TooltipProvider>
      </RouterProvider>,
    );
    await screen.findAllByText('auth-brute');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Outcomes' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'View full evidence' }));
    await waitFor(() => expect(window.location.hash).toBe('#/metrics?tab=effectiveness'));
  });

  it('keeps tuning available when the operator lacks the separate metrics grant', async () => {
    hasPermissionMock.mockImplementation(
      (resource: string, action: string) => resource !== 'metrics' || action !== 'view',
    );
    renderTuning();

    expect(await screen.findByText('Auto-tuning')).toBeInTheDocument();
    expect(screen.getAllByText('auth-brute').length).toBeGreaterThan(0);
    expect(screen.queryByRole('tab', { name: 'Outcomes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Observed outcomes' })).not.toBeInTheDocument();
  });

  it('does not advertise Approvals actions without proposal read access', async () => {
    hasPermissionMock.mockImplementation(
      (resource: string, action: string) => resource !== 'proposals' || action !== 'read',
    );
    renderTuning();

    await screen.findByText('noisy-web');
    expect(screen.getByText('Requires Approvals access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approvals/i })).not.toBeInTheDocument();
  });

  it('keeps policy evidence readable but hides mutations without automation manage access', async () => {
    hasPermissionMock.mockImplementation(
      (resource: string, action: string) => resource !== 'automation' || action !== 'manage',
    );
    renderTuning();

    await screen.findAllByText('auth-brute');
    expect(screen.queryByRole('button', { name: /process all changes/i })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable auto-tuning' })).toBeDisabled();
  });
});
