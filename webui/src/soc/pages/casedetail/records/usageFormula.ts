/**
 * The cost formula of one ledger row, in that row's own numbers (Round 16 SPEC §4.5
 * WP13 "Rate fields", WP14).
 *
 * Each row's cost is `round((prompt x input + completion x output + cache_read x read +
 * cache_write x write) / 1e6 x (0.5 if batch else 1), 8)`, the gateway's `cost_for`
 * formula, over the undiscounted per-million rates the row recorded. A row written before
 * the rates were stored shows its stored cost and says so.
 *
 * The recompute and the formula's terms are the Explain kit's (`lib/explain/cost.ts`
 * `recomputeCost` and `costStep`), so the usage popover and a cost explanation print the
 * same arithmetic. This module adds what the popover needs on top: the amount to the
 * ledger's 8 decimals (`exactMoney`) and the discount tier by name (Batch or Flex). Pure.
 */
import type { CaseUsageRow } from '@/lib/types';
import { fmtMoney } from '@/lib/format';
import { costStep, recomputeCost } from '@/lib/explain/cost';

export { recomputeCost };

const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Whether the row recorded the rates its cost was computed from. */
export function hasRates(row: CaseUsageRow): boolean {
  return rate(row.input_rate_per_million) !== null && rate(row.output_rate_per_million) !== null;
}

/** A count with thousands separators: 1240 is "1,240". */
export function tokens(value: number | null | undefined): string {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

/**
 * An amount to the precision the ledger keeps (8 decimals, at least 2, or 4 under $1),
 * so a formula never ends in "$0.0000" for a call that cost something: 0.00465 is
 * "$0.00465", 0.000015 is "$0.000015", 1.5 is "$1.50". The symbol is the one
 * `fmtMoney` uses for the currency.
 */
export function exactMoney(value: number, currency?: string): string {
  const symbol = fmtMoney(0, currency).replace(/[\d.,]+$/, '');
  const minimumFractionDigits = Math.abs(value) >= 1 ? 2 : 4;
  return `${value < 0 ? '-' : ''}${symbol}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits,
    maximumFractionDigits: 8,
  })}`;
}

/**
 * The discounted tier a row's half price came from. The ledger's `batch` flag is set for
 * a provider Batch call and for a Flex call alike (`llm/providers.py` sets it for Flex),
 * and `processing_tier` tells them apart: "Flex" for `flex`, else "Batch". Null for a
 * row billed at the full price.
 */
export function discountTier(row: Pick<CaseUsageRow, 'batch' | 'processing_tier'>): 'Batch' | 'Flex' | null {
  const tier = String(row.processing_tier || '').toLowerCase();
  if (tier === 'flex') return row.batch ? 'Flex' : null;
  return row.batch ? 'Batch' : null;
}

/**
 * The formula line with the row's own numbers: the Explain kit's expression for the row,
 * for example `(1,240 x $1.25 + 310 x $10) / 1,000,000 = $0.00465`. A cache term shows
 * only when the row used the cache; a half-price row ends with `x 0.5 (Batch)` or
 * `x 0.5 (Flex)`. The result is the recompute to the ledger's 8 decimals. Null when the
 * row recorded no rates.
 */
export function costFormula(row: CaseUsageRow): string | null {
  if (!hasRates(row)) return null;
  const { expression } = costStep(row);
  // The kit names any half-price row Batch; the ledger tells a Flex call apart.
  const half = discountTier(row);
  const base = expression.replace(/ x 0\.5 \(Batch\)$/, '');
  const total = recomputeCost(row) ?? row.cost;
  return `${base}${half ? ` x 0.5 (${half})` : ''} = ${exactMoney(total, row.currency)}`;
}

/** Where a row's rates came from, in words. */
export const PRICE_BASIS_WORDS: Record<string, string> = {
  catalog: 'Catalog price',
  overlay: 'Price override set by an administrator',
  custom: 'Self-hosted model, no charge',
  mock: 'Mock model, no charge',
  demo_simulated: 'Simulated Demo price',
};

export function priceBasisWords(basis: unknown): string {
  if (typeof basis !== 'string' || !basis) return 'Price source not recorded';
  return PRICE_BASIS_WORDS[basis] ?? basis;
}
