/**
 * RuleSheet: one detection rule's picture (Round 14, SPEC §4.6.4, operator choice C4
 * option A). Loaded lazily by `RuleLink` / `useRuleSheet`; never imported statically.
 *
 * A modal side sheet from the right, 46rem wide and the whole screen below 640px (it is a
 * destination, not an inspector), on the side-pane timings (200ms to open, 160ms to close,
 * `ease-standard`). Focus moves to the title when it opens and back to the link that
 * opened it when it closes (to the same rule's link or the main region when a refresh
 * removed it, to the main region when it closed to go somewhere); Esc closes it. A modal
 * owns the keyboard: no key typed in it reaches a shortcut of the surface behind it, and
 * Tab moves through the chart like any other tab stop. A newly chosen window is announced
 * once its figures land.
 *
 * What it shows, in tab order:
 *   1. The header: where it was opened ("From CASE-000214"), the rule as the title (plain
 *      mono text that wraps, never a link), the window (`TimeRangePicker`, default the
 *      opener's window or the last 3 days) and the source when the sheet is filtered to one.
 *   2. Key figures on one strip (the Overview KPI grammar): Alerts in the window ("381",
 *      or a floor when the count is a lower bound), and, for every case the rule ever
 *      opened (all time, the population "Show the N cases" opens), Cases, Still open (once
 *      the rule has opened a case) and the analyst outcome (only the analyst family:
 *      confirmed, benign, not graded; a case closed without an analyst classification is
 *      not graded, so never "waiting"). Under the strip: when the rule was last and first
 *      seen.
 *   3. The actions: "Open all N in Logs" (the exact filtered Logs view; the number only
 *      when the count is exact, so the button never names a count Logs may not show),
 *      "Show the N cases" and "Ask AI about this rule" (the fenced rule question, an
 *      ordinary metered chat turn).
 *   4. Sections, each with its own loading, empty and permission line: alerts over time by
 *      severity, top source IPs, top targets, the latest alerts (read from
 *      `GET /api/logs?rule=`, shown to the person only and never sent to a model, #7), the
 *      cases from the rule, and the rule's facts (where it is defined, tuning, analyst
 *      policy). When no source holds an alert from the rule in the window, or no source can
 *      be read at all, the alerts section says so once and the three sections drawn from
 *      those alerts are left out; the sheet never states a zero it did not count.
 *
 * Every figure comes from `GET /api/rules/summary`, whose sections each check their own
 * grant and carry their own status, so a missing grant or a failing store degrades one
 * section, never the sheet. No model call happens here (#6).
 *
 * SECURITY (#9): the rule value, IPs, hosts, users, titles, messages and every reason the
 * server sends are untrusted plain text: text nodes and attribute values only, never
 * markup. Links are built by the router (`pageHash`) and checked by `safeRouteHref`.
 */
import * as React from 'react';
import { ListFilter, Settings2, SlidersHorizontal, Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtNumber, fmtPercent, humanizeAge, humanizeToken } from '@/lib/format';
import { getRuleSummary } from '@/lib/api-rules';
import type {
  RuleCaseRow,
  RuleSectionStatus,
  RuleSeveritySeries,
  RuleSummary,
  RuleSummaryAnalystPolicy,
  RuleSummaryDefinition,
  RuleSummaryTopList,
  RuleSummaryTuning,
  SeverityLevel,
} from '@/lib/types-rules';
import { LoadingBar, LoadingState, SectionTitle } from '@/design-system';
import { Badge } from '@/ui/badge';
import { buttonVariants } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { useOptionalAuth } from '@/soc/auth';
import { isSafeCaseId } from '@/soc/case-result-route';
import { useDemo } from '@/soc/demo';
import { pageHash, settingsSectionHash, useNavigateOptional } from '@/soc/router';
import { hashRoute, safeRouteHref } from '@/soc/route-link';
import { fetchUnifiedLogs, type UnifiedLogRow } from '@/soc/UnifiedLogs.api';
import { CartesianChart, type CartesianKind } from '@/soc/chat/blocks/charts/CartesianChart';
import { parseBlocks, type ChartBlock } from '@/soc/chat/blocks/schema';

import { askEntityValue } from './ask-ai';
import { AiVerdictChip, SeverityBadge, StatusBadge } from './badges';
import { KpiStrip } from './KpiStrip';
import { KpiTile } from './KpiTile';
import { LoadError } from './LoadError';
import { PRESETS, type TimeRange, TimeRangePicker } from './TimeRangePicker';
import { keepKeysInSheet, type RuleSheetRequest, type RuleSheetWindow } from './rule-sheet-store';

/* ------------------------------------------------------------------ helpers -- */

/** The windows the sheet offers (the opener's own window stays shown when it is another). */
export const RULE_SHEET_PRESETS: readonly TimeRange[] = [
  PRESETS.find((p) => p.from === 'now-24h') ?? { from: 'now-24h', to: 'now', label: 'Last 24 hours' },
  { from: 'now-3d', to: 'now', label: 'Last 3 days' },
  PRESETS.find((p) => p.from === 'now-7d') ?? { from: 'now-7d', to: 'now', label: 'Last 7 days' },
  PRESETS.find((p) => p.from === 'now-30d') ?? { from: 'now-30d', to: 'now', label: 'Last 30 days' },
];

