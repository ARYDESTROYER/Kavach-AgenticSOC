/**
 * The KPI strip cell evaluator (Round 14, SPEC §4.4.3): turns one binding of
 * `KPI_STRIP_BINDINGS` and the answers of the requests it reads into what the cell may
 * honestly say. Pure, no React, no network.
 *
 * The honesty rules (the binding module's header states them; this is their one
 * implementation):
 *
 * 1. Not measured. A value that is not a finite number (`null`, absent, the server's
 *    dash string), or whose `availableField` is `false`, is "Not measured" with the
 *    source's reason. Never 0, never the dash itself.
 * 2. Partial. A matching `partialWhen` flag makes the value partial: a count reads "at
 *    least N", any other figure "about N", with the flag's reason.
 * 3. Shares. A `shareField` value is shown only when it is a finite number.
 * 4. Breakdowns. `partial: true` is a lower bound (with `partial_reason`). An absent
 *    group reads 0 only when `other` is null or `other.count` is 0; absent while
 *    `other.count > 0` means `top` cut it, so the cell is Not measured. A sum over every
 *    group is a lower bound while `other.count > 0` (unless `other` carries the metric
 *    itself); a keyed sum is exact only when every key is in `groups` or `other.count`
 *    is 0. A ratio shows only when both sums are exact and the denominator is above 0.
 * 5. Stage reduction. The shared Alert reduction rule (`components/alert-reduction.ts`),
 *    the same function the Cyber Defence Center's flow uses, so the two never disagree.
 */
import { fmtDuration, fmtNumber } from '@/lib/format';
import type { MetricsBreakdown, MetricsBreakdownGroup } from '@/lib/types-dashboards';
import type { NoiseReduction } from '@/lib/types';
import { alertReduction } from '@/soc/components/alert-reduction';

import type {
  KpiBreakdownGroupSource,
  KpiBreakdownSumSource,
  KpiCellSource,
  KpiFieldSource,
  KpiFormat,
  KpiStripBinding,
} from '../kpi-bindings';
import { moneyText } from './format';
import type { DashboardRequest } from './requests';

/** What a cell can show. */
export type KpiCellStatus = 'value' | 'not_measured' | 'loading' | 'error';

export interface KpiCellResult {
  status: KpiCellStatus;
  /** The number behind the cell (`null` unless `value`). */
  value: number | null;
  /** The formatted value, or '' unless `value`. */
  text: string;
  /** A lower bound ("at least") or an approximation ("about"), as the source says. */
  qualifier: 'at least' | 'about' | null;
  /** Why it is not measured, or why it is partial (plain words, sentence case). */
  reason: string | null;
  /** A share in 0..1, shown beside the value only when it is a finite number. */
  share: number | null;
}

/** The answer a binding's request returned, as the provider holds it. */
export interface KpiSourceAnswer {
  loading: boolean;
  data: unknown;
  error: unknown;
}

export type KpiReader = (req: DashboardRequest) => KpiSourceAnswer;

export interface KpiEvalContext {
  /** The board window in hours (the "reporting" source count reads inside it). */
  windowHours: number;
  /** Now, in epoch ms (injectable for tests). */
  nowMs: number;
}

// --------------------------------------------------------------------------- //
// Requests
// --------------------------------------------------------------------------- //

function breakdownRequest(source: KpiBreakdownGroupSource | KpiBreakdownSumSource): DashboardRequest {
  const { window, ...rest } = source.query;
  return { key: 'breakdown', window, query: { ...rest } };
}

/** The requests one cell reads, in a stable order. */
export function bindingRequests(binding: KpiStripBinding): DashboardRequest[] {
  const source = binding.source;
  switch (source.type) {
    case 'breakdown_group':
    case 'breakdown_sum':
      return [breakdownRequest(source)];
    case 'ratio':
      return [breakdownRequest(source.numerator), breakdownRequest(source.denominator)];
    default:
      return [{ key: binding.provider, window: binding.window }];
  }
}

// --------------------------------------------------------------------------- //
// Field access
// --------------------------------------------------------------------------- //

