/**
 * Pure display helpers for the composer (SPEC §8, §10.4). No React, no I/O: the
 * meter numbers, the time-range presets and the source labels are computed here so
 * they can be unit-tested and shared by the chips, popovers and hover card.
 */
import type { ChatContextInfo, ChatScope, ChatTimeRange, SourceInstance } from '@/lib/types';
import { estimateNextRequest } from '../display';
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

// The calibration clamp lives with the estimate it feeds (display.ts), so the meter and
// the "Continue (≈ +N tokens)" chip can never apply two different factors.
export { CALIBRATION_RANGE, calibrationFactor } from '../display';

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
/**
 * `context` with the history part the ENGINE will send with the next turn. A case
 * chat holds its history on the client (SPEC §4.3: replayed from the request's
 * `history`), which `/chat/context` cannot see and reports as 0; without this the
 * case meter would leave out every earlier exchange. Plain chars ÷ chars_per_token,
 * like the server's own history figure, so the calibration applies the same way.
 */
export function withClientHistory(
  context: ChatContextInfo,
  size: { exchanges: number; chars: number },
): ChatContextInfo {
  const cpt = Number.isFinite(context.chars_per_token) && context.chars_per_token > 0 ? context.chars_per_token : 4;
  const chars = Number.isFinite(size.chars) && size.chars > 0 ? size.chars : 0;
  const tokens = chars > 0 ? Math.max(1, Math.floor(chars / cpt)) : 0;
  const exchanges = Number.isFinite(size.exchanges) && size.exchanges > 0 ? Math.floor(size.exchanges) : 0;
  if (context.history_tokens === tokens && context.history_exchanges === exchanges) return context;
  return { ...context, history_tokens: tokens, history_exchanges: exchanges };
}

export function calibratedNextRequest(
  context: Pick<ChatContextInfo, 'static_prompt_tokens' | 'history_tokens' | 'chars_per_token' | 'calibration'>,
  draft: string,
): CalibratedEstimate {
  return estimateNextRequest({
    staticPromptTokens: context.static_prompt_tokens,
    historyTokens: context.history_tokens,
    draft,
    charsPerToken: context.chars_per_token,
    calibration: context.calibration,
  });
}

/* -------------------------------------------------------------------------- */
/* Time range (the composer chip; SPEC §3.1 time precedence).                  */
/* -------------------------------------------------------------------------- */

export interface TimePreset {
  /** A stable id (the segment's value). */
  id: string;
  /** The chip and segment label ("Auto", "24h", "6mo", "All time"). */
  short: string;
  /** Long label for the popover and accessible names. */
  label: string;
  /**
   * `null` = the default, "Auto": no outer limit, and each lookup uses its own default
   * window (see {@link timeRangeHint}). Every other preset is an outer limit.
   */
  range: ChatTimeRange | null;
}

/** The `from` of the "All time" chip (`TimeRange.is_all_time` server-side). */
export const ALL_TIME_FROM = 'all';

/** The id of the default preset: no range chosen. */
export const DEFAULT_TIME_PRESET_ID = 'auto';

/**
 * The chip presets (Round 12, SPEC D7/D7a): chat scope windows have no span limit, so
 * the list goes from the last hour to all time. The default, **Auto**, chooses no range:
 * no outer limit, and each lookup keeps its own default window. It has its own label
 * because it is not "the last 24 hours" (case counts cover all time without a window);
 * **24h** is an explicit `now-24h`, an outer limit like every other preset. A chosen
 * preset is an outer limit a question can only narrow; "All time" never clamps (only
 * its end, now, applies). Months are calendar months (`now-6M`), never minutes.
 */
export const TIME_PRESETS: readonly TimePreset[] = [
  { id: DEFAULT_TIME_PRESET_ID, short: 'Auto', label: 'Default windows, no outer limit', range: null },
  { id: '1h', short: '1h', label: 'Last hour', range: { from: 'now-1h' } },
  { id: '24h', short: '24h', label: 'Last 24 hours', range: { from: 'now-24h' } },
  { id: '7d', short: '7d', label: 'Last 7 days', range: { from: 'now-7d' } },
  { id: '30d', short: '30d', label: 'Last 30 days', range: { from: 'now-30d' } },
  { id: '90d', short: '90d', label: 'Last 90 days', range: { from: 'now-90d' } },
  { id: '6mo', short: '6mo', label: 'Last 6 months', range: { from: 'now-6M' } },
  { id: '12mo', short: '12mo', label: 'Last 12 months', range: { from: 'now-12M' } },
  { id: 'all', short: 'All time', label: 'All time', range: { from: ALL_TIME_FROM } },
];

/** The default preset, Auto (no range chosen). */
export const DEFAULT_TIME_PRESET: TimePreset = TIME_PRESETS[0];

/** Presets whose range is at most 7 days (the shift brief's bound covers them whole). */
const WEEK_OR_LESS = new Set(['1h', '24h', '7d']);

