/**
 * `healthDegradations()` — the ONE degradation reducer, tested directly.
 *
 * This coverage used to live in a spec for a dashboard-only warning strip that no longer
 * exists as a component: Agent health moved into the notification
 * bell, and the reducer's single reader is now the shell. Proving the reducer here (rather
 * than through whichever surface happens to host it) keeps the four load-bearing categories
 * and the collapse behaviour pinned without re-testing a component's markup.
 *
 * The bell's rendering of the result is pinned by `NotificationBell.health.test.tsx`; the
 * shell's ownership of the hook is pinned by `soc/__tests__/appshell.health.test.tsx`.
 */
import { describe, expect, it } from 'vitest';

import type { DiagnosticsHealth } from '@/lib/types';
import { healthDegradations } from '../health-diagnostics-state';
import { autoClose, health } from './health-fixtures';

describe('healthDegradations', () => {
  it('reports nothing when every readable signal is healthy', () => {
    expect(healthDegradations(health(), autoClose())).toEqual([]);
  });

  it('reports nothing when neither signal could be read at all', () => {
    // Unknown is NOT degraded: an unreadable endpoint must never become a fabricated
    // incident, because the badge it feeds is a safety state.
    expect(healthDegradations(null, null)).toEqual([]);
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
      ac: autoClose({ status: 'degraded', needs_attention: true }),
      expected: /auto-close rate is outside tolerance/i,
    },
    {
      name: 'failed state-schema migration',
      mutate: (base: DiagnosticsHealth) => ({
        ...base,
        schema_migration: { ...base.schema_migration, state: 'failed', failed: true },
      }),
      expected: /state-schema migration failed/i,
    },
  ])('surfaces exactly one signal for $name', ({ mutate, ac, expected }) => {
    const found = healthDegradations(mutate(health()), ac ?? autoClose());
    expect(found).toHaveLength(1);
    expect(found[0].label).toMatch(expected);
  });

  it('collapses simultaneous degradations into one list that names every category', () => {
    const base = health();
    const found = healthDegradations(
      {
        ...base,
        precedent_corpus: {
          ...base.precedent_corpus,
          starved: true,
          zero_analyst_confirmed_precedents: true,
        },
        schema_migration: { ...base.schema_migration, state: 'failed', failed: true },
      },
      autoClose({ status: 'collapsed', needs_attention: true }),
    );

    const labels = found.map((signal) => signal.label);
    expect(labels).toContain('No analyst-confirmed precedents');
    expect(labels).toContain('State-schema migration failed');
    expect(labels).toContain('Auto-close rate collapsed');
    // Critical before warning, then alphabetical — a stable order so the announcer's
    // change-detection key does not churn on identical evidence.
    expect(found.every((signal) => signal.severity === 'critical')).toBe(true);
  });
});
