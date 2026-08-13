/**
 * HealthDiagnostics — the honesty contract of the dashboard health surface.
 *
 * The defect this component exists for was SILENT: the precedent corpus collapsed,
 * auto-close stopped forever, and nothing in the product said so. The rendering rules
 * are therefore load-bearing, and this file pins them:
 *
 *   1. an auto-close COLLAPSE is rendered as a detected problem, with the backend's
 *      own reason text;
 *   2. `unknowns` render under "not yet measured" and are explicitly NOT problems —
 *      and an empty `alerts` list next to a non-empty `unknowns` list is explicitly
 *      NOT a clean bill of health;
 *   3. `no_volume` / `insufficient_evidence` render as exactly that, never as `0%`;
 *   4. a starved precedent corpus and a failed schema migration (with its remediation
 *      SQL) surface;
 *   5. both signals are RBAC-gated on their own grant, and the panel self-hides when
 *      neither endpoint answered.
 *
 * Fully offline: the api client and the auth context are both mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { diagnosticsMock, autoCloseMock, hasPermissionMock } = vi.hoisted(() => ({
  diagnosticsMock: vi.fn(),
  autoCloseMock: vi.fn(),
  hasPermissionMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { diagnosticsHealth: diagnosticsMock, autoCloseHealth: autoCloseMock },
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

import type { AutoCloseHealth, AutoCloseWindow, DiagnosticsHealth } from '@/lib/types';
import {
  HealthDiagnostics,
  PARTIAL_SCOPE_SUMMARY,
  autoCloseRateText,
  autoCloseStatusView,
  healthSummaryText,
  precedentCountText,
} from '../HealthDiagnostics';

function window_(over: Partial<AutoCloseWindow> = {}): AutoCloseWindow {
  return {
    decided: 40,
    auto_closed: 0,
    routed_to_human: 40,
    analyst_decided: 0,
    rate: 0,
    available: true,
    reason: '',
    ...over,
  };
}

function autoClose(over: Partial<AutoCloseHealth> = {}): AutoCloseHealth {
  return {
    window_hours: 24,
    generated_at: '2026-08-06T00:00:00Z',
    current: window_({ rate: 0 }),
    baseline: window_({ auto_closed: 26, rate: 0.65 }),
    lifetime: window_({ auto_closed: 26, rate: 0.32 }),
    policy: {
      available: true,
      any_enabled: true,
      false_positive_enabled: true,
      true_positive_enabled: false,
      reason: '',
    },
    status: 'collapsed',
    reason:
      'the auto-close rate fell from 0.65 to 0.0 while decided volume held steady (40 -> 40 cases)',
    collapsed: true,
    volume_steady: true,
    comparable: true,
    needs_attention: true,
    thresholds: { min_decided: 5 },
    truncated: false,
    store_total: 40,
    fetched: 40,
    ...over,
  };
}

function health(over: Partial<DiagnosticsHealth> = {}): DiagnosticsHealth {
  return {
    generated_at: '2026-08-06T00:00:00Z',
    window_hours: 24,
    demo_active: false,
    state_backend: 'postgres',
    precedent_corpus: {
      available: true,
      known: true,
      reason: '',
      status: 'ok',
      status_reason: '',
      rag_enabled: true,
      precedent_source: 'resolved_case',
      precedent_source_enabled: true,
      unconfirmed_tier_enabled: false,
      precedent_documents: 12,
      precedent_chunks: 12,
      analyst_confirmed_precedent_documents: 12,
      analyst_confirmed_count_exact: true,
      zero_analyst_confirmed_precedents: false,
      starved: false,
      total_chunks: 220,
      total_documents: 40,
      chunks_by_source: { resolved_case: 12 },
      documents_by_source: { resolved_case: 12 },
      projection: {
        available: true,
        state: 'recorded',
        scope: 'in_process',
        reason: '',
        sources: {},
        shrank_sources: [],
        collapsed_sources: [],
      },
      ground_truth: {
        analyst_confirmed_cases: 12,
        terminal_cases: 30,
        scanned_cases: 40,
        by_outcome: {},
        by_evidence_source: {},
        zero_analyst_confirmed_cases: false,
        truncated: false,
        store_total: 40,
        fetched: 40,
      },
    },
    schema_migration: {
      available: true,
      state: 'ok',
      state_backend: 'postgres',
      detail: '',
      remediation: '',
      failed: false,
      reason: '',
    },
    auto_close: autoClose(),
    alerts: [],
    unknowns: [],
    alert_count: 0,
    unknown_count: 0,
    ...over,
  };
}

describe('HealthDiagnostics pure rendering rules', () => {
  it('never presents an unmeasured window as 0%', () => {
    expect(
      autoCloseRateText(
        window_({ decided: 0, rate: '—', available: false, reason: 'no case reached a verdict' }),
      ),
    ).toBe('Not measured');
    expect(autoCloseRateText(window_({ rate: 0.42 }))).toBe('42%');
  });

  it('classifies no_volume / insufficient_evidence as unmeasured, not healthy or broken', () => {
    for (const status of ['no_volume', 'insufficient_evidence']) {
      const view = autoCloseStatusView(status);
      expect(view.unmeasured).toBe(true);
      expect(view.problem).toBe(false);
      expect(view.label).toMatch(/Not measured/);
    }
    expect(autoCloseStatusView('collapsed').problem).toBe(true);
    expect(autoCloseStatusView('ok').problem).toBe(false);
    expect(autoCloseStatusView('ok').unmeasured).toBe(false);
    // An unrecognised/absent status must degrade to "unmeasured", never to "ok".
    expect(autoCloseStatusView(undefined).unmeasured).toBe(true);
  });

  it('refuses to call an empty alerts list a clean bill of health when unknowns remain', () => {
    expect(healthSummaryText(0, 2)).toMatch(/not a clean bill of health/);
    expect(healthSummaryText(0, 0)).toMatch(/no problems detected/i);
    expect(healthSummaryText(0, 0)).not.toMatch(/not a clean bill/);
    expect(healthSummaryText(3, 0)).toMatch(/3 problems detected/);
    expect(healthSummaryText(1, 1)).toMatch(/could not be measured/);
  });

  it('marks a bounded precedent count as a lower bound and an unreadable one as unknown', () => {
    const base = health().precedent_corpus;
    expect(precedentCountText(base)).toBe('12');
    expect(precedentCountText({ ...base, analyst_confirmed_count_exact: false })).toBe('≥ 12');
    expect(precedentCountText({ ...base, available: false })).toBe('Unknown');
  });
});

describe('HealthDiagnostics surface', () => {
  beforeEach(() => {
    diagnosticsMock.mockReset();
    autoCloseMock.mockReset();
    hasPermissionMock.mockReset();
    hasPermissionMock.mockReturnValue(true);
  });

  it('renders an auto-close collapse as a detected problem with the backend reason', async () => {
    const collapse = autoClose();
    diagnosticsMock.mockResolvedValue(
      health({
        auto_close: collapse,
        alerts: [
          {
            id: 'auto_close_collapsed',
            severity: 'critical',
            title: 'Auto-close rate collapsed',
            detail: collapse.reason,
            remediation: 'Check the precedent corpus, the investigation path, and the policy.',
          },
        ],
        alert_count: 1,
      }),
    );
    autoCloseMock.mockResolvedValue(collapse);

    render(<HealthDiagnostics />);

    expect(await screen.findByText('Auto-close rate collapsed')).toBeInTheDocument();
    expect(screen.getByText('Collapsed')).toBeInTheDocument();
    // The tile detail AND the alert row both carry the backend's reason text verbatim.
    expect(screen.getAllByText(/decided volume held steady/).length).toBeGreaterThan(0);
    expect(screen.getByText('Detected problems (1)')).toBeInTheDocument();
    expect(screen.getByText(/1 problem detected\./)).toBeInTheDocument();
  });

  it('requests the selected Analytics window and renders the API response echo', async () => {
    const selected = autoClose({
      window_hours: 168,
      status: 'ok',
      reason: '',
      collapsed: false,
      needs_attention: false,
      current: window_({
        decided: 1696,
        auto_closed: 1355,
        routed_to_human: 341,
        rate: 0.8,
      }),
    });
    diagnosticsMock.mockResolvedValue(
      health({ window_hours: 168, auto_close: selected }),
    );
    autoCloseMock.mockResolvedValue(selected);

    render(<HealthDiagnostics windowHours={168} />);

    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(
      screen.getByText(/1,355 of 1,696 decided cases auto-closed in the last 168h\./),
    ).toBeInTheDocument();
    expect(diagnosticsMock).toHaveBeenCalledWith(168, expect.any(AbortSignal));
    expect(autoCloseMock).toHaveBeenCalledWith(168, expect.any(AbortSignal));
  });

  it('renders unknowns as "not yet measured" and never as a clean bill of health', async () => {
    const quiet = autoClose({
      status: 'no_volume',
      reason: 'no case reached a verdict in the last 24h',
      collapsed: false,
      needs_attention: false,
      comparable: false,
      current: window_({ decided: 0, auto_closed: 0, routed_to_human: 0, rate: '—', available: false, reason: 'no case reached a verdict in the current window' }),
    });
    diagnosticsMock.mockResolvedValue(
      health({
        auto_close: quiet,
        alerts: [],
        alert_count: 0,
        unknowns: [
          {
            id: 'auto_close_no_volume',
            severity: 'unknown',
            title: 'Auto-close health could not be measured',
            detail: 'no case reached a verdict in the last 24h',
            remediation: '',
          },
        ],
        unknown_count: 1,
      }),
    );
    autoCloseMock.mockResolvedValue(quiet);

    render(<HealthDiagnostics />);

    expect(await screen.findByText('Not yet measured (1)')).toBeInTheDocument();
    expect(
      screen.getByText(/They are not problems, and they are not evidence that anything is healthy/),
    ).toBeInTheDocument();
    expect(screen.getByText(/this is not a clean bill of health/)).toBeInTheDocument();
    // The load-bearing anti-regression: an unmeasured window must not read as 0%.
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText(/Detected problems/)).toBeNull();
  });

  it('surfaces a starved precedent corpus and a failed migration with its remediation SQL', async () => {
    const base = health();
    diagnosticsMock.mockResolvedValue(
      health({
        precedent_corpus: {
          ...base.precedent_corpus,
          status: 'starved',
          status_reason:
            'the precedent source is enabled but the corpus holds 0 analyst-confirmed precedents',
          precedent_documents: 0,
          analyst_confirmed_precedent_documents: 0,
          zero_analyst_confirmed_precedents: true,
          starved: true,
        },
        schema_migration: {
          available: true,
          state: 'failed',
          state_backend: 'postgres',
          detail: 'audit.id is still a 32-bit integer',
          remediation: 'ALTER TABLE audit ALTER COLUMN id TYPE bigint;',
          failed: true,
          reason: '',
        },
        alerts: [
          {
            id: 'precedent_corpus_starved',
            severity: 'critical',
            title: '0 analyst-confirmed precedents available',
            detail: 'auto-close comparisons have no institutional memory to work from',
            remediation: 'Confirm case outcomes so precedent can be projected.',
          },
        ],
        alert_count: 1,
      }),
    );
    autoCloseMock.mockResolvedValue(base.auto_close);

    render(<HealthDiagnostics />);

    expect(await screen.findByText('0 analyst-confirmed precedents available')).toBeInTheDocument();
    expect(screen.getByText('Starved')).toBeInTheDocument();
    expect(screen.getByText('Strict audit writes broken')).toBeInTheDocument();
    expect(screen.getByText('ALTER TABLE audit ALTER COLUMN id TYPE bigint;')).toBeInTheDocument();
  });

  it('uses the shared direct-field reducer when a trimmed payload omits alert rows', async () => {
    const base = health();
    diagnosticsMock.mockResolvedValue(
      health({
        precedent_corpus: {
          ...base.precedent_corpus,
          // Trimmed/older payload: the explicit zero flag is present, while the
          // pre-reduced status + alerts list were omitted/stale. Overview exercises
          // this exact direct-field-only shape in HealthDegradationIndicator.test.
          status: 'ok',
          status_reason: '',
          analyst_confirmed_precedent_documents: 0,
          zero_analyst_confirmed_precedents: true,
          starved: false,
        },
        alerts: [],
        alert_count: 0,
      }),
    );
    autoCloseMock.mockResolvedValue(autoClose({ status: 'ok', needs_attention: false }));

    render(<HealthDiagnostics />);

    const panel = await screen.findByTestId('health-diagnostics');
    expect(panel).toHaveAttribute('data-health-state', 'degraded');
    expect(screen.getByText(/1 problem detected/)).toBeInTheDocument();
    expect(screen.getByText('No analyst-confirmed precedents')).toBeInTheDocument();
    expect(screen.getByText('Detected problems (1)')).toBeInTheDocument();
  });

  it('does not call a deliberately disabled zero-count corpus degraded', async () => {
    const base = health();
    diagnosticsMock.mockResolvedValue(
      health({
        precedent_corpus: {
          ...base.precedent_corpus,
          status: 'disabled',
          status_reason: 'the precedent source is turned off',
          precedent_source_enabled: false,
          analyst_confirmed_precedent_documents: 0,
          zero_analyst_confirmed_precedents: true,
          starved: false,
        },
        alerts: [],
        alert_count: 0,
      }),
    );
    autoCloseMock.mockResolvedValue(autoClose({ status: 'ok', needs_attention: false }));

    render(<HealthDiagnostics />);

    const panel = await screen.findByTestId('health-diagnostics');
    expect(panel).toHaveAttribute('data-health-state', 'healthy');
    expect(screen.getByText(/no problems detected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Detected problems/)).toBeNull();
  });

  it('gates each signal on its own grant and self-hides when neither is held', async () => {
    diagnosticsMock.mockResolvedValue(health());
    autoCloseMock.mockResolvedValue(autoClose());

    // Only `metrics:view`: the auto-close signal is fetched, the roll-up is not — and
    // the summary must NOT read "no problems detected" off a question it never asked.
    hasPermissionMock.mockImplementation((r: string, a: string) => r === 'metrics' && a === 'view');
    const onlyMetrics = render(<HealthDiagnostics />);
    await waitFor(() => expect(autoCloseMock).toHaveBeenCalled());
    expect(diagnosticsMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Collapsed')).toBeInTheDocument();
    expect(screen.getByText(PARTIAL_SCOPE_SUMMARY)).toBeInTheDocument();
    expect(screen.queryByText(/no problems detected/i)).toBeNull();
    onlyMetrics.unmount();

    // Neither grant: nothing is fetched and nothing renders (a blank panel would
    // itself read as a false "all clear").
    diagnosticsMock.mockClear();
    autoCloseMock.mockClear();
    hasPermissionMock.mockReturnValue(false);
    const { container } = render(<HealthDiagnostics />);
    await waitFor(() => expect(container.querySelector('[data-testid="health-diagnostics"]')).toBeNull());
    expect(diagnosticsMock).not.toHaveBeenCalled();
    expect(autoCloseMock).not.toHaveBeenCalled();
  });

  it('renders nothing when both endpoints fail rather than implying health', async () => {
    diagnosticsMock.mockRejectedValue(new Error('boom'));
    autoCloseMock.mockRejectedValue(new Error('boom'));

    const { container } = render(<HealthDiagnostics />);

    await waitFor(() => expect(autoCloseMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="health-diagnostics"]')).toBeNull();
  });
});
