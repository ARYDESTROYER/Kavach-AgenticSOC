/**
 * The noise lineage row's cluster summary is the case's stored trigger sentence
 * (`clustering.correlation.reason`, written by correlation). It reads the way the case page
 * reads it (FXA1 review, acceptance gap trigger-severity-range-same-value): a severity
 * range with equal ends is one value, a real range and any other text stay as stored, and
 * it is plain text (#9).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { NoiseLineage } from '@/lib/types';
import { NoiseLineageView } from '../NoiseLineage';

const LEAD = "'LP QRadar: impossible travel authentication' event from user vpatel (rule configured to investigate every occurrence)";

function lineage(reason: string): NoiseLineage {
  return {
    window_hours: 24,
    generated_at: '2026-11-26T10:00:00Z',
    rows: [
      {
        case_id: 'case-1',
        display_id: 'CASE-000043',
        created_at: '2026-11-26T09:59:00Z',
        severity: 'critical',
        clustering: {
          available: true,
          cluster_id: '4cb33a5bf9d8d6880f',
          input_count: 6,
          input_refs: ['alert-a15bb2b03f10'],
          source_count: 1,
          source_breakdown: { qradar: 6 },
          correlation: {
            mode: 'every',
            threshold: 1,
            observed_count: 6,
            window_seconds: 300,
            group_by: 'user',
            matched_rule: 'LP QRadar: impossible travel authentication',
            reason,
          },
        },
        outcome: {
          key: 'awaiting_analyst',
          label: 'Awaiting analyst',
          funnel_stage: 'escalated',
          terminal: false,
          status: 'investigating',
          verdict: 'NEEDS_HUMAN',
          disposition: 'undetermined',
          decision_by: 'system',
        },
      },
    ],
    meta: {
      returned: 1,
      window_cases_in_fetched_page: 1,
      fetched_cases: 1,
      store_total: 1,
      limit: 12,
      truncated: false,
      store_truncated: false,
    },
    limitations: 'Rows are a bounded newest-case sample.',
  } as unknown as NoiseLineage;
}

describe('NoiseLineageView: the stored trigger sentence (FXA1 review)', () => {
  it('reads a severity range with equal ends as one value', () => {
    render(<NoiseLineageView data={lineage(`${LEAD}; severity 75\u201375`)} loading={false} error={null} onRetry={vi.fn()} />);
    const row = screen.getByTestId('noise-lineage-row');
    expect(row).toHaveTextContent(`${LEAD}; severity 75`);
    expect(row).not.toHaveTextContent('75\u201375');
  });

  it('keeps a real range as stored', () => {
    render(<NoiseLineageView data={lineage(`${LEAD}; severity 30\u201375`)} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId('noise-lineage-row')).toHaveTextContent(`${LEAD}; severity 30\u201375`);
  });
});
