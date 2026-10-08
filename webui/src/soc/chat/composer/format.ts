/**
 * Pure display helpers for the composer (SPEC §8, §10.4). No React, no I/O: the
 * meter numbers, the time-range presets and the source labels are computed here so
 * they can be unit-tested and shared by the chips, popovers and hover card.
 */
import type { ChatContextInfo, ChatScope, ChatTimeRange, SourceInstance } from '@/lib/types';
import { displayText } from '../stream-events';

/** Compact token count in the console's chat grammar: 820, 1.2k, 12k, 1.2M. */
export function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const n = Math.round(value);
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

const trimZero = (s: string) => s.replace(/\.0$/, '');

/** Grouped integer ("12,345") for hover-card detail rows. */
export function formatExactTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Money in the console's grammar: four decimals below $1 (chat turns cost fractions of
 * a cent), two above. Zero reads "$0.00".
 */
export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  const decimals = Math.abs(value) >= 1 ? 2 : 4;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/* -------------------------------------------------------------------------- */
/* Time range (the composer chip; SPEC §3.1 time precedence).                  */
/* -------------------------------------------------------------------------- */

export interface TimePreset {
  /** Short chip label ("24h"). */
  id: string;
  /** Long label for the popover and accessible names. */
  label: string;
  /** `null` = the tools' default window (24 h), which is what the chip shows unset. */
  range: ChatTimeRange | null;
}

/** The chip presets; 90 days is the server's maximum window. */
export const TIME_PRESETS: readonly TimePreset[] = [
  { id: '1h', label: 'Last hour', range: { from: 'now-1h' } },
  { id: '24h', label: 'Last 24 hours', range: null },
  { id: '7d', label: 'Last 7 days', range: { from: 'now-7d' } },
  { id: '30d', label: 'Last 30 days', range: { from: 'now-30d' } },
  { id: '90d', label: 'Last 90 days', range: { from: 'now-90d' } },
];

/** The preset a range corresponds to (an explicit `now-24h` reads as the default). */
export function presetForRange(range: ChatTimeRange | null | undefined): TimePreset | null {
  if (!range) return TIME_PRESETS[1];
  if (range.to && range.to !== 'now') return null;
  if (range.from === 'now-24h' || range.from === 'now-1d') return TIME_PRESETS[1];
  return TIME_PRESETS.find((p) => p.range?.from === range.from) ?? null;
}

/** Chip label for a range: a preset id, or a bounded "from → to" for anything else. */
export function timeRangeShortLabel(range: ChatTimeRange | null | undefined): string {
  const preset = presetForRange(range);
  if (preset) return preset.id;
  const from = displayText(range?.from, 24);
  const to = displayText(range?.to ?? 'now', 24);
  return `${from} → ${to}`;
}

/** Long label for accessible names. */
export function timeRangeLongLabel(range: ChatTimeRange | null | undefined): string {
  const preset = presetForRange(range);
  if (preset) return preset.label;
  return `From ${displayText(range?.from, 40)} to ${displayText(range?.to ?? 'now', 40)}`;
}

/* -------------------------------------------------------------------------- */
/* Sources.                                                                    */
/* -------------------------------------------------------------------------- */

/** An operator-configured source name (plain text, #9): display name, else type · id. */
export function sourceDisplayName(source: SourceInstance): string {
  const name = displayText(source.display_name, 60);
  if (name) return name;
  const type = displayText(source.source_type, 40);
  const id = displayText(source.id, 60);
  return type ? `${type} · ${id}` : id;
}

/**
 * Sources the chat can query. `can_browse` is the server-authoritative predicate; an
 * older backend without it falls back to the pre-revamp rule (enabled pull sources,
 * plus Demo adapters).
 */
export function isQueryableSource(source: SourceInstance): boolean {
  if (source.enabled === false) return false;
  if (source.can_browse === true) return true;
  if (source.can_browse === false) return false;
  return source.ingest_mode === 'pull' || source.demo === true;
}