/** The sheet's default window (SPEC §4.6.2): the last 3 days. */
export const DEFAULT_RULE_WINDOW: TimeRange = RULE_SHEET_PRESETS[1];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function utcDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** "Oct 22" (the chart kit's day format), with the year when it is not this year. */
export function utcDay(iso: string | null | undefined, now: Date = new Date()): string | null {
  const d = utcDate(iso);
  if (!d) return null;
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day}, ${d.getUTCFullYear()}`;
}

/** "14:02" in UTC. */
function utcClock(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Oct 25 06:12" in UTC (the latest alerts column). */
export function utcDayTime(iso: string | null | undefined, now: Date = new Date()): string | null {
  const d = utcDate(iso);
  if (!d) return null;
  return `${utcDay(iso, now)} ${utcClock(d)}`;
}

/** "Last seen 14:02 UTC · first seen Oct 22", or as much of it as is known. */
export function seenLine(
  lastSeen: string | null | undefined,
  firstSeen: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const last = utcDate(lastSeen);
  const parts: string[] = [];
  if (last) {
    const sameDay =
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCDate() === now.getUTCDate();
    parts.push(`Last seen ${sameDay ? utcClock(last) : utcDayTime(lastSeen, now)} UTC`);
  }
  const first = utcDay(firstSeen, now);
  if (first) parts.push(parts.length ? `first seen ${first}` : `First seen ${first}`);
  return parts.length ? parts.join(' · ') : null;
}

/** An absolute window shorter than this names its times as well as its days. */
const SHORT_WINDOW_MS = 48 * 3_600_000;

/** A readable label for a window that is not one of the presets. */
export function windowLabel(range: RuleSheetWindow): string {
  if (range.label) return range.label;
  const preset = [...RULE_SHEET_PRESETS, ...PRESETS].find((p) => p.from === range.from && p.to === range.to);
  if (preset) return preset.label;
  const relative = /^now-(\d{1,5})([mhdw])$/.exec(range.from);
  if (relative && range.to === 'now') {
    const n = Number(relative[1]);
    const unit = { m: 'minute', h: 'hour', d: 'day', w: 'week' }[relative[2] as 'm' | 'h' | 'd' | 'w'];
    return `Last ${fmtNumber(n)} ${unit}${n === 1 ? '' : 's'}`;
  }
  // A window of minutes or hours (a case's own window) names its times, so the picker
  // says which minutes are counted: "Oct 29, 12:14 to 12:17 UTC", "Oct 28 22:10 to Oct 29
  // 01:05 UTC". A longer one names its days.
  const start = utcDate(range.from);
  const end = range.to === 'now' ? null : utcDate(range.to);
  if (start && end && end.getTime() >= start.getTime() && end.getTime() - start.getTime() < SHORT_WINDOW_MS) {
    const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
    return sameDay
      ? `${utcDay(range.from)}, ${utcClock(start)} to ${utcClock(end)} UTC`
      : `${utcDayTime(range.from)} to ${utcDayTime(range.to)} UTC`;
  }
  const from = utcDay(range.from);
  const to = range.to === 'now' ? 'now' : utcDay(range.to);
  if (from && to) return `${from} to ${to}`;
  return 'Custom window';
}

/**
 * The window's label everywhere in the sheet (the picker, the Alerts tile, the polite
 * line): a relative window takes the server's label; an absolute one (a case's own
 * window, opened from a case card) keeps the picker's, so one header never shows the same
 * window in two date formats.
 */
export function shownWindowLabel(serverLabel: string | null | undefined, range: TimeRange): string {
  if (!/^now\b/.test(range.from)) return range.label;
  return serverLabel || range.label;
}

/** The sheet's starting window: the opener's, else the last 3 days. */
export function initialRuleWindow(window: RuleSheetWindow | undefined): TimeRange {
  if (!window || !window.from || !window.to) return DEFAULT_RULE_WINDOW;
  return { from: window.from, to: window.to, label: windowLabel(window) };
}

/**
 * The `window` query of `GET /api/rules/summary` (the Round 12 window grammar): a relative
 * window ending now is sent as itself (`now-3d`), anything else as a range (`A..B`).
 */
export function windowParam(range: Pick<TimeRange, 'from' | 'to'>): string {
  if (range.to === 'now' && /^now-\d{1,5}[mhdwMy]$/.test(range.from)) return range.from;
  return `${range.from}..${range.to}`;
}

/**
 * "in the last 3 days", "in the last hour", "at any time", "in Oct 22 to Oct 25": the
 * window inside a sentence. A count of one reads as the unit alone ("Last 1 hour" is "in
 * the last hour").
 */
export function windowPhrase(label: string): string {
  const text = label.trim();
  if (!text) return 'in this window';
  if (/^all time/i.test(text)) return 'at any time';
  const one = /^last 1 (minute|hour|day|week|month|year)$/i.exec(text);
  if (one) return `in the last ${one[1].toLowerCase()}`;
  if (/^last /i.test(text)) return `in the ${text[0].toLowerCase()}${text.slice(1)}`;
  if (/^(this|today|yesterday)\b/i.test(text)) return `${text[0].toLowerCase()}${text.slice(1)}`;
  return `in ${text}`;
}

/** "12 h", "30 min", "1-day" for a series bucket ("12h", "30m", "1d"). */
export function bucketWords(bucket: string): string {
  const match = /^(\d{1,4})([mhd])$/.exec(bucket.trim());
  if (!match) return bucket;
  const n = Number(match[1]);
  if (match[2] === 'm') return `${n} min`;
  if (match[2] === 'h') return `${n} h`;
  return `${n}-day`;
}

/**
 * The count "Open all N in Logs" may name: only an exact count from sources that all
 * applied the rule filter exactly (`count_relation` is `eq`, never keyed on `status`: a
 * sampled chart can still carry an exact count). Otherwise null, and the label says
 * "Open in Logs" with no number.
 */
export function exactAlertCount(summary: RuleSummary | null): number | null {
  const alerts = summary?.alerts;
  if (!alerts || alerts.status === 'forbidden' || alerts.status === 'unavailable') return null;
  if (alerts.count_relation !== 'eq' || typeof alerts.count !== 'number') return null;
  if (alerts.sources.some((s) => !s.exact)) return null;
  return alerts.count;
}

/** The label of the main action. */
export function openInLogsLabel(count: number | null): string {
  return count !== null && count > 0 ? `Open all ${fmtNumber(count)} in Logs` : 'Open in Logs';
}

/**
 * The polite line read once a window chosen in the sheet has its figures: "Last 7 days:
 * 381 alerts from this rule.", "at least 1,000" for a floor, "no alerts" only when the
 * count is exact, and no figure at all when the alerts could not be read.
 */
export function windowAnnouncement(summary: RuleSummary | null, failed: boolean, label: string): string {
  const when = label.trim() || 'This window';
  if (!summary) return failed ? `${when}: this rule could not be loaded.` : '';
  const alerts = summary.alerts;
  const counted =
    alerts.status !== 'forbidden' &&
    alerts.status !== 'unavailable' &&
    !!alerts.series &&
    typeof alerts.count === 'number';
  if (!counted || typeof alerts.count !== 'number') return `${when}: the alert figures are not available.`;
  const count = alerts.count;
  if (alerts.count_relation === 'gte') {
    return count > 0
      ? `${when}: at least ${fmtNumber(count)} alert${count === 1 ? '' : 's'} from this rule.`
      : `${when}: no alerts from this rule were found.`;
  }
  if (count === 0) return `${when}: no alerts from this rule.`;
  return `${when}: ${fmtNumber(count)} alert${count === 1 ? '' : 's'} from this rule.`;
}

/** The Logs view with an exact "Rule is" filter over the sheet's window. */
export function ruleLogsHref(rule: string, from: string, to: string, sourceId?: string): string {
  return pageHash('logs', { rule, from, to, ...(sourceId ? { sourceId } : {}) });
}

/** The longest window the Logs page reads (its `MAX_WINDOW_MS`): 90 days. */
export const LOGS_MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const REL_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS, M: 30 * DAY_MS, y: 365 * DAY_MS };

/** Epoch ms of a window bound (`now`, `now-<n><unit>`, ISO-8601), else null. */
function windowBoundMs(value: string, now: number): number | null {
  if (value === 'now') return now;
  const rel = /^now-(\d{1,5})([mhdwMy])$/.exec(value);
  if (rel) return now - Number(rel[1]) * REL_UNIT_MS[rel[2]];
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How much of the sheet's window the main action opens in Logs:
 *  - `window`: all of it (it fits the 90 days Logs reads);
 *  - `last_90_days`: its last 90 days;
 *  - `to_last_alert`: the 90 days up to the rule's last alert, when that alert is older
 *    than the last 90 days (those would hold nothing from the rule);
 *  - `from_start_to_last_alert`: the window's start up to the rule's last alert, when that
 *    is shorter than 90 days.
 */
export type LogsReach = 'window' | 'last_90_days' | 'to_last_alert' | 'from_start_to_last_alert';

export interface LogsWindow {
  from: string;
  to: string;
  reach: LogsReach;
}

/**
 * The window the main action opens Logs on: the sheet's own window when it fits the 90
 * days Logs reads, else the last 90 days of it, so the action never opens a view Logs
 * would refuse and never names a count of alerts Logs cannot show. When the rule's last
 * alert (`lastSeen`, read from the sheet's own figures) is older than those 90 days, the
 * view ends one minute after that alert instead, so it never opens on a view that can
 * only be empty under a tile counting the rule's alerts.
 */
export function logsWindow(from: string, to: string, now: number = Date.now(), lastSeen: string | null = null): LogsWindow {
  const start = windowBoundMs(from, now);
  const end = windowBoundMs(to, now);
  if (start === null || end === null || end - start <= LOGS_MAX_DAYS * DAY_MS) return { from, to, reach: 'window' };
  const lastStart = end - LOGS_MAX_DAYS * DAY_MS;
  const last = lastSeen ? Date.parse(lastSeen) : NaN;
  if (Number.isFinite(last) && last >= start && last < lastStart) {
    const until = last + 60_000;
    const since = Math.max(start, until - LOGS_MAX_DAYS * DAY_MS);
    return {
      from: new Date(since).toISOString(),
      to: new Date(until).toISOString(),
      reach: since > start ? 'to_last_alert' : 'from_start_to_last_alert',
    };
  }
  return { from: to === 'now' ? `now-${LOGS_MAX_DAYS}d` : new Date(lastStart).toISOString(), to, reach: 'last_90_days' };
}

/**
 * The main action's label and, when Logs opens on less than the sheet's window, the one
 * line under it that says why. A count is named only for the whole window (`exact`).
 */
export function logsActionCopy(reach: LogsReach, exact: number | null): { label: string; note: string | null } {
  const limit = `Logs reads at most ${LOGS_MAX_DAYS} days at a time`;
  switch (reach) {
    case 'last_90_days':
      return {
        label: `Open the last ${LOGS_MAX_DAYS} days in Logs`,
        note: `${limit}, so it opens on the last ${LOGS_MAX_DAYS} days of this window.`,
      };
    case 'to_last_alert':
      return {
        label: `Open ${LOGS_MAX_DAYS} days up to the last alert in Logs`,
        note: `${limit}, so it opens on the ${LOGS_MAX_DAYS} days up to this rule's last alert.`,
      };
    case 'from_start_to_last_alert':
      return {
        label: 'Open up to the last alert in Logs',
        note: `${limit}, so it opens on this window up to this rule's last alert.`,
      };
    default:
      return { label: openInLogsLabel(exact), note: null };
  }
}