function presetById(id: string): TimePreset | null {
  return TIME_PRESETS.find((p) => p.id === id) ?? null;
}

/** True for the "All time" chip (`from: "all"`, any spelling the server accepts). */
export function isAllTimeRange(range: ChatTimeRange | null | undefined): boolean {
  const from = typeof range?.from === 'string' ? range.from.trim().toLowerCase() : '';
  return from === ALL_TIME_FROM || from === 'all_time' || from === 'all time' || from === 'lifetime';
}

/** `from` the way the server normalises it ("NOW-7D" → "now-7d"; "now-6M" stays months). */
function normalisedFrom(from: string): string {
  const text = from.trim();
  if (!/^now/i.test(text)) return text;
  const unit = text.slice(-1);
  if (unit === 'M' || unit === 'y' || unit === 'Y') return `${text.slice(0, -1).toLowerCase()}${unit === 'M' ? 'M' : 'y'}`;
  return text.toLowerCase();
}

/**
 * The preset a range corresponds to: no range is Auto; an explicit `now-24h` (or
 * `now-1d`) is the 24h preset, an outer limit, never Auto; `now-1y` is the same window
 * as `now-12M`. A range that ends before now is never a preset.
 */
export function presetForRange(range: ChatTimeRange | null | undefined): TimePreset | null {
  if (!range) return DEFAULT_TIME_PRESET;
  if (range.to && range.to.trim().toLowerCase() !== 'now') return null;
  if (isAllTimeRange(range)) return presetById('all');
  const from = normalisedFrom(range.from);
  if (from === 'now-1d') return presetById('24h');
  if (from === 'now-1y') return presetById('12mo');
  return TIME_PRESETS.find((p) => p.range?.from === from) ?? null;
}

/** Chip label for a range: a preset's short label, or a bounded "from → to" for anything else. */
export function timeRangeShortLabel(range: ChatTimeRange | null | undefined): string {
  const preset = presetForRange(range);
  if (preset) return preset.short;
  const from = displayText(range?.from, 24);
  const to = displayText(range?.to ?? 'now', 24);
  return `${from} → ${to}`;
}

/** Long label for accessible names. */
export function timeRangeLongLabel(range: ChatTimeRange | null | undefined): string {
  const preset = presetForRange(range);
  if (preset) return preset.label;
  if (isAllTimeRange(range)) return `All time to ${displayText(range?.to, 40)}`;
  return `From ${displayText(range?.from, 40)} to ${displayText(range?.to ?? 'now', 40)}`;
}

