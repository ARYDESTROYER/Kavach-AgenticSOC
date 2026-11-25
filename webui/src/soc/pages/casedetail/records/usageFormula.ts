/**
 * The cost formula of one ledger row, in that row's own numbers (Round 16 SPEC §4.5
 * WP13 "Rate fields", WP14).
 *
 * Each row's cost is `round((prompt x input + completion x output + cache_read x read +
 * cache_write x write) / 1e6 x (0.5 if batch else 1), 8)`, the gateway's `cost_for`
 * formula, over the undiscounted per-million rates the row recorded. A row written before
 * the rates were stored shows its stored cost and says so.
 *
 * `recomputeCost` has the signature of the Explain kit's `recomputeCost`
 * (`lib/explain/cost.ts`, WP11), so the usage popover can switch to the kit's helper when
 * it lands; this local copy keeps the popover independent of it until then. Pure.
 */
import type { CaseUsageRow } from '@/lib/types';
import { fmtMoney } from '@/lib/format';

const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Whether the row recorded the rates its cost was computed from. */
export function hasRates(row: CaseUsageRow): boolean {
  return rate(row.input_rate_per_million) !== null && rate(row.output_rate_per_million) !== null;
}

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

/** A count with thousands separators: 1240 is "1,240". */
export function tokens(value: number | null | undefined): string {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

/** A per-million rate with no trailing zeros: 1.25 is "$1.25/M", 0.3 is "$0.3/M". */
export function perMillion(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 0 })}/M`;
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
 * The formula line with the row's own numbers, for example
 * `1,240 in x $1.25/M + 310 out x $10/M = $0.00465`. A cache term shows only when the
 * row used the cache; a Batch row ends with `x 0.5 (Batch)`. The result is the
 * recompute to the ledger's 8 decimals. Null when the row recorded no rates.
 */
export function costFormula(row: CaseUsageRow): string | null {
  const input = rate(row.input_rate_per_million);
  const output = rate(row.output_rate_per_million);
  if (input === null || output === null) return null;
  const terms = [`${tokens(row.prompt_tokens)} in x ${perMillion(input)}`, `${tokens(row.completion_tokens)} out x ${perMillion(output)}`];
  if (row.cache_read_tokens) {
    terms.push(`${tokens(row.cache_read_tokens)} cache read x ${perMillion(rate(row.cache_read_rate_per_million) ?? 0)}`);
  }
  if (row.cache_write_tokens) {
    terms.push(`${tokens(row.cache_write_tokens)} cache write x ${perMillion(rate(row.cache_write_rate_per_million) ?? 0)}`);
  }
  const sum = terms.join(' + ');
  const total = recomputeCost(row) ?? row.cost;
  return `${row.batch ? `(${sum}) x 0.5 (Batch)` : sum} = ${exactMoney(total, row.currency)}`;
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