const LEVEL_LABEL: Record<SeverityLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};
const LEVEL_ORDER: readonly SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * A tick label: the day for a day bucket or a midnight, the time of day otherwise; the
 * first bucket of a sub-day series names its day too, so every chart says which day it
 * starts on ("Oct 28 18:30", "18:45", "19:00").
 */
function bucketLabel(iso: string, bucketMs: number, now: Date, index: number): string {
  const d = utcDate(iso);
  if (!d) return iso;
  const day = utcDay(iso, now) ?? iso;
  if (bucketMs >= 86_400_000 || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return day;
  return index === 0 ? `${day} ${utcClock(d)}` : utcClock(d);
}

function bucketMillis(bucket: string): number {
  const match = /^(\d{1,4})([mhd])$/.exec(bucket.trim());
  if (!match) return 3_600_000;
  return Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[match[2] as 'm' | 'h' | 'd'];
}

/**
 * The stacked severity chart (the chat chart kit, so it shares its keyboard reading,
 * tooltips and dated ticks), or null when no level has an alert. Levels without an alert
 * are left out of the legend; the order is always Critical to Info.
 */
export function alertsChartBlock(
  series: RuleSeveritySeries | null | undefined,
  { inProgress = false, now = new Date() }: { inProgress?: boolean; now?: Date } = {},
): (ChartBlock & { kind: CartesianKind }) | null {
  if (!series || !series.points.length) return null;
  const levels = LEVEL_ORDER.filter((level) => series.points.some((p) => (p[level] ?? 0) > 0));
  if (!levels.length) return null;
  const bucketMs = bucketMillis(series.bucket);
  const { blocks } = parseBlocks([
    {
      id: 'rule-alerts',
      type: 'chart',
      kind: 'stacked_bar',
      title: 'Alerts over time',
      provenance: 'source',
      artifact_kind: 'series',
      allowed_views: ['stacked_bar', 'table'],
      unit: 'count',
      x: {
        kind: 'time',
        values: series.points.map((p) => p.t),
        labels: series.points.map((p, index) => bucketLabel(p.t, bucketMs, now, index)),
        tz: 'UTC',
      },
      series: levels.map((level) => ({
        key: level,
        label: LEVEL_LABEL[level],
        semantic: level,
        values: series.points.map((p) => p[level] ?? 0),
      })),
      last_in_progress: inProgress,
    },
  ]);
  const block = blocks[0];
  return block && block.type === 'chart' && block.kind === 'stacked_bar'
    ? (block as ChartBlock & { kind: CartesianKind })
    : null;
}

const TUNING_CHANGE: Record<string, string> = {
  correlation_n: 'Raise the correlation threshold',
  severity_floor: 'Raise the severity floor',
  suppression: 'Suppress the rule',
};

/**
 * Tuner findings that change no threshold (`before` equals `after`): they ask for review
 * or for evidence, so they are worded as what they are, never as "from 3 to 3".
 */
const TUNING_FINDING: Record<string, string> = {
  evidence_collection: 'Needs more analyst-graded cases before a change can be proposed.',
  correlation_n_inert: 'Raising the correlation threshold would change nothing here; tune the feed or the source instead.',
};

function plainValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return fmtNumber(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return null;
}

/** The tuner's proposal in one plain sentence, or null. */
export function tuningChangeText(change: Record<string, unknown> | null | undefined): string | null {
  if (!change || typeof change !== 'object') return null;
  const kind = typeof change.kind === 'string' ? change.kind : '';
  const finding = TUNING_FINDING[kind];
  if (finding) return finding;
  const what = TUNING_CHANGE[kind] ?? (kind ? humanizeToken(kind) : 'A change');
  const before = plainValue(change.before);
  const after = plainValue(change.after);
  // A span only when something changes: "from 3 to 3" is no change.
  const span = before !== null && after !== null && before !== after ? ` from ${before} to ${after}` : '';
  const gate = change.shadow_blocked === true
    ? ', held because it would hide a confirmed threat'
    : change.requires_approval === true || change.auto_apply === false
      ? ', waiting for approval'
      : '';
  return `${what}${span}${gate}.`;
}

/* -------------------------------------------------------------------- hooks -- */

interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** The key the shown answer was read for (null before the first one lands). */
  answered: string | null;
  reload: () => void;
}