/** A label as it reads after other words, in brackets ("Last 7 days" → "last 7 days"). */
export function inlineLabel(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The scope chip's accessible name. It starts with the chip's visible text,
 * "<source> · <range>" (WCAG 2.5.3, label in name: a speech-input user says what they
 * see), then says what a short range means when the short label does not ("Auto
 * (default windows, no outer limit)", "7d (last 7 days)"; "All time" stays as it is).
 */
export function scopeChipName(sourceLabel: string, range: ChatTimeRange | null | undefined): string {
  const short = timeRangeShortLabel(range);
  const long = timeRangeLongLabel(range);
  const meaning = long.toLowerCase() === short.toLowerCase() ? '' : ` (${inlineLabel(long)})`;
  return `Scope: ${sourceLabel} · ${short}${meaning}. Change source and time range`;
}

/**
 * What the scope popover says under the time range (Round 12, SPEC D7), naming every
 * lookup that does not follow the general rule:
 *
 *  - Auto (no range) sets NO outer limit. Without a window in the question, case
 *    counts and case searches (`case_stats`, `search_cases`) and ATT&CK coverage
 *    (`soc_metrics kind=mitre_coverage`) cover all time; log, metric, cost and audit
 *    lookups and the shift brief the last 24 hours (`prompts.py`, the Help Center).
 *  - A chosen range, an explicit `now-24h` included, is the window of every lookup
 *    without one in the question and an outer limit tool windows are clamped into
 *    (`chat_tools/common.resolve_window`); "All time" never clamps. Except: the shift
 *    brief covers at most 7 days (`shift_report`), named only when the range can be
 *    longer than that.
 *  - Agent improvement always compares its own fixed periods
 *    (`soc_metrics kind=agent_improvement`): the selected range does not apply.
 */
/**
 * The scope popover's one-line hint (Round 13, SPEC-chat T23); the rest of
 * {@link timeRangeHint} sits behind its "How ranges work" disclosure.
 */
export function timeRangeShortHint(range: ChatTimeRange | null | undefined): string {
  if (!range) return 'Auto: each lookup uses its own default window.';
  if (isAllTimeRange(range) && presetForRange(range)) return 'All time: lookups without a window cover all time.';
  return `${timeRangeLongLabel(range)}: questions can narrow this range, not widen it.`;
}

export function timeRangeHint(range: ChatTimeRange | null | undefined): string {
  if (!range) {
    return (
      'No outer limit. Without a window in your question, case counts, case searches and ATT&CK coverage ' +
      'cover all time; log, metric, cost and audit lookups and the shift brief cover the last 24 hours. ' +
      'Agent improvement always compares fixed periods.'
    );
  }
  const preset = presetForRange(range);
  const longShift = !preset || !WEEK_OR_LESS.has(preset.id);
  const except = longShift
    ? 'except that the shift brief covers at most 7 days and agent improvement compares fixed periods'
    : 'except agent improvement, which compares fixed periods';
  if (isAllTimeRange(range) && preset) {
    return `All time. Lookups without a window in your question cover all time, ${except}. A question can still name a shorter window.`;
  }
  return `${timeRangeLongLabel(range)}. Lookups without a window in your question use this range, ${except}. Questions can narrow it, not widen it.`;
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

/** `aria-valuetext` for the budget bar: "42% of today's AI budget used, $4.20 of $10.00". */
export function budgetValueText(value: BudgetMeterValue): string {
  const pct = Math.round(value.percent);
  const sim = value.simulated ? ' (simulated)' : '';
  return `${pct}% of today's AI budget used, ${formatMoney(value.spent)} of ${formatMoney(value.limit)}${sim}`;
}

/* -------------------------------------------------------------------------- */
/* Context window (Round 12: the composer ring).                               */
/* -------------------------------------------------------------------------- */

/** From this share of the window the ring turns amber (the next request is nearly full). */
export const CONTEXT_HIGH_SHARE = 0.9;

export interface ContextMeterValue {
  /** ≈ tokens the next request sends (system and tools + history + draft, calibrated). */
  used: number;
  /** The model's context window in tokens. */
  window: number;
  /** `used ÷ window` as a percentage (may exceed 100 in bounded mode). */
  percent: number;
  level: 'ok' | 'high';
  /** Chat runs without limits: long conversations are summarised automatically. */
  summarises: boolean;
}

/** True when chat runs without per-question limits (SPEC D1); an older backend is bounded. */
export function chatUnlimited(context: Pick<ChatContextInfo, 'limits_mode'> | null | undefined): boolean {
  return context?.limits_mode === 'unlimited';
}

/**
 * The ring's value, or `null` when the window is unknown (no ring then). `used` is the
 * composer's own next-request estimate, so the ring and "≈ N" never disagree.
 */
export function contextMeterValue(
  context: Pick<ChatContextInfo, 'context_window' | 'limits_mode'> | null | undefined,
  used: number,
): ContextMeterValue | null {
  const window = context?.context_window;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null;
  const tokens = Number.isFinite(used) && used > 0 ? used : 0;
  const share = tokens / window;
  return {
    used: tokens,
    window,
    percent: share * 100,
    level: share >= CONTEXT_HIGH_SHARE ? 'high' : 'ok',
    summarises: chatUnlimited(context),
  };
}

/** "0%", "<1%", "12%": a non-zero share never rounds down to an empty-looking 0%. */
export function formatContextPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * `aria-valuetext` for the context ring: "12% of the context window used, about 24k of
 * 200k tokens. Older messages are summarised automatically near the limit."
 */
export function contextValueText(value: ContextMeterValue): string {
  const head = `${formatContextPercent(value.percent)} of the context window used, about ${formatTokenCount(value.used)} of ${formatTokenCount(value.window)} tokens.`;
  const high = value.level === 'high' ? ' Nearly full.' : '';
  const tail = value.summarises ? ' Older messages are summarised automatically near the limit.' : '';
  return `${head}${high}${tail}`;
}

/**
 * The popover's line under the context figure. Unlimited mode (SPEC D1/D4): a long
 * conversation is summarised automatically near the limit, and there is no hard cap.
 * Bounded mode keeps the per-question ceiling and the replay window.
 */
export function contextNote(context: Pick<ChatContextInfo, 'limits_mode'> | null | undefined): string {
  return chatUnlimited(context)
    ? 'Long conversations are summarised automatically near the limit, so the chat keeps going. There is no hard cap.'
    : 'Older exchanges are not sent.';
}

/**
 * The popover's line under the daily budget (SPEC D5): what counts against it, and that
 * chat is metered but never paused by it. A viewer who cannot see the budget itself
 * (no `models:read`) gets the state in words, still without implying chat stops.
 */
export function budgetNote(context: ChatContextInfo | null | undefined): string | null {
  if (!context) return null;
  const visible = context.budget?.enabled === true;
  const state = context.budget_state;
  if (!visible && (!state || state === 'ok')) return null;
  const counts = 'Automatic investigations count against this budget. Chat is recorded in the cost ledger but is not paused by it.';
  if (visible) return counts;
  if (state === 'reached') return `Automatic investigations have reached today's AI budget. Chat is not affected.`;
  return `Automatic investigations are near today's AI budget. Chat is not affected.`;
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
