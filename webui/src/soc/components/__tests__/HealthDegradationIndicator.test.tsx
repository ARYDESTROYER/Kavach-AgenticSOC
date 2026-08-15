/** Degradation-only Overview health contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import type { AutoCloseHealth, DiagnosticsHealth } from '@/lib/types';
import { HealthDegradationIndicator } from '../HealthDegradationIndicator';

function autoClose(over: Partial<AutoCloseHealth> = {}): AutoCloseHealth {
  const measured = {
    decided: 20,
    auto_closed: 12,
    routed_to_human: 8,
    analyst_decided: 0,
    rate: 0.6,
    available: true,
    reason: '',
  };
  return {
    window_hours: 24,
    generated_at: '2026-08-13T00:00:00Z',
    current: measured,
    baseline: measured,
    lifetime: measured,
    policy: {
      available: true,
      any_enabled: true,
      false_positive_enabled: true,
      true_positive_enabled: false,
      reason: '',
    },
    status: 'ok',
    reason: '',
    collapsed: false,
    volume_steady: true,
    comparable: true,
    needs_attention: false,
    thresholds: {},
    truncated: false,
    store_total: 20,
    fetched: 20,
    ...over,
  };
}

function health(over: Partial<DiagnosticsHealth> = {}): DiagnosticsHealth {
  return {
    generated_at: '2026-08-13T00:00:00Z',
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
      total_chunks: 12,
      total_documents: 12,
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
        terminal_cases: 20,
        scanned_cases: 20,
        by_outcome: {},
        by_evidence_source: {},
        zero_analyst_confirmed_cases: false,
        truncated: false,
        store_total: 20,
        fetched: 20,
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

describe('HealthDegradationIndicator', () => {
  beforeEach(() => {
    diagnosticsMock.mockReset();
    autoCloseMock.mockReset();
    hasPermissionMock.mockReset().mockReturnValue(true);
    diagnosticsMock.mockResolvedValue(health());
    autoCloseMock.mockResolvedValue(autoClose());
  });

  it('renders absolutely nothing when every readable signal is healthy', async () => {
    const { container } = render(
      <HealthDegradationIndicator windowHours={24} onNavigate={vi.fn()} />,
    );

    await waitFor(() => expect(diagnosticsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/everything|healthy|all clear/i)).toBeNull();
  });

  it.each([
    {
      name: 'starved corpus',
      mutate: (base: DiagnosticsHealth) => ({
        ...base,
        precedent_corpus: { ...base.precedent_corpus, starved: true },
      }),
      expected: /precedent corpus is starved/i,
    },
    {
      name: 'zero analyst-confirmed precedents',
      mutate: (base: DiagnosticsHealth) => ({
        ...base,
        precedent_corpus: {
          ...base.precedent_corpus,
          status: 'ok',
          analyst_confirmed_precedent_documents: 0,
          zero_analyst_confirmed_precedents: true,
          starved: false,
        },
        alerts: [],
        alert_count: 0,
      }),
      expected: /no analyst-confirmed precedents/i,
    },
    {
      name: 'auto-close outside tolerance',
      mutate: (base: DiagnosticsHealth) => base,
      autoClose: autoClose({ status: 'degraded', needs_attention: true }),
      expected: /auto-close rate is outside tolerance/i,
    },
    {
      name: 'failed state-schema migration',
      mutate: (base: DiagnosticsHealth) => ({
        ...base,
        schema_migration: {
          ...base.schema_migration,
          state: 'failed',
          failed: true,
        },
      }),
      expected: /state-schema migration failed/i,
    },
  ])('shows one actionable strip for $name', async ({ mutate, autoClose: ac, expected }) => {
    diagnosticsMock.mockResolvedValue(mutate(health()));
    if (ac) autoCloseMock.mockResolvedValue(ac);
    const navigate = vi.fn();
    render(<HealthDegradationIndicator windowHours={24} onNavigate={navigate} />);

    const strip = await screen.findByTestId('health-degradation-indicator');
    expect(strip).toHaveTextContent(expected);
    expect(screen.getAllByTestId('health-degradation-indicator')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /view effectiveness/i }));
    expect(navigate).toHaveBeenCalledWith('metrics', { tab: 'effectiveness' });
  });

  it('collapses simultaneous degradations into one strip that names every category', async () => {
    const base = health();
    diagnosticsMock.mockResolvedValue({
      ...base,
      precedent_corpus: {
        ...base.precedent_corpus,
        starved: true,
        zero_analyst_confirmed_precedents: true,
      },
      schema_migration: { ...base.schema_migration, state: 'failed', failed: true },
    });
    autoCloseMock.mockResolvedValue(autoClose({ status: 'collapsed', needs_attention: true }));

    render(<HealthDegradationIndicator windowHours={24} onNavigate={vi.fn()} />);
    const strip = await screen.findByTestId('health-degradation-indicator');

    expect(screen.getAllByTestId('health-degradation-indicator')).toHaveLength(1);
    expect(strip).toHaveTextContent(/no analyst-confirmed precedents/i);
    expect(strip).toHaveTextContent(/state-schema migration failed/i);
    expect(strip).toHaveTextContent(/auto-close rate collapsed/i);
  });
});
