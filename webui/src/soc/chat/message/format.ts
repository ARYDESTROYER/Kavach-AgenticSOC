/**
 * Transcript display helpers (chat revamp SPEC §8, §10.3).
 *
 * Pure functions shared by the run log, the meta row, the usage card and the thread
 * toolbar so every figure reads the same everywhere: compact token counts ("1.2k"),
 * short money ("$0.004"), turn durations ("6.2 s") and the honest "≈" / "simulated"
 * qualifiers. Nothing here renders, and nothing takes a string from a response except
 * already-normalised enums and numbers.
 */
import type { ChatStep, ChatStepStatus, TurnUsage } from '@/lib/types';

/** "820", "1.2k", "12.4k", "184k", "1.3M" (lower-case k, as in SPEC §8). */
export function compactTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const n = Math.round(value);
  if (n < 1000) return String(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (n < 100_000) return `${trim(n / 1000)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/**
 * Short spend: "$0", "<$0.001", "$0.004", "$0.03", "$1.20". The meter and the run log
 * deal in fractions of a cent, so three decimals below one cent and two above.
 */
export function formatCost(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '$0';
  if (value < 0.001) return '<$0.001';
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** "820 ms", "6.2 s", "2 min 4 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, '')} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Tool calls in a step list (model steps are not lookups). */
export function lookupCount(steps: readonly Pick<ChatStep, 'kind'>[]): number {
  return steps.filter((step) => step.kind === 'tool').length;
}

/** "1 lookup" / "4 lookups". */
export function lookupsLabel(count: number): string {
  return `${count} ${count === 1 ? 'lookup' : 'lookups'}`;
}

/**
 * The turn's elapsed time from its steps: steps of one parallel group overlap, so a
 * group counts once (its slowest call); everything else ran in sequence. Falls back to
 * the model latency the usage recorded (a compatibility-mode turn has no steps).
 */
export function turnDurationMs(
  steps: readonly Pick<ChatStep, 'duration_ms' | 'group'>[],
  usage: Pick<TurnUsage, 'latency_ms'> | null | undefined,
): number | null {
  if (steps.length) {
    const groups = new Map<number, number>();
    let total = 0;
    for (const step of steps) {
      const ms = Number.isFinite(step.duration_ms) ? Math.max(0, step.duration_ms) : 0;
      if (typeof step.group === 'number') groups.set(step.group, Math.max(groups.get(step.group) ?? 0, ms));
      else total += ms;
    }
    for (const ms of groups.values()) total += ms;
    if (total > 0) return total;
  }
  const latency = usage?.latency_ms;
  return typeof latency === 'number' && latency > 0 ? latency : null;
}

/** "2.1k tokens · $0.004" with the honest qualifiers ("≈", "simulated"). */
export function usageSummary(
  usage: TurnUsage,
  { withCost = true, withSimulated = true }: { withCost?: boolean; withSimulated?: boolean } = {},
): string {
  const approx = usage.estimated ? '≈ ' : '';
  const parts = [`${approx}${compactTokens(usage.total_tokens)} tokens`];
  if (withCost) parts.push(`${approx}${formatCost(usage.cost)}`);
  if (withSimulated && usage.simulated) parts.push('simulated');
  return parts.join(' · ');
}

/** Input tokens as users understand them: uncached + cache read + cache write (SPEC §3.4). */
export function inputTokens(usage: TurnUsage): number {
  return usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
}

export type RunStepStatus = 'running' | ChatStepStatus;

/** The visible status word of a run-log row (status is never colour alone). */
export const STEP_STATUS_LABEL: Record<RunStepStatus, string> = {
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
  timeout: 'Timed out',
  denied: 'Denied',
  skipped: 'Skipped',
  cancelled: 'Stopped',
};

/** Basis wording for a row without an explicit coverage line. */
export const BASIS_LABEL: Record<NonNullable<ChatStep['basis']>, string> = {
  exact: 'exact',
  newest_n: 'newest results',
  sample: 'sample',
  cached: 'cached',
};

/**
 * Display names for the engine's chip keys that a generic "snake_case → Sentence"
 * reading gets wrong (acronyms, ids, the time window, sort fields).
 */
const PARAM_KEY_LABELS: Record<string, string> = {
  ip: 'IP',
  ids: 'IDs',
  case_id: 'Case',
  campaign_id: 'Campaign',
  rule_id: 'Rule',
  source_id: 'Source',
  all_sources: 'All sources',
  time_from: 'From',
  time_to: 'To',
  window_hours: 'Window',
  sort_field: 'Sorted by',
  sort_order: 'Order',
  severity_gte: 'Severity at least',
  top_k: 'Top',
  top_n: 'Top',
  size: 'Limit',
  compare_previous: 'Compare with previous',
};

/** "query" → "Query", "group_by" → "Group by", "ip" → "IP" (keys are engine-whitelisted). */
export function paramKeyLabel(key: string): string {
  const known = PARAM_KEY_LABELS[key];
  if (known) return known;
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

const UNIT_WORDS: Record<string, [string, string]> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
  M: ['month', 'months'],
  y: ['year', 'years'],
};

/** "now-7d" → "last 7 days", "now" → "now"; anything else unchanged. */
export function relativeTimeLabel(value: string): string {
  const text = value.trim();
  if (text === 'now') return 'now';
  const match = /^now-(\d{1,5})([mhdwMy])$/.exec(text);
  if (!match) return value;
  const n = Number(match[1]);
  const [one, many] = UNIT_WORDS[match[2]];
  return n === 1 ? `last ${one}` : `last ${n.toLocaleString()} ${many}`;
}

/** 24 → "last 24 hours", 168 → "last 7 days". */
function windowHoursLabel(hours: number): string {
  if (hours > 0 && hours % 24 === 0 && hours >= 48) return `last ${(hours / 24).toLocaleString()} days`;
  return hours === 1 ? 'last hour' : `last ${hours.toLocaleString()} hours`;
}

const SORT_FIELD_LABELS: Record<string, string> = {
  created_at: 'creation time',
  updated_at: 'last update',
  risk_score: 'risk score',
};

/**
 * A chip value as text (booleans and nulls read as words, never as blanks). With its
 * `key`, the time window, relative times and sort fields read as words ("last 7 days",
 * "creation time") instead of query syntax ("now-7d", "created_at").
 */
export function paramValue(value: string | number | boolean | null, key?: string): string {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return key === 'window_hours' ? windowHoursLabel(value) : value.toLocaleString();
  if (key === 'time_from' || key === 'time_to') return relativeTimeLabel(value);
  if (key === 'sort_field') return SORT_FIELD_LABELS[value] ?? value.replace(/_/g, ' ');
  if (key === 'sort_order') return value === 'asc' ? 'oldest first' : value === 'desc' ? 'newest first' : value;
  return value;
}
