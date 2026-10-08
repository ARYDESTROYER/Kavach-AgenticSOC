/**
 * Pure display helpers for the composer (SPEC §8, §10.4). No React, no I/O: the
 * meter numbers, the time-range presets and the source labels are computed here so
 * they can be unit-tested and shared by the chips, popovers and hover card.
 */
import type { ChatContextInfo, ChatScope, ChatTimeRange, SourceInstance } from '@/lib/types';
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from '../display';
import { compactTokens, formatCost } from '../message/format';
import { displayText } from '../stream-events';

/**
 * Compact token count in the chat grammar (SPEC §8): 820, 1.2k, 12.4k, 184k, 1.3M.
 * The SAME function as the transcript's ({@link compactTokens}), so the meter card
 * and the thread toolbar never show one conversation two ways.
 */
export function formatTokenCount(value: number | null | undefined): string {
  return compactTokens(value);
}

/**
 * A per-turn amount in the transcript's grammar ("$0.002", "$0.03", "<$0.001"): the
 * projected cost and this conversation's total read exactly like the run log and
 * the thread toolbar ({@link formatCost}).
 */
export function formatTurnCost(value: number | null | undefined): string {
  return formatCost(value);
}

const trimZero = (s: string) => s.replace(/\.0+$|(\.\d*?)0+$/, '$1');

/** Grouped integer ("12,345") for hover-card detail rows. */
export function formatExactTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * A BUDGET amount ("$4.20 of $10.00"): always two decimals, like the budget settings.
 * A non-zero spend under one cent uses the per-turn grammar ("$0.004") so it never
 * reads as "$0.00". Per-turn figures use {@link formatTurnCost}.
 */
export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value > 0 && value < 0.01) return formatCost(value);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* -------------------------------------------------------------------------- */
/* Next-request estimate (SPEC §8 item 1).                                     */
/* -------------------------------------------------------------------------- */

/** The server's calibration bounds (`CALIBRATION_BOUNDS` in routes_chat.py). */
export const CALIBRATION_RANGE = [0.25, 4] as const;

/** The usable calibration factor: clamped to 0.25–4; 1 when absent or not a number. */
export function calibrationFactor(calibration: number | null | undefined): number {
  if (typeof calibration !== 'number' || !Number.isFinite(calibration) || calibration <= 0) return 1;
  return Math.min(CALIBRATION_RANGE[1], Math.max(CALIBRATION_RANGE[0], calibration));
}

/** "×1.5" for the meter card. */
export function formatFactor(factor: number): string {
  return `×${trimZero(factor.toFixed(2))}`;
}

export interface CalibratedEstimate {
  system: number;
  history: number;
  draft: number;
  total: number;
  /** The factor applied to every part (1 = uncalibrated). */
  factor: number;
}

/**
 * The composer's "≈ N" (SPEC §8): (system + history + draft) chars ÷ chars_per_token
 * × calibration. The calibration is the server's actual ÷ estimate for the WHOLE first
 * prompt of this conversation's last turn, and `static_prompt_tokens` and
 * `history_tokens` are uncalibrated chars ÷ 4 estimates, so the factor applies to
 * every part, not just the draft. Never negative, never NaN.
 */
export function calibratedNextRequest(
  context: Pick<ChatContextInfo, 'static_prompt_tokens' | 'history_tokens' | 'chars_per_token' | 'calibration'>,
  draft: string,
): CalibratedEstimate {
  const factor = calibrationFactor(context.calibration);
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const cpt =
    Number.isFinite(context.chars_per_token) && context.chars_per_token > 0
      ? context.chars_per_token
      : DEFAULT_CHARS_PER_TOKEN;
  const system = Math.round(safe(context.static_prompt_tokens) * factor);
  const history = Math.round(safe(context.history_tokens) * factor);
  const draftTokens = estimateTokens(Array.from(draft).length, cpt, factor);
  return { system, history, draft: draftTokens, total: system + history + draftTokens, factor };
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

/** A cost range "≈ $0.003–$0.08" for the projected turn, or null without rates. */
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
