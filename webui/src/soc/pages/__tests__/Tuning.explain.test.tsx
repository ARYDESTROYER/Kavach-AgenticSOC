/**
 * Tuning explains its numbers honestly (Round 16 SPEC §4.5 WP11; research explainability
 * D6 and R10).
 *
 * * D6: a recommendation that outlived its feedback row and did not record its confirmed
 *   counts reads "not recorded". Before, the page derived counts from `fp_rate`, which is
 *   the Wilson LOWER BOUND: 14 false positives of 20 (bound 0.481) showed as 10 of 20,
 *   a 50% "observed" ratio.
 * * The conservative estimate explains its Wilson arithmetic with the real counts.
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
import Tuning, { conservativeEstimateExplanation, countsRecorded, observedRatioText } from '../Tuning';
import type { RuleNoise, TuningRecommendation, TuningRecommendationsResponse } from '../Tuning.api';


function response(recommendations: TuningRecommendation[]): TuningRecommendationsResponse {
  return {
    enabled: true,
    cadence: 'nightly',
    fp_rate_target: 0.3,
    min_samples: 10,
    auto_apply_confirmed: true,
    window_cases: 120,
    rule_noise: [],
    recommendations,
    applied: [],
  };
}

const NO_COUNTS: TuningRecommendation = {
  rule_id: 'orphan-rule',
  kind: 'correlation_n',
  before: 2,
  after: 3,
  feed_key: null,
  source_id: null,
  feed_id: null,
  fp_rate: 0.481,
  samples: 20,
  analyst_samples: 20,
  auto_apply: false,
  shadow_blocked: false,
  reason: 'needs_review',
};

const CONFIG = {
  config: {
    enabled: true,
    min_samples: 10,
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

describe('Tuning: honest counts (D6) and the Wilson explanation', () => {
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

  it('a recommendation without recorded counts reads "not recorded", never counts derived from the bound', async () => {
    recsMock.mockResolvedValue(response([NO_COUNTS]));
    renderTuning();
    expect(await screen.findByText('orphan-rule')).toBeInTheDocument();
    // Before the fix: round(0.481 x 20) = 10 false positives, shown as a 50% observed ratio.
    expect(screen.queryByText('50%')).toBeNull();
    expect(screen.getByText('not recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule orphan-rule' }));
    await waitFor(() =>
      expect(screen.getAllByText('Observed false-positive ratio: not recorded. This recommendation did not record its confirmed counts.').length).toBeGreaterThan(0),
    );
  });

  it('a recommendation with recorded counts keeps them', async () => {
    recsMock.mockResolvedValue(response([{ ...NO_COUNTS, confirmed_false_positives: 14, confirmed_true_positives: 6 }]));
    renderTuning();
    expect(await screen.findByText('orphan-rule')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.queryByText('not recorded')).toBeNull();
  });
});

describe('the conservative estimate explanation', () => {
  const RULE: RuleNoise = {
    rule_id: 'r',
    total: 20,
    fp: 14,
    tp: 6,
    fp_rate: 0.481,
    volume_ewma: null,
    over_target: true,
  };

  it('states the Wilson lower bound with the real counts', () => {
    const exp = conservativeEstimateExplanation(RULE, 1.96);
    expect(exp.summary).toBe('48% is the Wilson lower bound of 14 false positives in 20 analyst-confirmed cases at z = 1.96.');
    expect(exp.steps.find((s) => s.label === 'Low')?.result).toBe('0.481');
    expect(exp.caveats.join(' ')).not.toContain('earlier evaluation');
  });

  it('says not recorded for a row without counts', () => {
    const row = { ...RULE, counts_recorded: false } as RuleNoise;
    expect(countsRecorded(row)).toBe(false);
    expect(observedRatioText(row)).toBe('not recorded');
    expect(conservativeEstimateExplanation(row, 1.96).provenance).toBe('not_recorded');
  });
});