/**
 * One read keyed by `key` (null: none), answered under the Demo `identity` it was read
 * for. A new key under the same identity reads again and keeps the last answer on screen
 * until the new one lands (a refresh, not a blank sheet); a stale answer never replaces a
 * newer one. An answer read under another identity is never shown, not even for one
 * frame: after a confirmed Demo switch the sheet reads as loading until the new identity's
 * answer lands (SPEC §3.5: no real figures under the Demo badge, or the reverse).
 */
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, identity: number): Loaded<T> {
  const [state, setState] = React.useState<{
    data: T | null;
    error: unknown;
    loading: boolean;
    identity: number;
    answered: string | null;
  }>({
    data: null,
    error: null,
    loading: key !== null,
    identity,
    answered: null,
  });
  const [nonce, setNonce] = React.useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const identityRef = React.useRef(identity);
  identityRef.current = identity;
  React.useEffect(() => {
    if (key === null) return undefined;
    const controller = new AbortController();
    const readFor = identityRef.current;
    setState((prev) => ({ ...prev, loading: true }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false, identity: readFor, answered: key });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, error, loading: false, identity: readFor, answered: key });
      },
    );
    return () => controller.abort();
  }, [key, nonce]);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  const current = state.identity === identity;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: current ? state.loading : key !== null,
    answered: current ? state.answered : null,
    reload,
  };
}

/**
 * A token that changes when a CONFIRMED Demo status names another identity than the one
 * before (Demo entered, left or reset), so the sheet never keeps real figures under the
 * Demo badge or the reverse. A failed status read (the OFF stand-in) changes nothing.
 */
function useDemoSwitchToken(): number {
  const demo = useDemo();
  const confirmed = demo.confirmed !== false;
  const identity = `${demo.active ? 'on' : 'off'}:${demo.status.run_id ?? ''}`;
  const ref = React.useRef<{ identity: string | null; token: number }>({ identity: null, token: 0 });
  if (confirmed && ref.current.identity !== identity) {
    ref.current = { identity, token: ref.current.identity === null ? 0 : ref.current.token + 1 };
  }
  return ref.current.token;
}

const ALLOW_ALL = () => true;

/**
 * The viewer's permission check, or allow-all outside the auth shell (an embed with no
 * provider). The server checks every section's grant again; this only hides what the
 * viewer could not use.
 */
function usePermission(): (resource: string, action: string) => boolean {
  return useOptionalAuth()?.hasPermission ?? ALLOW_ALL;
}

/** The HTTP status of a failed read, when it has one. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/* ----------------------------------------------------------------- sections -- */

const NOTE = 'text-sm text-muted-foreground';

const ACCESS_LINE: Record<'sources' | 'cases' | 'rules' | 'automation', string> = {
  sources: 'You do not have access to log sources.',
  cases: 'You do not have access to cases.',
  rules: 'You do not have access to detection rules.',
  automation: 'You do not have access to tuning.',
};

