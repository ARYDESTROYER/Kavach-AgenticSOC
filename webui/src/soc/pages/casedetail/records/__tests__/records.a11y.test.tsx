/**
 * The closing accessibility sweep (A11Y): the case usage popover's call list scrolls past
 * half the window, so while it scrolls it must be a named region that takes focus (axe
 * scrollable-region-focusable, found on the seeded Demo at 1440 and 390 in both themes).
 * A short list adds no tab stop.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { CaseUsagePage, CaseUsageRow } from '@/lib/types';
import { CaseUsageButton } from '../CaseUsageButton';

const usageRow = (over: Partial<CaseUsageRow> = {}): CaseUsageRow => ({
  ts: '2026-11-20T10:00:05Z',
  surface: 'pipeline',
  case_id: 'case-1',
  role: 'investigator',
  model: 'gpt-test',
  prompt_tokens: 2000,
  completion_tokens: 300,
  total_tokens: 2300,
  cost: 0.0055,
  currency: 'USD',
  latency_ms: 1840,
  outcome: 'ok',
  pricing_source: 'exact',
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  batch: false,
  processing_tier: 'standard',
  failure_class: '',
  attempts: 1,
  usage_estimated: false,
  input_rate_per_million: 1.25,
  output_rate_per_million: 10,
  cache_read_rate_per_million: 0.125,
  cache_write_rate_per_million: 1.5625,
  cache_write_ttl: '5m',
  price_basis: 'catalog',
  ...over,
});

const usagePage = (rows: CaseUsageRow[]): CaseUsagePage => ({
  case_id: 'case-1',
  rows,
  returned: rows.length,
  rows_total: rows.length,
  truncated: false,
  totals: { pipeline: 0.0055 * rows.length, chat: 0, other: 0 },
  token_cost: 0.0055 * rows.length,
  reconciles: true,
});

/** jsdom lays nothing out: give every element the given scroll and client heights. */
function stubHeights(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

async function openUsage(rows: CaseUsageRow[]) {
  render(<CaseUsageButton caseId="case-1" totalCost={0.0055 * rows.length} load={vi.fn(async () => usagePage(rows))} />);
  fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
  const dialog = await screen.findByRole('dialog', { name: 'AI usage on this case' });
  await within(dialog).findAllByTestId('case-usage-row');
  return dialog;
}

describe('the case usage call list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a named region a keyboard can focus while it scrolls', async () => {
    stubHeights(900, 400);
    const dialog = await openUsage(Array.from({ length: 12 }, (_, i) => usageRow({ ts: `2026-11-20T10:00:${10 + i}Z` })));
    const region = within(dialog).getByRole('region', { name: 'AI calls' });
    expect(region).toHaveAttribute('tabindex', '0');
    // The calls stay a list inside the region.
    expect(within(region).getByRole('list')).toBeInTheDocument();
    expect(within(region).getAllByRole('listitem')).toHaveLength(12);
  });

  it('adds no tab stop and no region while every call fits', async () => {
    stubHeights(200, 200);
    const dialog = await openUsage([usageRow()]);
    expect(within(dialog).queryByRole('region')).toBeNull();
    expect(within(dialog).getByTestId('case-usage-list')).not.toHaveAttribute('tabindex');
  });
});