const SEGMENT = /^([A-Za-z0-9_]+)(?:\[([A-Za-z0-9_]+)=([^\]]*)\])?$/;

/**
 * Read a dotted path, where a segment may select a list item by one of its fields:
 * `stages[key=ingested].total`. Anything that does not resolve is `undefined`.
 */
export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const m = SEGMENT.exec(part);
    if (!m) return undefined;
    const [, name, selKey, selValue] = m;
    cur = (cur as Record<string, unknown>)[name];
    if (selKey !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find(
        (item) => item && typeof item === 'object' && String((item as Record<string, unknown>)[selKey]) === selValue,
      );
    }
  }
  return cur;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** "the counters started recently" becomes "The counters started recently." */
export function sentence(reason: string): string {
  const t = reason.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/**
 * A reason a source states beside a field it leaves out, where the binding table names
 * none (the server added it after the table was written).
 */
const KNOWN_REASON_FIELDS: Readonly<Record<string, string>> = {
  'detection.events_per_minute': 'events_per_min_reason',
};

/** The cell's own words when the source names no reason. */
const DEFAULT_REASONS: Readonly<Record<string, string>> = {
  'operations.sla_breached': 'No SLA policy is turned on.',
  'detection.events_per_minute': 'The alert counters have not measured this window yet.',
  'detection.alerts_ingested': 'The alert counters are still warming up.',
  'executive.sla_attainment': 'No case in the window was scored against a target.',
};

const GENERIC_REASON = 'The source did not measure this in the window.';
const PARTIAL_REASON = 'Part of the window could not be read.';

/** Why a flag makes a value partial, where the source states no reason beside it. */
const FLAG_REASONS: Readonly<Record<string, string>> = {
  'counters.incomplete': 'The alert counters cover only part of this window.',
  truncated: 'Counted from part of the cases in the window.',
};

function cellKey(binding: KpiStripBinding): string {
  return `${binding.group}.${binding.cell}`;
}

// --------------------------------------------------------------------------- //
// Formatting
// --------------------------------------------------------------------------- //

/** A cell value in its binding's format. */
export function formatKpiValue(value: number, format: KpiFormat): string {
  switch (format) {
    case 'count':
      return fmtNumber(Math.round(value));
    case 'rate':
      return value.toLocaleString(undefined, {
        maximumFractionDigits: value < 10 ? 2 : value < 100 ? 1 : 0,
      });
    case 'percent': {
      const rounded = Math.round(value * 10) / 10;
      // A real but tiny share never reads as a 0% that means "none".
      return value > 0 && rounded === 0 ? '<0.1%' : `${rounded.toLocaleString()}%`;
    }
    case 'minutes':
      return fmtDuration(value);
    case 'usd':
      return moneyText(value, 'USD');
    default:
      return fmtNumber(value);
  }
}

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //

function notMeasured(reason: string | null | undefined): KpiCellResult {
  return {
    status: 'not_measured',
    value: null,
    text: '',
    qualifier: null,
    reason: sentence(reason || GENERIC_REASON),
    share: null,
  };
}

function measured(
  value: number,
  format: KpiFormat,
  opts: { partial?: boolean; reason?: string | null; share?: number | null; textOverride?: string } = {},
): KpiCellResult {
  return {
    status: 'value',
    value,
    text: opts.textOverride ?? formatKpiValue(value, format),
    qualifier: opts.partial ? (format === 'count' ? 'at least' : 'about') : null,
    reason: opts.partial ? sentence(opts.reason || PARTIAL_REASON) : null,
    share: opts.share ?? null,
  };
}

const LOADING: KpiCellResult = { status: 'loading', value: null, text: '', qualifier: null, reason: null, share: null };

function failed(): KpiCellResult {
  return {
    status: 'error',
    value: null,
    text: '',
    qualifier: null,
    reason: 'This figure could not be loaded.',
    share: null,
  };
}

// --------------------------------------------------------------------------- //
// Source kinds
// --------------------------------------------------------------------------- //

/** Why a shift-report figure is not measured when the report itself was not built. */
export const SHIFT_OFF_REASON = 'The shift report is turned off.';
export const SHIFT_UNREAD_REASON = 'The shift report could not be read.';

/**
 * Why the recorded auto-close figures are not measured, when the decision trail is the
 * reason: nothing was decided in the window while cases carry no decision record at
 * all (`decide()` never ran for them), so "no case was decided" would contradict the
 * same board's closed-by-the-agent counts. `null` when that is not the cause.
 */
export function autoCloseGapReason(current: unknown): string | null {
  const decided = finite(getPath(current, 'decided'));
  const missing = finite(getPath(current, 'no_decision_record'));
  if (decided !== 0 || missing == null || missing <= 0) return null;
  return `No decision is recorded in this window; ${fmtNumber(missing)} ${missing === 1 ? 'case has' : 'cases have'} no decision record.`;
}

function evalField(binding: KpiStripBinding, source: KpiFieldSource, data: unknown): KpiCellResult {
  // A shift report that is turned off or could not be built carries no sections at all:
  // say that, rather than the cell's own "no SLA policy" reason, which may be false.
  if (binding.provider === 'shift') {
    if (getPath(data, 'enabled') === false) return notMeasured(SHIFT_OFF_REASON);
    if (getPath(data, 'degraded') === true) return notMeasured(SHIFT_UNREAD_REASON);
  }
  const reasonFrom = () =>
    (binding.provider === 'autoClose' ? autoCloseGapReason(getPath(data, 'current')) : null) ??
    text(source.reasonField ? getPath(data, source.reasonField) : undefined) ??
    text(KNOWN_REASON_FIELDS[cellKey(binding)] ? getPath(data, KNOWN_REASON_FIELDS[cellKey(binding)]) : undefined) ??
    DEFAULT_REASONS[cellKey(binding)] ??
    GENERIC_REASON;
  if (source.availableField && getPath(data, source.availableField) === false) {
    return notMeasured(reasonFrom());
  }
  const value = finite(getPath(data, source.field));
  if (value == null) return notMeasured(reasonFrom());
  let partial = false;
  let partialReason: string | null = null;
  for (const flag of source.partialWhen ?? []) {
    if (getPath(data, flag.field) === flag.when) {
      partial = true;
      partialReason =
        partialReason ?? text(flag.reasonField ? getPath(data, flag.reasonField) : undefined) ?? FLAG_REASONS[flag.field] ?? null;
    }
  }
  const share = source.shareField ? finite(getPath(data, source.shareField)) : null;
  return measured(value, binding.format, { partial, reason: partialReason, share });
}

interface Sum {
  /** `null` when the metric is not a number on some counted group. */
  value: number | null;
  exact: boolean;
  reason: string | null;
}

function groupMetric(group: MetricsBreakdownGroup, metric: string): number | null {
  return finite((group as unknown as Record<string, unknown>)[metric]);
}

function asBreakdown(data: unknown): MetricsBreakdown | null {
  if (!data || typeof data !== 'object') return null;
  const b = data as MetricsBreakdown;
  return Array.isArray(b.groups) ? b : null;
}

function otherCount(b: MetricsBreakdown): number {
  return finite(b.other?.count) ?? 0;
}

function breakdownSum(source: KpiBreakdownSumSource, data: unknown): Sum {
  const b = asBreakdown(data);
  if (!b) return { value: null, exact: false, reason: null };
  const keys = source.keys ? new Set(source.keys) : null;
  let total = 0;
  for (const group of b.groups) {
    if (keys && (group.key == null || !keys.has(group.key))) continue;
    const v = groupMetric(group, source.metric);
    if (v == null) return { value: null, exact: false, reason: null };
    total += v;
  }
  const cut = otherCount(b) > 0;
  let exact = !b.partial;
  let reason: string | null = b.partial ? text(b.partial_reason) : null;
  if (cut) {
    if (keys) {
      // A keyed sum is exact when every key it needs was returned as a group.
      const present = new Set(b.groups.map((g) => g.key));
      const missing = [...keys].some((k) => !present.has(k));
      if (missing) {
        exact = false;
        reason = reason ?? 'Some groups were cut from the answer, so this counts only the ones returned.';
      }
    } else {
      // The remainder carries spend and calls itself; any other metric is only known
      // for the groups returned, so the sum is a floor.
      const otherValue = finite((b.other as unknown as Record<string, unknown> | null)?.[source.metric]);
      if (otherValue != null) total += otherValue;
      else {
        exact = false;
        reason = reason ?? 'Some groups were cut from the answer, so this counts only the ones returned.';
      }
    }
  }
  return { value: total, exact, reason };
}

function evalBreakdownGroup(binding: KpiStripBinding, source: KpiBreakdownGroupSource, data: unknown): KpiCellResult {
  const b = asBreakdown(data);
  if (!b) return notMeasured(null);
  const group = b.groups.find((g) => (source.group === null ? g.key == null || g.key === '' : g.key === source.group));
  let value: number | null;
  if (group) {
    value = groupMetric(group, source.metric);
    if (value == null) return notMeasured(null);
  } else if (otherCount(b) > 0) {
    // Absent because `top` cut it: it exists, but how many it holds is unknown here.
    return notMeasured('This group was cut from the answer, so its count is not known here.');
  } else {
    value = 0;
  }
  return measured(value, binding.format, { partial: b.partial, reason: b.partial_reason });
}

function evalBreakdownSum(binding: KpiStripBinding, source: KpiBreakdownSumSource, data: unknown): KpiCellResult {
  const sum = breakdownSum(source, data);
  if (sum.value == null) return notMeasured(null);
  return measured(sum.value, binding.format, { partial: !sum.exact, reason: sum.reason });
}

function evalSourcesHealth(
  binding: KpiStripBinding,
  count: 'reporting' | 'silent',
  data: unknown,
  ctx: KpiEvalContext,
): KpiCellResult {
  const rows = (data as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(rows)) return notMeasured(null);
  const since = ctx.nowMs - ctx.windowHours * 3_600_000;
  let n = 0;
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || row.enabled !== true) continue;
    if (count === 'silent') {
      if (row.silent === true) n += 1;
    } else {
      const last = finite(row.last_event_millis);
      if (last != null && last > 0 && last >= since) n += 1;
    }
  }
  return measured(n, binding.format);
}

