/**
 * Cost explained (Round 16 SPEC §4.5 WP11; research explainability R13 and D-API-5).
 *
 * Each ledger row's cost is
 * `round((prompt x in + completion x out + cache_read x read + cache_write x write) / 1e6
 * x (0.5 if batch else 1), 8)`, the gateway's `cost_for` formula, over the per-million
 * rates the row recorded. A row from before the rates were recorded shows its stored cost
 * and says the rates were not recorded. Pure: plain data only; a model name is a text
 * value (#9).
 */
import type { CaseUsageRow } from '@/lib/types';
import { fmtMoney } from '@/lib/format';

import { count, trimmed } from './rounding';
import type { Explanation, ExplanationStep } from './types';

const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The recompute of one row's cost from its recorded rates, or null when they are absent. */
export function recomputeCost(row: CaseUsageRow): number | null {
  const input = rate(row.input_rate_per_million);
  const output = rate(row.output_rate_per_million);
  if (input === null || output === null) return null;
  const read = rate(row.cache_read_rate_per_million) ?? 0;
  const write = rate(row.cache_write_rate_per_million) ?? 0;
  const raw =
    ((row.prompt_tokens || 0) * input +
      (row.completion_tokens || 0) * output +
      (row.cache_read_tokens || 0) * read +
      (row.cache_write_tokens || 0) * write) /
    1e6;
  return Math.round(raw * (row.batch ? 0.5 : 1) * 1e8) / 1e8;
}

function money(value: number, currency?: string): string {
  return fmtMoney(value, currency);
}

/** One row's formula line, with its own numbers. */
export function costStep(row: CaseUsageRow): ExplanationStep {
  const label = `${row.model || 'Model'}${row.role ? `, ${row.role}` : ''}`;
  const input = rate(row.input_rate_per_million);
  const output = rate(row.output_rate_per_million);
  if (input === null || output === null) {
    return { label, expression: 'Rates not recorded for this call', result: money(row.cost, row.currency) };
  }
  const terms = [
    `${count(row.prompt_tokens || 0)} x $${trimmed(input, 4)}`,
    `${count(row.completion_tokens || 0)} x $${trimmed(output, 4)}`,
  ];
  if (row.cache_read_tokens) terms.push(`${count(row.cache_read_tokens)} x $${trimmed(rate(row.cache_read_rate_per_million) ?? 0, 4)}`);
  if (row.cache_write_tokens) terms.push(`${count(row.cache_write_tokens)} x $${trimmed(rate(row.cache_write_rate_per_million) ?? 0, 4)}`);
  const expression = `(${terms.join(' + ')}) / 1,000,000${row.batch ? ' x 0.5 (Batch)' : ''}`;
  return { label, expression, result: money(recomputeCost(row) ?? row.cost, row.currency) };
}

/** The cost of a case's AI calls, one formula line per ledger row. */
export function explainCost(rows: readonly CaseUsageRow[]): Explanation | null {
  if (!rows || !rows.length) return null;
  const currency = rows.find((r) => r.currency)?.currency;
  const total = rows.reduce((sum, r) => sum + (Number.isFinite(r.cost) ? r.cost : 0), 0);
  const estimated = rows.filter((r) => r.usage_estimated).length;
  const inexact = rows.filter((r) => r.pricing_source && r.pricing_source !== 'exact').length;
  const unrated = rows.filter((r) => recomputeCost(r) === null).length;
  const caveats: string[] = [];
  if (estimated) caveats.push(`${count(estimated)} of ${count(rows.length)} calls have estimated token counts.`);
  if (inexact) caveats.push(`${count(inexact)} of ${count(rows.length)} calls were priced without an exact catalog price.`);
  if (unrated) caveats.push(`${count(unrated)} of ${count(rows.length)} calls were recorded before their rates were stored.`);
  return {
    metric: 'cost',
    title: 'AI cost',
    value: total,
    display: money(total, currency),
    summary: `${money(total, currency)} over ${count(rows.length)} ${rows.length === 1 ? 'call' : 'calls'}, each priced from its own token counts and rates.`,
    formula: '(prompt x input rate + completion x output rate + cache read x read rate + cache write x write rate) / 1,000,000, x 0.5 for Batch',
    inputs: [{ key: 'calls', label: 'Calls', value: count(rows.length), source: 'Usage ledger' }],
    steps: [...rows.map(costStep), { label: 'Total', expression: 'Sum of the calls', result: money(total, currency) }],
    rounding: 'Each call is rounded to 8 decimals; amounts are shown to 4 decimals under $1.',
    provenance: unrated ? 'not_recorded' : 'recorded',
    caveats,
  };
}
