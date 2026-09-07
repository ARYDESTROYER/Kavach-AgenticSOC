/**
 * Shared Agent-health fixtures.
 *
 * Not a spec file (no `.test.` in the name), so Vitest does not collect it — it exists so
 * the reducer spec, the bell spec and the shell spec all describe the SAME healthy
 * baseline. A divergent baseline is how a degradation test quietly stops proving anything.
 */
import type { AutoCloseHealth, DiagnosticsHealth } from '@/lib/types';

export function autoClose(over: Partial<AutoCloseHealth> = {}): AutoCloseHealth {
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

export function health(over: Partial<DiagnosticsHealth> = {}): DiagnosticsHealth {
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
