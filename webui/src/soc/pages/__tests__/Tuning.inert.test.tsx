/**
 * Tuning — the correlation_n INERTNESS disclosure.
 *
 * A rule can sit well over its false-positive target and still receive no
 * correlation-threshold recommendation, because the live pipeline would discard the
 * raise (an alerts-role feed forces mode=EVERY, or the rule's correlation is defined
 * where `correlation_rules` is never read). Before the backend fix the tuner drafted a
 * dead change; after it the tuner correctly drafts nothing — which, unexplained, is the
 * SAME silence that made the original defect invisible.
 *
 * So the reason must be visible wherever `rule_noise` is rendered. This spec pins:
 *   (a) the rule row carries an explicit "Threshold change would not help" marker;
 *   (b) the inspector states the reason from the ONE reason-code table, as a plain
 *       sentence; the backend's engineering detail ("configured mode=EVERY ...") is never
 *       rendered (Round 14, SPEC §5 F12);
 *   (c) a rule with a normal (non-inert) picture shows neither;
 *   (d) an unknown future reason code still renders rather than being dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  useAuth: () => ({ username: 'tester', hasPermission: hasPermissionMock, authEnabled: false }),
}));

vi.mock('@/soc/hooks/useMediaQuery', () => ({ useMediaQuery: mediaQueryMock }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/soc/pages/AgentEffectiveness', () => ({
  AgentEffectivenessSummary: () => <section aria-label="Observed outcomes" />,
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning, { INERT_FALLBACK_DETAIL, INERT_REASONS } from '../Tuning';
import type { RuleNoise, TuningRecommendationsResponse } from '../Tuning.api';

const INERT_DETAIL =
  'every observed case for this rule fired with an effective correlation mode of EVERY ' +
  '(n=1), which is what an alerts-role feed forces, so a correlation_n raise would be ' +
  'discarded on the next poll';

function response(rules: RuleNoise[]): TuningRecommendationsResponse {
  return {
    enabled: true,
    cadence: 'nightly',
    fp_rate_target: 0.3,
    min_samples: 25,
    auto_apply_confirmed: true,
    window_cases: 120,
    rule_noise: rules,
    recommendations: [],
    applied: [],
  };
}

const NOISY_INERT: RuleNoise = {
  rule_id: 'alerts-role-brute-force',
  observed: 60,
  total: 40,
  analyst_samples: 40,
  unconfirmed: 20,
  fp: 30,
  tp: 10,
  fp_rate: 0.62,
  volume_ewma: 4.2,
  over_target: true,
  correlation_n_inert: true,
  correlation_n_inert_reason: 'alerts_role_every_override',
  correlation_n_inert_detail: INERT_DETAIL,
};

const NOISY_TUNABLE: RuleNoise = {
  rule_id: 'events-role-scanner',
  observed: 60,
  total: 40,
  analyst_samples: 40,
  unconfirmed: 20,
  fp: 30,
  tp: 10,
  fp_rate: 0.62,
  volume_ewma: 4.2,
  over_target: true,
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

function renderTuning() {
  return render(
    <TooltipProvider>
      <Tuning onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Tuning — correlation_n inertness', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    applyMock.mockReset();
    rollbackMock.mockReset();
    schedulerHealthMock.mockReset();
    telemetryMock.mockReset();
    hasPermissionMock.mockReset();
    hasPermissionMock.mockReturnValue(true);
    mediaQueryMock.mockReset();
    mediaQueryMock.mockReturnValue(true);
    getConfigMock.mockResolvedValue(CONFIG);
    schedulerHealthMock.mockResolvedValue({ scheduler_runtime_running: true, workers: {} });
    telemetryMock.mockResolvedValue({
      status: 'not_available',
      scanned_cases: 0,
      truncated: false,
      evidence_schema: 'agentic-soc.telemetry-gap/v1',
      capture_status: 'not_available',
      capture_not_available_reason: '',
      not_available_reason: '',
      recommendations: [],
    });
  });

  it('marks an over-target rule whose threshold raise could not take effect', async () => {
    recsMock.mockResolvedValue(response([NOISY_INERT]));

    renderTuning();

    expect(await screen.findByText('alerts-role-brute-force')).toBeInTheDocument();
    expect(screen.getByText('Threshold change would not help')).toBeInTheDocument();
    // The "next step" copy explains the structural reason instead of going silent.
    expect(screen.getByText('Correlation threshold cannot help this rule')).toBeInTheDocument();
  });

  it('explains the reason in the rule inspector as a plain sentence, never the raw backend text (F12)', async () => {
    recsMock.mockResolvedValue(response([NOISY_INERT]));

    const { container } = renderTuning();

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect rule alerts-role-brute-force' }));

    expect(await screen.findByText('A threshold change would not help')).toBeInTheDocument();
    expect(screen.getByText('Alerts feed sends every alert')).toBeInTheDocument();
    expect(
      screen.getAllByText(INERT_REASONS.alerts_role_every_override.detail).length,
    ).toBeGreaterThan(0);
    // The backend's engineering detail never reaches the screen, nor a mode token.
    expect(screen.queryAllByText(INERT_DETAIL)).toHaveLength(0);
    expect(container.textContent).not.toMatch(/mode=EVERY|correlation_n/);
  });

  it('says in plain words why a mode=EVERY rule cannot be helped by a threshold raise (F12)', async () => {
    recsMock.mockResolvedValue(
      response([
        {
          ...NOISY_INERT,
          rule_id: 'every-event-rule',
          correlation_n_inert_reason: 'correlation_mode_every',
          correlation_n_inert_detail: 'configured mode=EVERY, which never consults n, so a correlation_n raise would change nothing',
        },
      ]),
    );

    const { container } = renderTuning();

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect rule every-event-rule' }));
    expect(await screen.findByText('Fires on every event')).toBeInTheDocument();
    expect(
      screen.getAllByText('This rule fires on every event, so raising its threshold would change nothing.').length,
    ).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/mode=EVERY|never consults n|correlation_n/);
  });

  it('shows no inertness marker for a rule whose threshold raise would work', async () => {
    recsMock.mockResolvedValue(response([NOISY_TUNABLE]));

    renderTuning();

    expect(await screen.findByText('events-role-scanner')).toBeInTheDocument();
    expect(screen.queryByText('Threshold change would not help')).toBeNull();
    expect(screen.queryByText('Correlation threshold cannot help this rule')).toBeNull();
  });

  it('still renders an unrecognised future reason code rather than dropping it', async () => {
    recsMock.mockResolvedValue(
      response([
        {
          ...NOISY_INERT,
          rule_id: 'future-shape',
          correlation_n_inert_reason: 'some_new_backend_reason',
          correlation_n_inert_detail: '',
        },
      ]),
    );

    renderTuning();

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect rule future-shape' }));

    await waitFor(() =>
      expect(screen.getByText('A threshold change would not help')).toBeInTheDocument(),
    );
    expect(screen.getByText('Some new backend reason')).toBeInTheDocument();
    expect(screen.getAllByText(INERT_FALLBACK_DETAIL).length).toBeGreaterThan(0);
  });
});
