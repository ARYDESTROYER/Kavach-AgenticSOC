/**
 * Round 16 acceptance fixes (FXA2): the usage sheet says what each call was for, where
 * its price came from and which build wrote it.
 *
 * * Runbook AI help (the chat role on the `runbook` surface) reads "Runbook AI help",
 *   never "Case chat", and has its own footer line (`totals.runbook`, additive).
 * * A catalog price the table matched by family, or not at all, says so
 *   (`pricing_source` heuristic or default), never "Catalog price".
 * * Each call names the build that wrote it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { CaseUsagePage, CaseUsageRow } from '@/lib/types';
import { CaseUsageButton, roleWords } from '../CaseUsageButton';
import { priceBasisWords, usageBuildText } from '../usageFormula';

const usageRow = (over: Partial<CaseUsageRow> = {}): CaseUsageRow => ({
  app_version: '0.2.0',
  build_sha: '934331273dc0c0630c00f3dff6b6b20deb622cc7',
  ts: '2026-11-20T10:00:05Z',
  surface: 'automated_scan',
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

const page = (rows: CaseUsageRow[], totals: CaseUsagePage['totals']): CaseUsagePage => ({
  case_id: 'case-1',
  rows,
  returned: rows.length,
  rows_total: rows.length,
  truncated: false,
  totals,
  token_cost: totals.pipeline,
  reconciles: true,
});

async function openSheet(load: () => Promise<CaseUsagePage>, total = 0) {
  render(<CaseUsageButton caseId="case-1" totalCost={total} load={load} />);
  fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
  return screen.findByRole('dialog', { name: 'AI usage on this case' });
}

describe('runbook AI help in the usage sheet', () => {
  it('names a runbook call by what it was for, never case chat', () => {
    expect(roleWords({ role: 'chat', surface: 'runbook' })).toBe('Runbook AI help');
    expect(roleWords({ role: 'chat', surface: 'chat' })).toBe('Case chat');
    expect(roleWords({ role: 'investigator', surface: 'automated_scan' })).toBe('Investigator');
  });

  it('lists the call as runbook AI help and totals it on its own line', async () => {
    const draft = usageRow({ role: 'chat', surface: 'runbook', model: 'gpt-5.6-luna', cost: 0.003447 });
    const dialog = await openSheet(async () => page([draft], { pipeline: 0, chat: 0, runbook: 0.003447, other: 0 }));
    const [row] = await within(dialog).findAllByTestId('case-usage-row');
    expect(within(row).getByText('Runbook AI help')).toBeInTheDocument();
    expect(within(row).queryByText('Case chat')).toBeNull();
    expect(within(dialog).getByTestId('case-usage-runbook')).toHaveTextContent(
      'Runbook AI help on this case: $0.0034. Not part of the investigation cost.',
    );
    expect(within(dialog).getByTestId('case-usage-chat')).toHaveTextContent('Case chat on this case: $0.0000.');
  });

  it('shows no runbook line when there was none, or from a server that sends no runbook total', async () => {
    const dialog = await openSheet(async () => page([usageRow()], { pipeline: 0.0055, chat: 0, other: 0 }), 0.0055);
    await within(dialog).findAllByTestId('case-usage-row');
    expect(within(dialog).queryByTestId('case-usage-runbook')).toBeNull();
  });
});

describe('where a price came from', () => {
  it('says when a catalog price was estimated or a default', () => {
    expect(priceBasisWords('catalog', 'exact')).toBe('Catalog price');
    expect(priceBasisWords('catalog')).toBe('Catalog price');
    expect(priceBasisWords('catalog', 'heuristic')).toBe('Estimated from the model family price.');
    expect(priceBasisWords('catalog', 'default')).toBe('Default price. This model is not in the price table.');
    expect(priceBasisWords('demo_simulated', 'zero')).toBe('Simulated Demo price');
    expect(priceBasisWords('overlay', 'default')).toBe('Price override set by an administrator');
  });

  it('prints the estimate on the row, not "Catalog price"', async () => {
    const guessed = usageRow({ model: 'gpt-7-ultra', pricing_source: 'default', input_rate_per_million: 1, output_rate_per_million: 3 });
    const dialog = await openSheet(async () => page([guessed], { pipeline: 0.0029, chat: 0, other: 0 }), 0.0029);
    const [row] = await within(dialog).findAllByTestId('case-usage-row');
    expect(within(row).getByText('Default price. This model is not in the price table.')).toBeInTheDocument();
    expect(within(row).queryByText('Catalog price')).toBeNull();
  });
});

describe('the build that wrote each call', () => {
  it('words the build, and says what was not recorded', () => {
    expect(usageBuildText(usageRow())).toBe('Build v0.2.0 · 934331273dc0');
    expect(usageBuildText(usageRow({ app_version: null, build_sha: null }))).toBeNull();
    expect(usageBuildText(usageRow({ build_sha: 'unknown' }))).toBe('Build v0.2.0 · unknown');
    expect(usageBuildText(usageRow({ app_version: '', build_sha: 'abc' }))).toBe('Build version not recorded · abc');
  });

  it('prints it on the row', async () => {
    const dialog = await openSheet(async () => page([usageRow()], { pipeline: 0.0055, chat: 0, other: 0 }), 0.0055);
    const [row] = await within(dialog).findAllByTestId('case-usage-row');
    expect(within(row).getByTestId('case-usage-build')).toHaveTextContent('Build v0.2.0 · 934331273dc0');
  });
});