function evalStageReduction(data: unknown): KpiCellResult {
  const r = alertReduction(data as NoiseReduction | null);
  if (r.value == null) return notMeasured(r.reason);
  return measured(r.value, 'percent', { textOverride: r.text });
}

/**
 * What one cell may say, from the answers of its requests (see {@link bindingRequests}).
 * A cell fails when one request failed with nothing held (and still says so while that
 * request is read again, until a read succeeds), waits while a request is still loading
 * its first answer, and otherwise the honesty rules above decide.
 */
export function evaluateBinding(binding: KpiStripBinding, read: KpiReader, ctx: KpiEvalContext): KpiCellResult {
  const reqs = bindingRequests(binding);
  const answers = reqs.map(read);
  if (answers.some((a) => a.data == null && a.error != null)) return failed();
  if (answers.some((a) => a.data == null && a.loading)) return LOADING;
  if (answers.some((a) => a.data == null)) return notMeasured(null);
  const source: KpiCellSource = binding.source;
  switch (source.type) {
    case 'field':
      return evalField(binding, source, answers[0].data);
    case 'breakdown_group':
      return evalBreakdownGroup(binding, source, answers[0].data);
    case 'breakdown_sum':
      return evalBreakdownSum(binding, source, answers[0].data);
    case 'sources_health':
      return evalSourcesHealth(binding, source.count, answers[0].data, ctx);
    case 'stage_reduction':
      return evalStageReduction(answers[0].data);
    case 'ratio': {
      const num = breakdownSum(source.numerator, answers[0].data);
      const den = breakdownSum(source.denominator, answers[1].data);
      if (num.value == null || den.value == null) return notMeasured(null);
      if (!num.exact || !den.exact) {
        return notMeasured(num.reason ?? den.reason ?? 'Part of the spend or the cases could not be counted exactly.');
      }
      if (den.value <= 0) return notMeasured('No case was investigated in the window.');
      return measured(num.value / den.value, binding.format);
    }
    default:
      return notMeasured(null);
  }
}