/** "All sources" when nothing is selected (the log tools fan out); else its name. */
export function sourceChipLabel(sourceId: string | null, sources: readonly SourceInstance[]): string {
  if (!sourceId) {
    const queryable = sources.filter(isQueryableSource);
    return queryable.length === 1 ? sourceDisplayName(queryable[0]) : 'All sources';
  }
  const match = sources.find((s) => s.id === sourceId);
  return match ? sourceDisplayName(match) : displayText(sourceId, 40) || 'Selected source';
}

/* -------------------------------------------------------------------------- */
/* Scopes (@).                                                                 */
/* -------------------------------------------------------------------------- */

export const SCOPE_LABELS: Record<ChatScope, string> = {
  logs: 'Logs',
  cases: 'Cases',
  metrics: 'Metrics',
  intel: 'Threat intel',
  docs: 'Help docs',
  platform: 'Platform',
};

export const SCOPE_DESCRIPTIONS: Record<ChatScope, string> = {
  logs: 'Search and count log events',
  cases: 'Cases, campaigns and decisions',
  metrics: 'Posture, trends and noise',
  intel: 'Indicators, ATT&CK and runbooks',
  docs: 'How this console works',
  platform: 'Sources, spend, automation and audit',
};

/* -------------------------------------------------------------------------- */
/* Meter (SPEC §8).                                                            */
/* -------------------------------------------------------------------------- */

export type BudgetLevel = 'ok' | 'warn' | 'critical';

export interface BudgetMeterValue {
  /** Spend as a percentage of the daily limit (may exceed 100). */
  percent: number;
  spent: number;
  limit: number;
  level: BudgetLevel;
  simulated: boolean;
}

/**
 * The ring's value, or `null` when it must be hidden: no enabled budget, no positive
 * limit, or no spend figure (that needs `cost:view`). The level is the worse of the
 * local threshold and the server's `budget_state`.
 */
export function budgetMeterValue(context: ChatContextInfo | null | undefined): BudgetMeterValue | null {
  const budget = context?.budget;
  const spent = context?.spent_today;
  if (!budget?.enabled || typeof budget.daily_limit !== 'number' || budget.daily_limit <= 0) return null;
  if (typeof spent !== 'number' || !Number.isFinite(spent)) return null;
  const percent = (spent / budget.daily_limit) * 100;
  let level: BudgetLevel = 'ok';
  if (percent >= budget.soft_warn_pct * 100 || context?.budget_state === 'approaching') level = 'warn';
  if (percent >= 100 || context?.budget_state === 'reached') level = 'critical';
  return { percent, spent, limit: budget.daily_limit, level, simulated: context?.simulated === true };
}

/** `aria-valuetext` for the ring: "42% of today's AI budget used, $4.20 of $10.00". */
export function budgetValueText(value: BudgetMeterValue): string {
  const pct = Math.round(value.percent);
  const sim = value.simulated ? ' (simulated)' : '';
  return `${pct}% of today's AI budget used, ${formatMoney(value.spent)} of ${formatMoney(value.limit)}${sim}`;
}

/** Send is refused before a request when the budget is spent and set to block. */
export function budgetSendBlockReason(context: ChatContextInfo | null | undefined): string | null {
  if (context?.budget_state !== 'reached') return null;
  if (context.budget?.on_exceed !== 'block') return null;
  return "Today's AI budget is used up.";
}

/** A cost range "≈ $0.0010–$0.0300" for the projected turn, or null without rates. */
export function projectedCostRange(
  context: ChatContextInfo,
  nextRequestTokens: number,
  turnMaxTokens: number,
): { low: number; high: number } | null {
  const rates = context.rates;
  if (!rates) return null;
  const inRate = rates.input_per_million / 1_000_000;
  const outRate = rates.output_per_million / 1_000_000;
  // Low: one model call reading the next request. High: the whole projected turn, with
  // the final answer's reserve priced as output.
  const outputShare = Math.min(turnMaxTokens, Math.max(0, context.bounds.final_max_tokens));
  const low = nextRequestTokens * inRate;
  const high = Math.max(low, (turnMaxTokens - outputShare) * inRate + outputShare * outRate);
  return { low, high };
}