function Section({
  id,
  title,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = `${id}-title`;
  return (
    <section aria-labelledby={headingId} className={cn('min-w-0 border-t border-border/70 pt-4', className)}>
      {/* The one module title style (SPEC §4.9.2), an h3 under the sheet's title. */}
      <SectionTitle level={3} id={headingId} title={title} aside={aside} className="mb-2" />
      {children}
    </section>
  );
}

/** A section line for a status that has no data: access, an error or a reason. */
function StatusLine({
  status,
  reason,
  grant,
  fallback,
}: {
  status: RuleSectionStatus;
  reason: string | null | undefined;
  grant: keyof typeof ACCESS_LINE;
  fallback: string;
}) {
  const text = status === 'forbidden' ? ACCESS_LINE[grant] : reason || fallback;
  return (
    <p className={NOTE} data-section-status={status}>
      {text}
    </p>
  );
}

function CountList({ list, empty, label }: { list: RuleSummaryTopList; empty: string; label: string }) {
  if (list.status === 'forbidden' || (list.status === 'unavailable' && !list.rows.length)) {
    return (
      <StatusLine
        status={list.status}
        reason={list.reason}
        grant="sources"
        fallback="These values could not be read right now."
      />
    );
  }
  if (!list.rows.length) {
    return (
      <>
        <p className={NOTE}>{empty}</p>
        {list.reason ? <p className={cn(NOTE, 'mt-2 text-xs')}>{list.reason}</p> : null}
      </>
    );
  }
  const max = Math.max(1, ...list.rows.map((r) => r.count));
  return (
    <>
      <ul className="space-y-2" aria-label={label}>
        {list.rows.map((row, index) => (
          <li key={`${row.kind ?? ''}:${row.value}:${index}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate font-mono text-xs text-foreground" title={row.value}>
                  {row.value}
                </span>
                {row.kind ? <span className="shrink-0 text-xs text-muted-foreground">{row.kind}</span> : null}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-foreground">{fmtNumber(row.count)}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-accent-bar" style={{ width: `${(row.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {list.reason ? <p className={cn(NOTE, 'mt-2 text-xs')}>{list.reason}</p> : null}
    </>
  );
}

/**
 * A top list's caption: "sampled" when it was drawn from each source's newest events, "not
 * exact" when a count may be low or a value missing (the reason under it says why).
 */
function topListAside(list: RuleSummaryTopList): string | undefined {
  if (list.status === 'forbidden' || !list.rows.length || list.exact) return undefined;
  if (list.status === 'unsupported') return 'sampled';
  return list.status === 'ok' ? 'not exact' : undefined;
}

function LatestAlerts({
  rows,
  loading,
  error,
  denied,
  emptyText,
}: {
  rows: UnifiedLogRow[];
  loading: boolean;
  error: unknown;
  denied: boolean;
  emptyText: string;
}) {
  if (denied) return <p className={NOTE}>{ACCESS_LINE.sources}</p>;
  if (loading && !rows.length) {
    return <LoadingState layout="inline" label="Loading the latest alerts" />;
  }
  if (error && !rows.length) {
    return <p className={NOTE}>The latest alerts could not be read right now.</p>;
  }
  if (!rows.length) return <p className={NOTE}>{emptyText}</p>;
  return (
    <Table aria-label="Latest alerts" layout="fixed" unwrapped>
      <TableHeader className="bg-transparent">
        <TableRow className="hover:bg-transparent">
          <TableHead density="compact" className="h-8 w-[6.5rem] px-1">
            Time (UTC)
          </TableHead>
          <TableHead density="compact" className="h-8 w-[7.5rem] px-1">
            Severity
          </TableHead>
          <TableHead density="compact" className="h-8 w-32 px-1 max-sm:hidden">
            Source IP
          </TableHead>
          <TableHead density="compact" className="h-8 px-1">
            Message
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.source_id}:${row.id}:${index}`}>
            <TableCell density="compact" numeric className="px-1 align-top text-xs text-muted-foreground">
              {utcDayTime(row.ts) ?? row.ts}
            </TableCell>
            <TableCell density="compact" className="px-1 align-top">
              <SeverityBadge severity={row.severity} showValue className="px-1.5 py-0 text-2xs" />
            </TableCell>
            <TableCell density="compact" className="truncate px-1 align-top font-mono text-xs text-foreground max-sm:hidden">
              {row.source_ip ?? ''}
            </TableCell>
            <TableCell density="compact" className="min-w-0 px-1 align-top font-mono text-xs text-foreground">
              <span className="block truncate" title={row.message}>
                {row.message}
              </span>
              {row.source_ip ? (
                <span className="block truncate text-muted-foreground sm:hidden">{row.source_ip}</span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CaseList({
  rows,
  onNavigate,
}: {
  rows: RuleCaseRow[];
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return (
    <ul className="-mx-2 flex flex-col" aria-label="Newest cases from this rule">
      {rows.map((row) => {
        const href = isSafeCaseId(row.case_id) ? safeRouteHref(pageHash('case_manager', { caseId: row.case_id })) : undefined;
        const label = row.case_number || row.case_id;
        const body = (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">{row.title || label}</span>
              <span className="font-mono text-xs text-primary">{label}</span>
            </span>
            {row.status ? <StatusBadge status={row.status} icon={false} className="shrink-0 px-1.5 py-0 text-2xs" /> : null}
            {/* The AI verdict, attributed as such (an outline chip with the Bot glyph and
                "AI verdict"): beside the Analyst outcome tile it must never read as an
                analyst outcome. A phone keeps the attribution in the glyph, the title and
                the screen-reader text. */}
            {row.verdict ? (
              <AiVerdictChip
                verdict={row.verdict}
                className="shrink-0 px-1.5 py-0 text-2xs"
                labelClassName="max-sm:hidden"
              />
            ) : null}
          </>
        );
        return (
          <li key={row.case_id}>
            {href ? (
              <a
                href={href}
                onClick={(event) => onNavigate(event, href)}
                className="flex w-full min-w-0 items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </a>
            ) : (
              <div className="flex w-full min-w-0 items-center gap-3 px-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DefinitionFact({ definition }: { definition: RuleSummaryDefinition }) {
  if (definition.status !== 'ok') {
    return <>{definition.status === 'forbidden' ? ACCESS_LINE.rules : definition.reason || 'The rule settings could not be read.'}</>;
  }
  if (definition.kind === 'suite' && definition.suite_rule) {
    const rule = definition.suite_rule;
    return (
      <>
        A suite rule, <span className="font-medium">{rule.name}</span>, {rule.enabled ? 'enabled' : 'disabled'}
        {rule.description ? <span className="block text-muted-foreground">{rule.description}</span> : null}
      </>
    );
  }
  return <>The source SIEM, not a suite rule</>;
}

function TuningFact({ tuning }: { tuning: RuleSummaryTuning }) {
  if (tuning.status !== 'ok') {
    return <>{tuning.status === 'forbidden' ? ACCESS_LINE.automation : tuning.reason || 'Tuning history could not be read right now.'}</>;
  }
  const samples = tuning.samples ?? 0;
  const change = tuningChangeText(tuning.proposed_change);
  return (
    <>
      {samples > 0 && typeof tuning.wilson_lower_bound === 'number'
        ? // "Graded", never "confirmed": the samples are every case an analyst classified,
          // benign or not, and "confirmed" on the strip means confirmed true positives.
          `False-positive rate at least ${fmtPercent(tuning.wilson_lower_bound)}, from ${fmtNumber(samples)} analyst-graded case${samples === 1 ? '' : 's'}`
        : 'No analyst-graded cases yet'}
      {change ? <span className="block">{change}</span> : null}
      {tuning.last_tuned ? <span className="block text-muted-foreground">Last tuned {humanizeAge(tuning.last_tuned)}</span> : null}
    </>
  );
}

function PolicyFact({ policy }: { policy: RuleSummaryAnalystPolicy }) {
  if (policy.status !== 'ok') {
    return <>{policy.status === 'forbidden' ? ACCESS_LINE.rules : policy.reason || 'The analyst policies could not be read.'}</>;
  }
  const body = policy.policy;
  if (!body) return <>No analyst policy applies.</>;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
  const expires = typeof body.expires_at === 'string' ? utcDay(body.expires_at) : null;
  const by = typeof body.created_by === 'string' && body.created_by.trim() ? body.created_by.trim() : null;
  return (
    <>
      Declared benign{reason ? `: ${reason}` : ''}
      {by || expires ? (
        <span className="block text-muted-foreground">
          {[by ? `by ${by}` : null, expires ? `until ${expires}` : null].filter(Boolean).join(', ')}
        </span>
      ) : null}
    </>
  );
}

/**
 * The tab stops inside `root` in document order (the dialog focus-trap rule: focusable,
 * not disabled or hidden, a non-negative tab index), leaving out anything not rendered.
 */
function tabStops(root: HTMLElement): HTMLElement[] {
  const stops: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as HTMLElement & {
        disabled?: boolean;
        checkVisibility?: (options?: Record<string, boolean>) => boolean;
      };
      if (element.disabled || element.hidden || element.tabIndex < 0) return NodeFilter.FILTER_SKIP;
      if (element instanceof HTMLInputElement && element.type === 'hidden') return NodeFilter.FILTER_SKIP;
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ visibilityProperty: true })) {
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) stops.push(walker.currentNode as HTMLElement);
  return stops;
}

/**
 * Keeps Tab moving through the chart (SPEC §3.3, focus order). The chart kit clears its
 * focus ring and tooltip as focus leaves the plot; a browser applies that change between
 * the plot's blur and the next element's focus, and the dialog's focus trap, finding focus
 * on the page body for that moment, pulls it back to the sheet, so Tab could never get
 * past the chart. Moving focus here, inside the key handler, lands it on the next tab stop
 * before that change is applied. Shift+Tab goes back the same way; the ends wrap, as the
 * trap does.
 */
function ChartTabStops({ children }: { children: React.ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- not a control: it only carries Tab on from the chart's own tab stops
    <div
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
        const from = document.activeElement;
        const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
        if (!dialog || !(from instanceof HTMLElement) || !event.currentTarget.contains(from)) return;
        const stops = tabStops(dialog);
        const index = stops.indexOf(from);
        if (index < 0 || stops.length < 2) return;
        event.preventDefault();
        event.stopPropagation();
        stops[(index + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
      }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------- sheet -- */

export interface RuleSheetProps {
  /** The DOM id of the sheet (the opener's `aria-controls`). */
  id: string;
  request: RuleSheetRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element to give focus back to when the sheet closes. */
  returnFocusTo?: () => HTMLElement | null;
}

/** The side-pane timings (ui-standard "Motion and loading"): 200ms open, 160ms close. */
function paneMotion(open: boolean): React.CSSProperties {
  return {
    animationDuration: open ? '200ms' : '160ms',
    animationTimingFunction: 'var(--motion-ease-standard, cubic-bezier(0.2, 0, 0, 1))',
  };
}

export function RuleSheet({ id, request, open, onOpenChange, returnFocusTo }: RuleSheetProps) {
  const { rule, sourceId, origin } = request;
  const [range, setRange] = React.useState<TimeRange>(() => initialRuleWindow(request.window));
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const can = usePermission();
  const navigate = useNavigateOptional();
  const demoToken = useDemoSwitchToken();
  const windowArg = windowParam(range);

  const summaryKey = open ? JSON.stringify(['summary', rule, windowArg, sourceId ?? '', demoToken]) : null;
  const summary = useLoad<RuleSummary>(
    summaryKey,
    (signal) => getRuleSummary({ rule, window: windowArg, ...(sourceId ? { source_id: sourceId } : {}) }, signal),
    demoToken,
  );
  const logsAllowed = can('sources', 'read');
  const latestKey = open && logsAllowed ? JSON.stringify(['latest', rule, range.from, range.to, sourceId ?? '', demoToken]) : null;
  const latest = useLoad(
    latestKey,
    () =>
      fetchUnifiedLogs({
        rule,
        from: range.from,
        to: range.to,
        limit: 5,
        ...(sourceId ? { source_id: sourceId } : {}),
      }),
    demoToken,
  );

  /**
   * A window chosen in the sheet: once its figures land, one polite line says what they
   * now show (SPEC §3.3), for a person who cannot see the strip change. The first load is
   * not announced: the title and the figures are read as the dialog opens.
   */
  const [announcement, setAnnouncement] = React.useState('');
  const [announceFor, setAnnounceFor] = React.useState<string | null>(null);
  const chooseWindow = React.useCallback((next: TimeRange) => {
    setAnnouncement('');
    setAnnounceFor(JSON.stringify([next.from, next.to]));
    setRange(next);
  }, []);
  const rangeKey = JSON.stringify([range.from, range.to]);
  React.useEffect(() => {
    if (announceFor === null || announceFor !== rangeKey) return;
    // Only the answer read for this window, never the last one still on screen.
    if (summary.loading || summary.answered !== summaryKey) return;
    setAnnounceFor(null);
    setAnnouncement(windowAnnouncement(summary.data, summary.error !== null, shownWindowLabel(summary.data?.window.label, range)));
  }, [announceFor, rangeKey, summary.loading, summary.answered, summary.data, summary.error, summaryKey, range]);

  /**
   * Set when the sheet closes to go somewhere (an action or a case link), with the hash it
   * left from: focus then follows the navigation instead of going back to an opener the
   * new screen no longer shows (see `onCloseAutoFocus`).
   */
  const leavingRef = React.useRef<{ hash: string } | null>(null);
  const leave = React.useCallback(() => {
    leavingRef.current = { hash: typeof window === 'undefined' ? '' : window.location.hash };
    onOpenChange(false);
  }, [onOpenChange]);
  /**
   * A link inside the sheet: a plain click closes the sheet, then goes through the router
   * (so a route-leave guard asks first); a modified click (a new tab) keeps the browser's
   * own behaviour and leaves the sheet open.
   */
  const navigateFromSheet = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const route = hashRoute(href);
      leave();
      if (!route) return;
      event.preventDefault();
      navigate(route.page, route.opts);
    },
    [leave, navigate],
  );

  const data = summary.data;
  const alerts = data?.alerts ?? null;
  const cases = data?.cases ?? null;
  const resolvedFrom = data?.window.from || range.from;
  const resolvedTo = data?.window.to || range.to;
  const label = shownWindowLabel(data?.window.label, range);
  const inWindow = windowPhrase(label);
  const exact = exactAlertCount(data);
  // Logs reads at most 90 days: a longer window opens on its last 90 days (or the 90 days
  // up to the rule's last alert when that is older), with no count and a line saying why.
  const lastSeen = alerts && alerts.status !== 'forbidden' ? alerts.last_seen ?? null : null;
  const logsRange = logsWindow(resolvedFrom, resolvedTo, Date.now(), lastSeen);
  const logsCopy = logsActionCopy(logsRange.reach, exact);
  const logsNoteId = `${id}-logs-clamped`;
  const logsHref = safeRouteHref(ruleLogsHref(rule, logsRange.from, logsRange.to, sourceId));
  const casesHref = safeRouteHref(pageHash('cases', { rule }));
  const askValue = askEntityValue('rule', rule);
  const canAsk = askValue !== null && can('cases', 'read');
  // No log source can be read for this rule (none can be browsed, or the filtered source
  // is gone): the alert figures were never read, so the sheet says so once and states no
  // zero, and offers no Logs view that could only be empty.
  const noSource = alerts?.status === 'unsupported' && !alerts.series;
  // No source that answered holds an alert from the rule in the window: one line says so
  // (as a fact only when the count is exact; otherwise with the reason it may be low), and
  // the sections drawn from those alerts are left out rather than each saying it again.
  const noAlerts =
    !!alerts && !!alerts.series && alerts.status !== 'forbidden' && alerts.status !== 'unavailable' && alerts.count === 0;
  const alertSections = !noSource && !noAlerts;
  const showLogs = alerts?.status !== 'forbidden' && logsAllowed && !noSource;
  const caseCount = cases?.status === 'ok' && typeof cases.count === 'number' ? cases.count : null;
  const sourceName = sourceId ? alerts?.sources.find((s) => s.id === sourceId)?.name || sourceId : null;
  // Where the count was looked for, so "no alerts" is never read as "the rule never fired".
  const alertScope = sourceName ? `in ${sourceName}` : 'in the log sources the Console can search';
  const onTuningPage = typeof window !== 'undefined' && hashRoute(window.location.hash)?.page === 'tuning';
  const fromLine = origin ? `From ${origin}` : 'Detection rule';
  const seen = alerts && alerts.status !== 'forbidden' ? seenLine(alerts.last_seen, alerts.first_seen) : null;
  const chart = React.useMemo(
    () => alertsChartBlock(alerts?.series, { inProgress: range.to === 'now' }),
    [alerts?.series, range.to],
  );
  const latestRows = latest.data?.logs?.slice(0, 5) ?? [];
  const latestDenied = !logsAllowed || alerts?.status === 'forbidden' || statusOf(latest.error) === 403;

  const tiles: React.ReactNode[] = [];
  if (alerts && alerts.status !== 'forbidden' && typeof alerts.count === 'number') {
    const floor = alerts.count_relation === 'gte';
    tiles.push(
      <KpiTile
        key="alerts"
        testId="rule-alerts"
        label="Alerts"
        value={fmtNumber(alerts.count)}
        countTo={alerts.count}
        format={fmtNumber}
        roll={false}
        // A floor: short enough for the tile's two-line reserve, so the strip's numerals
        // stay on one row; why it is a floor is said under the chart.
        bound={floor ? 'At least this many' : undefined}
        context={floor ? undefined : inWindow}
      />,
    );
  }
  if (cases && cases.status === 'ok' && typeof cases.count === 'number') {
    tiles.push(
      <KpiTile
        key="cases"
        testId="rule-cases"
        label="Cases"
        value={fmtNumber(cases.count)}
        countTo={cases.count}
        format={fmtNumber}
        roll={false}
        context="all time"
      />,
    );
    // "0 of 0 cases" says nothing: before the rule opens its first case, Cases ("0 all
    // time") and Analyst outcome ("no cases from this rule") already say the population
    // is empty, so Still open is left out rather than stating it a third time.
    if (typeof cases.open_now === 'number' && cases.count > 0) {
      tiles.push(
        <KpiTile
          key="open"
          testId="rule-open"
          label="Still open"
          value={fmtNumber(cases.open_now)}
          countTo={cases.open_now}
          format={fmtNumber}
          roll={false}
          context={`of ${fmtNumber(cases.count)} case${cases.count === 1 ? '' : 's'}`}
        />,
      );
    }
    if (cases.outcomes) {
      const o = cases.outcomes;
      const none = cases.count === 0;
      tiles.push(
        <KpiTile
          key="outcome"
          testId="rule-outcome"
          label="Analyst outcome"
          value={none ? 'None yet' : `${fmtNumber(o.analyst_tp)} confirmed`}
          roll={false}
          context={
            none
              ? 'no cases from this rule'
              : // `analyst_ungraded` also counts analyst-policy closes and cases closed
                // without a classification, so the honest word is "not graded", never
                // "waiting".
                `${fmtNumber(o.analyst_fp)} benign · ${fmtNumber(o.analyst_ungraded)} not graded`
          }
        />,
      );
    }
  }

  const casesAside =
    cases?.status === 'ok' && caseCount !== null
      ? `${fmtNumber(caseCount)} case${caseCount === 1 ? '' : 's'} · all time`
      : undefined;
  const latestAside = latestRows.length
    ? `${fmtNumber(latestRows.length)} newest${exact !== null ? ` of ${fmtNumber(exact)}` : ''} · shown to you only, never sent to the assistant`
    : undefined;
  // What the chart rests on: exact; sampled (no source could count natively, so it is drawn
  // from each source's newest events); or not exact (a source did not answer, a live-tail
  // ring, part of a store). The reason under the chart says which.
  const chartAside = alerts?.series
    ? [
        `${bucketWords(alerts.series.bucket)} buckets`,
        'times in UTC',
        alerts.status === 'unsupported' ? 'sampled' : alerts.status === 'ok' && !alerts.reason ? 'exact' : 'not exact',
      ].join(' · ')
    : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id={id}
        side="right"
        size="xl"
        style={paneMotion(open)}
        className="max-w-[46rem] gap-0 overflow-y-auto p-0"
        data-testid="rule-sheet"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          leavingRef.current = null;
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const opener = returnFocusTo?.() ?? null;
          const leaving = leavingRef.current;
          leavingRef.current = null;
          if (leaving) {
            // Closed to go somewhere. Once the move has landed, focus goes where the shell
            // puts it after a navigation (the main region), unless something on the new
            // screen (a route-leave question) already holds it, or the move did not happen
            // and the opener is still there.
            event.preventDefault();
            window.requestAnimationFrame(() => {
              const active = document.activeElement;
              if (active && active !== document.body) return;
              const moved = window.location.hash !== leaving.hash;
              const main = document.getElementById('socMain');
              if (!moved && opener?.isConnected) opener.focus();
              else if (main) main.focus();
              else if (opener?.isConnected) opener.focus();
            });
            return;
          }
          // Back to the opener, or, when a refresh removed it, to the same rule's link or
          // the dialog it sat in; with none of them on the screen, to the main region,
          // never to the page body.
          const target = opener ?? document.getElementById('socMain');
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        // A modal owns the keyboard (SPEC §3.3): no key typed here reaches a shortcut of
        // the surface behind it (see `keepKeysInSheet`).
        onKeyDown={keepKeysInSheet}
      >
        <div className="space-y-4 p-5 sm:p-6">
          <header className="min-w-0 space-y-1 pr-10">
            <SheetDescription className="text-xs font-medium text-muted-foreground">{fromLine}</SheetDescription>
            <SheetTitle
              ref={titleRef}
              tabIndex={-1}
              className="break-words font-mono text-lg [overflow-wrap:anywhere] focus:outline-none"
            >
              {rule}
            </SheetTitle>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <TimeRangePicker value={range} onChange={chooseWindow} size="sm" presets={RULE_SHEET_PRESETS} />
              {sourceName ? (
                <Badge variant="outline" className="max-w-full truncate px-2 py-0.5 text-xs font-normal">
                  {sourceName}
                </Badge>
              ) : null}
            </div>
          </header>

          {/* Says what a newly chosen window shows once its figures land (polite). */}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="rule-window-announcement">
            {announcement}
          </p>

          <LoadingBar active={summary.loading && data !== null} size="sm" label="Refreshing this rule" />

          {summary.loading && !data && !summary.error ? (
            <LoadingState layout="panel" label="Loading this rule" />
          ) : summary.error && !data ? (
            <LoadError
              title="Could not load this rule"
              error={summary.error}
              onRetry={summary.reload}
              fallback="The rule summary could not be read right now."
            />
          ) : data ? (
            <>
              {tiles.length ? (
                <div className="space-y-2">
                  <KpiStrip label="Rule key figures" density="compact">
                    {tiles}
                  </KpiStrip>
                  {seen ? (
                    <p className="text-xs tabular-nums text-muted-foreground" data-testid="rule-seen">
                      {seen}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {showLogs && logsHref ? (
                  <a
                    href={logsHref}
                    onClick={(event) => navigateFromSheet(event, logsHref)}
                    className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
                    aria-describedby={logsCopy.note ? logsNoteId : undefined}
                    data-testid="rule-open-logs"
                  >
                    <ListFilter aria-hidden />
                    {logsCopy.label}
                  </a>
                ) : null}
                {showLogs && logsHref && logsCopy.note ? (
                  // Why the view is shorter than the window: directly under the Logs action
                  // on a phone (the actions stack), under the whole row from `sm`, and the
                  // action's own description for assistive tech.
                  <p id={logsNoteId} className="text-xs text-muted-foreground sm:order-last sm:basis-full" data-testid="rule-logs-clamped">
                    {logsCopy.note}
                  </p>
                ) : null}
                {cases?.status === 'ok' && caseCount !== null && caseCount > 0 && casesHref ? (
                  <a
                    href={casesHref}
                    onClick={(event) => navigateFromSheet(event, casesHref)}
                    className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
                    data-testid="rule-show-cases"
                  >
                    {caseCount === 1 ? 'Show the case' : `Show the ${fmtNumber(caseCount)} cases`}
                  </a>
                ) : null}
                {canAsk ? (
                  <button
                    type="button"
                    className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
                    onClick={() => {
                      leave();
                      navigate('chat', { newChat: true, entity: { kind: 'rule', value: askValue } });
                    }}
                  >
                    <Sparkles aria-hidden />
                    Ask AI about this rule
                  </button>
                ) : null}
              </div>

              <Section id={`${id}-chart`} title="Alerts over time" aside={chart ? chartAside : undefined}>
                {alerts && (alerts.status === 'forbidden' || (alerts.status === 'unavailable' && !chart)) ? (
                  <StatusLine
                    status={alerts.status}
                    reason={alerts.reason}
                    grant="sources"
                    fallback="The alert figures could not be read right now."
                  />
                ) : noSource && alerts ? (
                  <StatusLine
                    status={alerts.status}
                    reason={alerts.reason}
                    grant="sources"
                    fallback="No log source can be read for this rule."
                  />
                ) : chart ? (
                  <>
                    <ChartTabStops>
                      <CartesianChart block={chart} title="Alerts over time by severity" height={168} />
                    </ChartTabStops>
                    {alerts?.reason ? <p className={cn(NOTE, 'mt-2 text-xs')}>{alerts.reason}</p> : null}
                  </>
                ) : (
                  <>
                    <p className={NOTE} data-testid="rule-no-alerts">
                      {noAlerts && alerts?.count_relation === 'eq'
                        ? `No alerts from this rule ${inWindow} ${alertScope}.`
                        : noAlerts
                          ? `No alerts from this rule were found ${inWindow}.`
                          : 'These alerts could not be charted by severity.'}
                    </p>
                    {alerts?.reason ? <p className={cn(NOTE, 'mt-2 text-xs')}>{alerts.reason}</p> : null}
                  </>
                )}
              </Section>

              {alertSections ? (
                <>
                  <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                    <Section id={`${id}-ips`} title="Top source IPs" aside={topListAside(data.top_source_ips)}>
                      <CountList
                        list={data.top_source_ips}
                        label="Top source IPs"
                        empty="The alerts in this window carry no source IP."
                      />
                    </Section>
                    <Section id={`${id}-targets`} title="Top targets" aside={topListAside(data.top_targets)}>
                      <CountList
                        list={data.top_targets}
                        label="Top targets"
                        empty="The alerts in this window name no host or user."
                      />
                    </Section>
                  </div>

                  <Section id={`${id}-latest`} title="Latest alerts" aside={latestDenied ? undefined : latestAside}>
                    <LatestAlerts
                      rows={latestRows}
                      loading={latest.loading}
                      error={latest.error}
                      denied={latestDenied}
                      emptyText={`No alerts to show ${inWindow}.`}
                    />
                  </Section>
                </>
              ) : null}

              <Section id={`${id}-cases`} title="Cases from this rule" aside={casesAside}>
                {cases && cases.status !== 'ok' ? (
                  <StatusLine
                    status={cases.status}
                    reason={cases.reason}
                    grant="cases"
                    fallback="The cases could not be read right now."
                  />
                ) : cases && cases.latest.length ? (
                  <>
                    <CaseList rows={cases.latest} onNavigate={navigateFromSheet} />
                    {caseCount !== null && caseCount > cases.latest.length ? (
                      <p className={cn(NOTE, 'mt-2 text-xs')}>{`The newest ${fmtNumber(cases.latest.length)} of ${fmtNumber(caseCount)}.`}</p>
                    ) : null}
                  </>
                ) : (
                  <p className={NOTE}>No cases from this rule yet.</p>
                )}
              </Section>

              <Section id={`${id}-about`} title="About this rule">
                <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Defined in</dt>
                  <dd className="min-w-0 text-foreground">
                    <DefinitionFact definition={data.definition} />
                  </dd>
                  {data.definition.status === 'ok' && data.definition.suite_rule?.mitre.length ? (
                    <>
                      <dt className="text-muted-foreground">ATT&amp;CK</dt>
                      <dd className="min-w-0 font-mono text-xs text-foreground">
                        {data.definition.suite_rule.mitre.join(', ')}
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Tuning</dt>
                  <dd className="min-w-0 text-foreground">
                    <TuningFact tuning={data.tuning} />
                  </dd>
                  <dt className="text-muted-foreground">Analyst policy</dt>
                  <dd className="min-w-0 text-foreground">
                    <PolicyFact policy={data.analyst_policy} />
                  </dd>
                </dl>
                <AboutActions
                  definition={data.definition}
                  tuning={data.tuning}
                  onTuningPage={onTuningPage}
                  onNavigate={navigateFromSheet}
                />
              </Section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AboutActions({
  definition,
  tuning,
  onTuningPage,
  onNavigate,
}: {
  definition: RuleSummaryDefinition;
  tuning: RuleSummaryTuning;
  /** The sheet sits on Auto-tuning already: no link to the page the person is on. */
  onTuningPage: boolean;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  const settingsHref = definition.status === 'ok' && definition.kind === 'suite' ? safeRouteHref(settingsSectionHash('detection_rules')) : undefined;
  const tuningHref = tuning.status === 'ok' && !onTuningPage ? safeRouteHref(pageHash('tuning')) : undefined;
  const sourceDefined = definition.status === 'ok' && definition.kind === 'source';
  if (!settingsHref && !tuningHref && !sourceDefined) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {settingsHref ? (
        <a
          href={settingsHref}
          onClick={(event) => onNavigate(event, settingsHref)}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
        >
          <Settings2 aria-hidden />
          Rule settings
        </a>
      ) : null}
      {tuningHref ? (
        <a
          href={tuningHref}
          onClick={(event) => onNavigate(event, tuningHref)}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
        >
          <SlidersHorizontal aria-hidden />
          Open Auto-tuning
        </a>
      ) : null}
      {sourceDefined ? (
        <span className="text-xs text-muted-foreground">The rule&apos;s own settings live in the source SIEM.</span>
      ) : null}
    </div>
  );
}

export default RuleSheet;
