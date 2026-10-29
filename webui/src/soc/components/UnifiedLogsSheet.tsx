/**
 * UnifiedLogs — a single pane that browses recent normalised log events MERGED
 * across EVERY enabled, browse-capable source at once (Round 4 Wave 5, request #3).
 *
 * It reads the NEW scatter-gather endpoint `GET /api/logs` (see `UnifiedLogs.api.ts`):
 * the server fans out the same per-source read that `GET /api/sources/{id}/logs` does
 * across all sources, merges the rows newest-first, and returns a per-source status
 * list. This UI renders:
 *   - a controls row (free-text search + relative time range + a 10s "Live tail"
 *     switch that polls + a manual refresh),
 *   - a per-source status strip (so PARTIAL failure is honest — a slow/failing source
 *     shows as a degraded chip, never blocks the rest), and
 *   - a table of rows with a MANDATORY SOURCE (provenance) column, plus timestamp /
 *     source.ip / module-rule / severity / message and per-row expansion into `_raw`.
 *
 * EVERY value on every row is source-controlled and therefore UNTRUSTED (#9): rendered
 * as plain text, and `_raw` only inside a fenced <CodeBlock>. Never interpolated as
 * markup. Secrets are never returned by the endpoint.
 *
 * Two shapes are exported: `UnifiedLogsView` (the standalone content, e.g. a top-level
 * "Logs" page under the Triage nav group) and `UnifiedLogsSheet` (the same content in a
 * right Sheet, for an inline "browse everything" affordance). The default export is the
 * page view.
 *
 * `UnifiedLogsBody` also takes a STARTING query, window and source plus a header slot:
 * the Logs page's chat deep link ("Open in Logs", SPEC §10.7) opens this same browser
 * already set to the answer's exact filter, with its summary above the controls, so
 * there is one log table, not a second copy for linked queries.
 */
import * as React from 'react';
import { Layers, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DASH, fmtNumber, formatTimestamp } from '@/lib/format';
import { logRowKeys, pruneExpandedKeys } from '@/lib/log-row-keys';
import {
  fetchUnifiedLogs,
  type LogSeverityLevel,
  type UnifiedLogRow,
  type UnifiedLogSourceStatus,
  type UnifiedLogsResponse,
} from '@/soc/UnifiedLogs.api';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/ui/table';
import { CodeBlock } from '@/soc/components/CodeBlock';
import type { AskAiChipProps } from '@/soc/components/AskAiChip';
import { useAuth } from '@/soc/auth';
import { useRoute } from '@/soc/router';
import type { AskEntityKind } from '@/soc/components/ask-ai';
import { RuleLink, RuleSheetScope, useRuleSheet, type RuleSheetWindow } from '@/soc/components/RuleLink';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SeverityBadge } from '@/soc/components/badges';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { TimeRangePicker, type RefreshValue, type TimeRange } from '@/soc/components/TimeRangePicker';
import { Callout, LoadingState, Panel, StatusDot } from '@/design-system';
import { useIsMobile } from '@/soc/hooks/useMediaQuery';

/**
 * Round 12 WP-ASK: the "Ask AI" chip, loaded on demand so it never becomes a shared
 * chunk every route's preload list (in the entry chunk) must name (see AskAiChip.tsx,
 * "Loading"). The load starts when this module loads; the chip renders once it has
 * arrived, and never if it cannot load (the chip is optional, so it fails soft).
 */
type AskAiChipModule = typeof import('@/soc/components/AskAiChip');
let askAiChipModule: AskAiChipModule | null = null;
const askAiChipLoad: Promise<AskAiChipModule | null> = import('@/soc/components/AskAiChip').then(
  (loaded) => (askAiChipModule = loaded),
  () => null,
);
/**
 * A shell context, or null outside it. `useAuth` / `useRoute` read their context before
 * they throw, so hook order is stable; the hook is looked up inside the guard too (a test
 * double of the module may not export it).
 */
function useOptionalContext<T>(pick: () => () => T): T | null {
  try {
    return pick()();
  } catch {
    return null;
  }
}
function AskAiChip(props: AskAiChipProps) {
  const auth = useOptionalContext(() => useAuth);
  const route = useOptionalContext(() => useRoute);
  const [loaded, setLoaded] = React.useState(askAiChipModule);
  React.useEffect(() => {
    if (loaded) return undefined;
    let live = true;
    void askAiChipLoad.then((next) => {
      if (live && next) setLoaded(next);
    });
    return () => {
      live = false;
    };
  }, [loaded]);
  return loaded ? (
    <loaded.AskAiChip {...props} navigate={route?.navigate} hasPermission={auth?.hasPermission} />
  ) : null;
}

/** Auto-refresh cadence for the "Live tail" switch (ms). */
const LIVE_TAIL_INTERVAL_MS = 10_000;
/** Max rows we ask the backend for on the merged view (backend hard-caps at 200). */
const ROW_LIMIT = 150;

/** Relative time-range presets (apply to PULL sources; PUSH buffers ignore them). */
const TIME_RANGES: Array<{ value: string; label: string }> = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last 1 hour' },
  { value: 'now-4h', label: 'Last 4 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
];

/** The same ranges as the time-range pill's presets (Round 14, SPEC §4.9.3). */
const TIME_RANGE_PRESETS: readonly TimeRange[] = TIME_RANGES.map((r) => ({ from: r.value, to: 'now', label: r.label }));
/** Logs offers Off or Live (a 10 second live tail). */
const LOG_REFRESH_OPTIONS: readonly RefreshValue[] = ['off', 'live'];

/**
 * A row's time on one line in UTC (`17:17:24`); the date is the group row above it and
 * the full timestamp is the cell's tooltip (Round 14, SPEC §4.9.4).
 */
export function utcTimeLabel(ts: string | null | undefined): string {
  const ms = ts ? Date.parse(ts) : Number.NaN;
  if (!Number.isFinite(ms)) return DASH;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The UTC date a group of rows shares ("Sun, Oct 25, 2026"). */
export function utcDayLabel(ts: string | null | undefined): string {
  const ms = ts ? Date.parse(ts) : Number.NaN;
  if (!Number.isFinite(ms)) return 'Unknown date';
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A source's short name for a 240px column: the configured name without a trailing
 * parenthetical ("Splunk Enterprise Security (HEC)" reads "Splunk Enterprise Security");
 * the full name is the cell's tooltip. Operator text, shown as plain text (#9).
 */
export function shortSourceName(name: string): string {
  const short = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return short || name.trim();
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Could not load logs.';
  return 'Could not load logs.';
}

/* -------------------------------------------------------------------------- */
/* Severity: the named level on each source's own scale                       */
/* -------------------------------------------------------------------------- */

/** The canonical 0 to 100 severity score: the scale a row is read on by default. */
const CANONICAL_SEVERITY_MAX = 100;

/**
 * Each configured source's declared severity ceiling (`severity_scale_max`) by source
 * id, from `GET /api/sources` (the same `sources:read` grant as `GET /api/logs`). Only a
 * declared, positive ceiling is kept; an undeclared source reads on the canonical score.
 * `null` when the list could not be read, so the caller keeps what it had. Never throws.
 */
async function readSeverityCeilings(): Promise<ReadonlyMap<string, number> | null> {
  try {
    const res = await api.listSources();
    const out = new Map<string, number>();
    for (const s of res?.sources ?? []) {
      const max = s.severity_scale_max;
      if (s.id && typeof max === 'number' && Number.isFinite(max) && max > 0) out.set(s.id, max);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The ceiling a source's row severities are read on (Round 14, SPEC §4.9.4: the row shows
 * the named level only). A pull source (`"search"`) sends its NATIVE value, so it reads on
 * the ceiling the source declares (a Wazuh `rule.level` on 0 to 16, where 12 is Critical).
 * A push source's live-tail ring (`"buffer"`) already holds the canonical 0 to 100 score,
 * and so does a Demo source (never in the configured list). This is the same split the
 * server applies to the rule and severity filters (`engine/log_rows.py`), so a "Severity
 * is Critical" view badges its rows Critical.
 */
export function severityCeiling(
  status: Pick<UnifiedLogSourceStatus, 'source_id' | 'mode'> | undefined,
  declared: ReadonlyMap<string, number>,
): number {
  if (!status || status.mode === 'buffer') return CANONICAL_SEVERITY_MAX;
  return declared.get(status.source_id) ?? CANONICAL_SEVERITY_MAX;
}

/** A row's severity: the named level only, the raw score and its scale in the tooltip. */
const RowSeverity: React.FC<{ severity: number; scaleMax: number }> = ({ severity, scaleMax }) => (
  <span
    className="inline-flex"
    title={
      typeof severity === 'number' && Number.isFinite(severity)
        ? `Score ${fmtNumber(severity)} on a 0 to ${fmtNumber(scaleMax)} scale`
        : undefined
    }
  >
    <SeverityBadge severity={severity} scaleMax={scaleMax} className="px-1.5 text-2xs" />
  </span>
);

/**
 * Whether a horizontally scrolling region has more content to its right, for the
 * right-edge fade (the cue `DataTable` draws, SPEC §4.9.2). Re-measured on scroll, on a
 * resize of the region or its table, and whenever `deps` change.
 */
function useMoreToTheRight(el: HTMLElement | null, deps: readonly unknown[]): boolean {
  const [more, setMore] = React.useState(false);
  const measure = React.useCallback(() => {
    setMore(el ? el.scrollWidth - el.clientWidth - el.scrollLeft > 1 : false);
  }, [el]);
  React.useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  React.useEffect(() => {
    if (!el) return undefined;
    el.addEventListener('scroll', measure, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [el, measure]);
  return more;
}

/* -------------------------------------------------------------------------- */
/* Per-source status strip                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a source was not read, in plain words. The server sends `"timeout"`, or the
 * connector's own error text (source-derived: shown as plain text, never markup, and
 * clipped so one long exception cannot take over the line).
 */
export function sourceErrorText(error: string | undefined): string {
  const text = (error || '').trim();
  if (!text) return 'the read failed';
  if (text === 'timeout') return 'timed out';
  if (text === 'error') return 'the read failed';
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

const SourceStatusStrip: React.FC<{ sources: UnifiedLogSourceStatus[] }> = ({ sources }) => {
  if (sources.length === 0) return null;
  // The live-tail caveat is operationally load-bearing (the time range and search never
  // ran against these sources), so it is rendered as VISIBLE text, reachable without a
  // pointer and announced by a screen reader, instead of a hover-only `title`. Mirrors
  // the single-source sheet's disclosure so both read paths explain themselves the same way.
  const bufferSources = sources.filter((s) => s.mode === 'buffer');
  return (
    <div className="space-y-1.5" data-testid="unified-source-status">
      {/* One quiet line per source (Round 14, C7): a neutral dot for a source that was
          read, an amber one for one that was not, then the row count or why it was not
          read. Every fact is visible text (no hover-only tooltip), so a keyboard or
          screen-reader user gets it too. Only the read path that changes what the
          numbers mean is named: "live tail" (the time range and search did not apply). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Sources read">
        {sources.map((s) => (
          <li key={s.source_id} className="min-w-0 max-w-full" data-source-ok={s.ok ? 'true' : 'false'}>
            {/* The line wraps instead of truncating (StatusDot's text span is one line by
                default), so a long name or a connector's reason is never cut off unseen. */}
            <StatusDot
              tone={s.ok ? 'neutral' : 'warning'}
              className="text-xs [&>span:last-child]:whitespace-normal [&>span:last-child]:break-words"
            >
              {/* source_name is operator-set text and the error is connector text: both
                  plain text, never markup. */}
              <span className="text-foreground">{s.source_name || s.source_id}</span>{' '}
              {s.ok ? (
                <span className="tabular-nums">{s.count.toLocaleString()}</span>
              ) : (
                <span data-testid="unified-source-error">not read: {sourceErrorText(s.error)}</span>
              )}
              {s.mode === 'buffer' ? (
                <>
                  {' · '}
                  <span>live tail</span>
                </>
              ) : null}
            </StatusDot>
          </li>
        ))}
      </ul>
      {bufferSources.length > 0 ? (
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="unified-buffer-caveat"
        >
          {/* source_name is operator-set text: plain text, never markup. */}
          Live-tail {bufferSources.length === 1 ? 'source' : 'sources'} (
          {bufferSources.map((s) => s.source_name || s.source_id).join(', ')}) return an
          in-memory buffer: the time range and search box do not apply to{' '}
          {bufferSources.length === 1 ? 'it' : 'them'}, and that buffer does not survive a
          backend restart.
        </p>
      ) : null}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Shared body — the controls + status strip + rows table                     */
/* -------------------------------------------------------------------------- */

/** The time-range control's value for a starting window that is not a preset. */
const LINKED_WINDOW = 'linked';

export interface UnifiedLogsBodyProps {
  /** The search to start with (a linked query); it stays editable. */
  initialQuery?: string;
  /**
   * The window to start with (a linked query's exact bounds): `now`, `now-<n><unit>` or
   * ISO-8601. A preset with no explicit end selects that preset; anything else becomes a
   * one-off entry in the time-range control until another range is chosen.
   */
  initialFrom?: string;
  initialTo?: string;
  /** How that one-off window reads in the control (e.g. a readable UTC range). */
  initialWindowLabel?: string;
  /** Read only this source (a linked query's source). */
  sourceId?: string;
  /** Rendered above the events (e.g. the linked query's summary). */
  header?: React.ReactNode;
  /**
   * The page header, given the time-range pill and Refresh for its controls slot (Round
   * 14, SPEC §4.9.3: the page's only data controls sit beside its title). Without it (a
   * sheet) the controls sit beside the search.
   */
  renderHeader?: (controls: React.ReactNode) => React.ReactNode;
  /** Every successful read's per-source status (a host names a linked source with it). */
  onSources?: (sources: UnifiedLogSourceStatus[]) => void;
  /*
   * Round 14 (SPEC §4.6.6): exact filters the server applies (`GET /api/logs` `rule`,
   * `severity`, `severity_gte`), bound as structured filters, never as search text. The
   * Logs page passes them from a deep link ("Rule is", "Severity is High").
   */
  /** Exactly this rule value (kept byte for byte). */
  rule?: string;
  /** Exactly this named level. */
  severity?: LogSeverityLevel;
  /** This named level or above. */
  severityGte?: LogSeverityLevel;
  /** Leave the rule column out (a "Rule is" filter fixes it). */
  hideRuleColumn?: boolean;
  /**
   * Every successful read's whole response (the page states `matched` from it), with how
   * the window that read used reads ("last 3 days", "Last 24 hours"), since the time-range
   * control can change it after the link opened.
   */
  onResult?: (res: UnifiedLogsResponse, read: { windowLabel: string }) => void;
  /**
   * Focus the search box when the browser mounts. The Logs page sets it when the last
   * filter chip of a link is removed: the linked header goes away with the chip, so focus
   * lands on the browser's first control rather than on the page body.
   */
  autoFocusSearch?: boolean;
}

/** Why Live tail is off while a linked query's fixed past window is selected. */
export const LIVE_TAIL_FIXED_WINDOW_REASON = 'This linked window is fixed in the past, so it never changes. Pick a time range to follow new events.';

interface StartWindow {
  /** A preset value, or {@link LINKED_WINDOW} for the starting one-off window. */
  start: string;
  linked: {
    from: string | null;
    to: string | null;
    label: string;
    /** It ends at an absolute instant already past, so re-reading it finds nothing new. */
    fixed: boolean;
  } | null;
}

/**
 * Whether a window ending at `to` is closed in the past: `to` is an absolute instant (not
 * `now` or `now-…`, the same rule as the Logs page's readable range) at or before now. An
 * open end runs to now, and a relative one moves, so both still see new events.
 */
function endsInPast(to: string | undefined): boolean {
  if (!to || to === 'now' || to.startsWith('now-')) return false;
  const ms = Date.parse(to);
  return Number.isFinite(ms) && ms <= Date.now();
}

function startWindow(from?: string, to?: string, label?: string): StartWindow {
  if (!from && !to) return { start: 'now-1h', linked: null };
  if (from && (!to || to === 'now') && TIME_RANGES.some((r) => r.value === from)) return { start: from, linked: null };
  return {
    start: LINKED_WINDOW,
    linked: { from: from ?? null, to: to ?? null, label: label || `${from ?? '…'} → ${to ?? 'now'}`, fixed: endsInPast(to) },
  };
}

/**
 * The rule sheet the row details open (Round 14, SPEC §4.6.5) belongs to the whole body,
 * never to a row a refresh can drop. While it is open the live tail pauses (the modal
 * covers the rows), so the expanded row and the link it was opened from are still there
 * when it closes; polling resumes on close.
 */
export const UnifiedLogsBody: React.FC<UnifiedLogsBodyProps> = (props) => {
  const ruleSheet = useRuleSheet();
  return (
    <RuleSheetScope host={ruleSheet}>
      <LogsBody {...props} tailPaused={ruleSheet.isOpen} />
    </RuleSheetScope>
  );
};

const LogsBody: React.FC<UnifiedLogsBodyProps & { tailPaused: boolean }> = ({
  tailPaused,
  initialQuery = '',
  initialFrom,
  initialTo,
  initialWindowLabel,
  sourceId,
  header = null,
  renderHeader,
  onSources,
  rule,
  severity,
  severityGte,
  hideRuleColumn = false,
  onResult,
  autoFocusSearch = false,
}) => {
  const [query, setQuery] = React.useState(initialQuery);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [focusSearchOnMount] = React.useState(autoFocusSearch);
  React.useEffect(() => {
    if (focusSearchOnMount) searchRef.current?.focus();
  }, [focusSearchOnMount]);
  // The COMMITTED search term the fetch actually uses. Kept separate from the live
  // `query` input so typing does not refetch/skeleton-flash on every keystroke — the
  // search is manual (Enter / Refresh), matching the button contract below.
  const [submittedQuery, setSubmittedQuery] = React.useState(initialQuery);
  // The starting window is read once: a host that links somewhere else remounts the
  // body (keyed), so a later prop change never silently swaps the analyst's range.
  const [initialWindow] = React.useState(() => startWindow(initialFrom, initialTo, initialWindowLabel));
  const [start, setStart] = React.useState(initialWindow.start);
  const linkedWindow = start === LINKED_WINDOW ? initialWindow.linked : null;
  const [liveTailPref, setLiveTail] = React.useState(false);
  // Re-polling a window closed in the past every 10 s would only re-read the same rows.
  // A relative or open-ended linked window (`from=now-6h`) still moves, so it can tail.
  const liveTailBlocked = start === LINKED_WINDOW && !!initialWindow.linked?.fixed;
  const liveTail = liveTailPref && !liveTailBlocked;
  const onSourcesRef = React.useRef(onSources);
  onSourcesRef.current = onSources;
  const onResultRef = React.useRef(onResult);
  onResultRef.current = onResult;
  const filtered = Boolean(rule || severity || severityGte);

  const [rows, setRows] = React.useState<UnifiedLogRow[]>([]);
  const keys = React.useMemo(() => logRowKeys(rows), [rows]);
  const [sources, setSources] = React.useState<UnifiedLogSourceStatus[]>([]);
  // Each configured source's declared severity ceiling (see `severityCeiling`).
  const [ceilings, setCeilings] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const [partial, setPartial] = React.useState(false);
  const [count, setCount] = React.useState(0);
  // The server bound: this view is "the most recent N", never a complete result (the
  // endpoint caps every read and offers no pagination), so a cut is said as text.
  const [truncated, setTruncated] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRef = React.useRef<(showSkeleton: boolean) => void>(() => {});
  // Monotonic request id: a response is applied only if it is still the latest one,
  // so overlapping fetches (typing fast, live-tail overlap) never render stale rows.
  const seqRef = React.useRef(0);

  const load = React.useCallback(
    async (showSkeleton: boolean) => {
      const seq = ++seqRef.current;
      if (showSkeleton) setLoading(true);
      setError(null);
      try {
        // The declared ceilings are read with every full load (never on a live-tail
        // poll), together with the rows, so a row is never first badged on the wrong
        // scale. The read never fails the page: on an error the last ceilings stay.
        const ceilingsRead = showSkeleton ? readSeverityCeilings() : Promise.resolve(null);
        const logsRead = fetchUnifiedLogs({
          limit: ROW_LIMIT,
          query: submittedQuery.trim() || undefined,
          // A linked window keeps its exact bounds; an open-ended one runs to now.
          from: linkedWindow ? (linkedWindow.from ?? undefined) : start || undefined,
          to: linkedWindow ? (linkedWindow.to ?? (linkedWindow.from ? 'now' : undefined)) : 'now',
          ...(sourceId ? { source_id: sourceId } : {}),
          ...(rule ? { rule } : {}),
          ...(severity ? { severity } : {}),
          ...(severityGte ? { severity_gte: severityGte } : {}),
        });
        const [res, nextCeilings] = await Promise.all([logsRead, ceilingsRead]);
        if (seq !== seqRef.current) return; // superseded by a newer request
        if (nextCeilings) setCeilings(nextCeilings);
        const logs = res.logs || [];
        setRows(logs);
        setSources(res.sources || []);
        onSourcesRef.current?.(res.sources || []);
        onResultRef.current?.(res, {
          windowLabel: linkedWindow
            ? linkedWindow.label
            : (TIME_RANGES.find((r) => r.value === start)?.label ?? start),
        });
        setPartial(Boolean(res.partial));
        setCount(typeof res.count === 'number' ? res.count : logs.length);
        setTruncated(Boolean(res.truncated));
        // Prune expanded rows that scrolled out of the window (keys are source, id
        // and event time, so a refresh keeps the analyst's open row open).
        setExpanded((prev) => pruneExpandedKeys(prev, logs));
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e);
      } finally {
        if (showSkeleton && seq === seqRef.current) setLoading(false);
      }
    },
    [submittedQuery, start, linkedWindow, sourceId, rule, severity, severityGte],
  );

  // Manual search: commit the live input. If the term is unchanged the load effect
  // won't refire, so force a single refetch.
  const runSearch = React.useCallback(() => {
    if (submittedQuery === query) void load(true);
    else setSubmittedQuery(query);
  }, [submittedQuery, query, load]);

  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);

  React.useEffect(() => {
    void load(true);
  }, [load]);

  // Live-tail polling (every 10s). Uses a ref so the interval never captures a stale
  // `load` closure while search/time-range change.
  React.useEffect(() => {
    if (!liveTail || tailPaused) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => void loadRef.current(false), LIVE_TAIL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [liveTail, tailPaused]);

  // The window a rule opened from a row's detail reads (Round 14, SPEC §4.6.5): the
  // linked window's exact bounds, else the chosen preset up to now.
  const ruleWindow = React.useMemo<RuleSheetWindow | undefined>(() => {
    if (linkedWindow) {
      return linkedWindow.from ? { from: linkedWindow.from, to: linkedWindow.to ?? 'now', label: linkedWindow.label } : undefined;
    }
    if (!start) return undefined;
    return { from: start, to: 'now', label: TIME_RANGES.find((r) => r.value === start)?.label };
  }, [linkedWindow, start]);

  const toggleExpand = React.useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Round 14 (SPEC §4.9.3, C8): the Overview's time-range pill with this page's ranges and
  // Off or Live, and the header Refresh, are the page's only data controls. A linked
  // window that is not a preset is the picker's first entry until another range is picked.
  const linkedRange = initialWindow.linked
    ? { from: LINKED_WINDOW, to: 'now', label: initialWindow.linked.label }
    : null;
  const presets = linkedRange ? [linkedRange, ...TIME_RANGE_PRESETS] : TIME_RANGE_PRESETS;
  const currentRange = presets.find((p) => p.from === start) ?? presets[0];
  const controls = (
    <>
      <TimeRangePicker
        value={currentRange}
        onChange={(range) => setStart(range.from)}
        presets={presets}
        refresh={liveTail ? 'live' : 'off'}
        // A window fixed in the past never changes, so it offers no Live (the reason is
        // said under the search).
        onRefreshChange={liveTailBlocked ? undefined : (value) => setLiveTail(value !== 'off')}
        refreshOptions={LOG_REFRESH_OPTIONS}
        size="sm"
        chrome="command"
      />
      <RefreshButton display="icon" label="Refresh log events" refreshing={loading} onClick={runSearch} />
    </>
  );
  const isMobile = useIsMobile();
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const moreToTheRight = useMoreToTheRight(scrollEl, [rows, hideRuleColumn, expanded]);
  const ceilingBySource = React.useMemo(() => {
    const out = new Map<string, number>();
    for (const s of sources) out.set(s.source_id, severityCeiling(s, ceilings));
    return out;
  }, [sources, ceilings]);
  const ceilingOf = (r: UnifiedLogRow) => ceilingBySource.get(r.source_id) ?? CANONICAL_SEVERITY_MAX;
  const okSources = sources.filter((s) => s.ok);
  const eventsTitle = loading || error ? 'Events' : `Latest ${count.toLocaleString()} ${count === 1 ? 'event' : 'events'}`;
  const eventsCaption =
    loading || error || sources.length === 0
      ? undefined
      : okSources.length === sources.length
        ? `from ${sources.length.toLocaleString()} ${sources.length === 1 ? 'source' : 'sources'}`
        : `from ${okSources.length.toLocaleString()} of ${sources.length.toLocaleString()} sources`;
  const cols = hideRuleColumn ? 6 : 7;
  let lastDay = '';

  return (
    <>
      {renderHeader ? renderHeader(controls) : null}
      {header}
      <Panel
        title={eventsTitle}
        caption={eventsCaption}
        padding="none"
        aside={
          <>
            {liveTail ? (
              <StatusDot tone="success" data-testid="unified-live-badge">
                Live, every 10 seconds
              </StatusDot>
            ) : null}
          </>
        }
        data-testid="unified-logs-events"
      >
        <div className="space-y-2.5 px-4 pb-3 xl:px-5 3xl:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] max-w-xl flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchRef}
                className="h-8 pl-9"
                placeholder={isMobile ? 'Search logs' : 'Search message, rule or host across all sources'}
                aria-label="Search log events"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runSearch();
                }}
              />
            </div>
            {renderHeader ? null : controls}
          </div>
          {liveTailBlocked ? (
            <p id="unified-live-tail-reason" className="text-xs text-muted-foreground" data-testid="unified-live-tail-reason">
              {LIVE_TAIL_FIXED_WINDOW_REASON}
            </p>
          ) : null}
          {loading || error ? null : <SourceStatusStrip sources={sources} />}
          {truncated && !loading && !error ? (
            // The bound is part of the result (browse has no paging): said as visible
            // text, not a hover-only tooltip.
            <p className="text-xs text-muted-foreground" data-testid="unified-cap-note">
              More events match than these {count.toLocaleString()}. Narrow the time range or search to see the rest.
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="px-4 pb-4 xl:px-5 3xl:px-6">
            <LoadError
              error={error}
              title="Could not load logs"
              fallback={errorMessage(error)}
              onRetry={() => void load(true)}
            />
          </div>
        ) : loading ? (
          <LoadingState
            label="Loading logs"
            description="Reading recent normalized events across connected sources."
            layout="panel"
            shape="rows"
            shapeRows={8}
          />
        ) : (
          <>
            {partial ? (
              <div className="px-4 pb-3 xl:px-5 3xl:px-6">
                <Callout intent="warning" title="Partial results">
                  One or more sources could not be read in time and were skipped. The rows below are from the
                  sources that responded; see the sources above.
                </Callout>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <div className="px-4 pb-4 xl:px-5 3xl:px-6">
                <EmptyState
                  icon={Layers}
                  compact
                  title="No events"
                  description={
                    sources.length === 0
                      ? 'No browse-capable sources are enabled. Configure a source to see its logs here.'
                      : filtered
                        ? 'No log events matched these filters in this window across your sources.'
                        : linkedWindow
                          ? // A link reopened later may point at events the source no longer keeps.
                            'No log events matched this window across your sources. Older events may have aged out of the source since this link was made.'
                          : 'No log events matched this window across your sources.'
                  }
                />
              </div>
            ) : isMobile ? (
              // Below 768px a 68rem table would show only Time and Source: the events are
              // stacked list rows instead (time, source and level, then the message).
              <LogPhoneList
                rows={rows}
                keys={keys}
                expanded={expanded}
                onToggle={toggleExpand}
                ceilingOf={ceilingOf}
                ruleWindow={ruleWindow}
                sourceId={sourceId}
              />
            ) : (
              <div className="relative" data-testid="unified-logs-table">
                {/* `@container/ulog`: the row detail sizes itself to the visible width of
                    this horizontal scroll area (`100cqi`), so it never lands off-screen. */}
                <div ref={setScrollEl} className="relative w-full overflow-x-auto @container/ulog" data-testid="unified-logs-scroll">
                  <Table unwrapped layout="fixed" className="min-w-[68rem]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead density="compact" className="w-[7rem] whitespace-nowrap pl-4 xl:pl-5 3xl:w-[7.5rem] 3xl:pl-6">
                          Time (UTC)
                        </TableHead>
                        <TableHead density="compact" className="w-[15rem]">Source</TableHead>
                        <TableHead density="compact" className="w-[9.5rem]">Source IP</TableHead>
                        {hideRuleColumn ? null : <TableHead density="compact" className="w-[11rem]">Rule</TableHead>}
                        <TableHead density="compact" className="w-[6.5rem]">Severity</TableHead>
                        <TableHead density="compact">Message</TableHead>
                        {/* The row's one action stays in view at the right edge while the
                            columns scroll beneath it. */}
                        <TableHead density="compact" className={cn('w-[3.5rem] pr-4 text-right xl:pr-5 3xl:pr-6', STICKY_END_HEAD)}>
                          <span className="sr-only">Raw event</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r, index) => {
                        const key = keys[index];
                        const isOpen = expanded.has(key);
                        // The date once, as a group row, when it changes (rows are newest first).
                        const day = utcDayLabel(r.ts);
                        const newDay = day !== lastDay;
                        lastDay = day;
                        const fullSource = r.source_name || r.source_id || '';
                        return (
                          <React.Fragment key={key}>
                            {newDay ? (
                              <TableRow className="hover:bg-transparent" data-testid="ulog-day">
                                <TableCell
                                  density="compact"
                                  colSpan={cols}
                                  className="pb-1 pl-4 pt-3 text-xs font-medium text-muted-foreground xl:pl-5 3xl:pl-6"
                                >
                                  {/* Pinned to the left of the scroll area, so the date stays
                                      in view while the columns scroll sideways. */}
                                  <span className="sticky left-4 inline-block xl:left-5 3xl:left-6">{day}</span>
                                </TableCell>
                              </TableRow>
                            ) : null}
                            <TableRow>
                              <TableCell
                                density="compact"
                                className="whitespace-nowrap pl-4 font-mono text-xs tabular-nums text-muted-foreground xl:pl-5 3xl:pl-6"
                                title={formatTimestamp(r.ts)}
                              >
                                {utcTimeLabel(r.ts)}
                              </TableCell>
                              <TableCell density="compact" className="text-sm">
                                {/* MANDATORY provenance: the source's short name, the full one
                                    in its tooltip (operator text, plain). */}
                                <span className="block truncate" title={fullSource || undefined}>
                                  {shortSourceName(fullSource) || DASH}
                                </span>
                              </TableCell>
                              <TableCell density="compact" className="whitespace-nowrap font-mono text-xs">
                                {r.source_ip ? (
                                  // The address stays on one line; the Ask AI icon shows beside
                                  // it on hover or focus. The rule, host and user chips live in
                                  // the row detail.
                                  <div className="group/ask flex min-w-0 items-center gap-1">
                                    <span className="min-w-0 truncate" title={r.source_ip}>
                                      {r.source_ip}
                                    </span>
                                    {/* `-my-1`: the 24px chip stays out of the row's flow too. */}
                                    <AskAiChip kind="ip" value={r.source_ip} className="-my-1" />
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">{DASH}</span>
                                )}
                              </TableCell>
                              {hideRuleColumn ? null : (
                                <TableCell density="compact" className="text-sm">
                                  <span className="block truncate" title={r.rule || undefined}>
                                    {r.rule || <span className="text-muted-foreground">{DASH}</span>}
                                  </span>
                                </TableCell>
                              )}
                              <TableCell density="compact">
                                <RowSeverity severity={r.severity} scaleMax={ceilingOf(r)} />
                              </TableCell>
                              <TableCell density="compact" className="max-w-0">
                                <span className="block truncate text-sm" title={r.message || undefined}>
                                  {r.message || DASH}
                                </span>
                              </TableCell>
                              <TableCell density="compact" className={cn('pr-4 text-right xl:pr-5 3xl:pr-6', STICKY_END_CELL)}>
                                {/* `-my-1`: the 28px target stays out of the row's flow, so a
                                    row keeps the compact height (about 38px). */}
                                <RawToggle id={r.id} rawKey={key} open={isOpen} onToggle={toggleExpand} className="-my-1 size-7" />
                              </TableCell>
                            </TableRow>
                            {isOpen ? (
                              <TableRow id={`ulog-raw-${key}`} className="hover:bg-transparent">
                                <TableCell colSpan={cols} className="bg-muted/40 p-2">
                                  {/* The detail stays in the visible part of the table's scroll
                                      area: when the table scrolls sideways, a full-width
                                      detail would otherwise start off-screen. */}
                                  <div className={ROW_DETAIL} data-testid="ulog-row-detail">
                                    <RowDetail row={r} ruleWindow={ruleWindow} sourceId={sourceId} />
                                  </div>
                                </TableCell>
                              </TableRow>
                            ) : null}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {/* The right-edge fade (SPEC §4.9.2): more columns scroll to the right. It sits
                    just left of the pinned Raw event column. Decorative. */}
                {moreToTheRight ? (
                  <div
                    aria-hidden="true"
                    data-testid="unified-logs-fade-right"
                    className="pointer-events-none absolute inset-y-0 right-14 z-[2] w-10 bg-gradient-to-l from-card to-transparent"
                  />
                ) : null}
              </div>
            )}
          </>
        )}
      </Panel>

      <p className="text-xs text-muted-foreground">
        Log values are untrusted source data, shown as plain text and raw JSON and never executed. Secrets are
        never returned.
      </p>
    </>
  );
};

/**
 * A row's expanded detail: pinned to the left of the table's horizontal scroll area
 * (`sticky`, 8 px in like the cell padding) and no wider than its visible width
 * (`100cqi` of the `@container/ulog` wrapper, less both paddings).
 */
const ROW_DETAIL = 'sticky left-2 max-w-[calc(100cqi-1rem)]';

/**
 * The pinned trailing column (the row's Raw event toggle). On a panel `bg-card` is the
 * panel fill, so the cell hides the columns scrolling beneath it; it repaints the row's
 * hover tint itself as an inset wash, the same `muted/40` step `TableRow` uses (the way
 * `DataTable` pins its sticky first column).
 */
const STICKY_END_HEAD = 'sticky right-0 z-[1] bg-card';
const STICKY_END_CELL =
  'sticky right-0 z-[1] bg-card [tr:hover>&]:shadow-[inset_0_0_0_100vmax_hsl(var(--muted)/0.4)]';

/** The Raw event disclosure button: one name in the table and in the phone list. */
const RawToggle: React.FC<{
  id: string;
  rawKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  className?: string;
}> = ({ id, rawKey, open, onToggle, className }) => (
  <Button
    variant="ghost"
    size="icon"
    className={className}
    aria-label={open ? `Hide raw event for ${id}` : `Show raw event for ${id}`}
    aria-expanded={open}
    aria-controls={`ulog-raw-${rawKey}`}
    onClick={() => onToggle(rawKey)}
  >
    {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
  </Button>
);

/** A row's detail: its entities (with Ask AI and the rule link), then the raw event. */
const RowDetail: React.FC<{ row: UnifiedLogRow; ruleWindow?: RuleSheetWindow; sourceId?: string }> = ({
  row,
  ruleWindow,
  sourceId,
}) => (
  <>
    <RowEntities row={row} ruleWindow={ruleWindow} sourceId={sourceId} />
    {/* _raw is UNTRUSTED source data: fenced, never markup. */}
    <CodeBlock
      value={row._raw ?? {}}
      wrap
      maxHeightClassName="max-h-80"
      caption={`Raw event · ${row.source_name || row.source_id}`}
    />
  </>
);

/** Rows grouped by their UTC day, in order (rows arrive newest first). */
function groupByDay(rows: UnifiedLogRow[], keys: string[]): Array<{ day: string; items: Array<{ row: UnifiedLogRow; key: string }> }> {
  const groups: Array<{ day: string; items: Array<{ row: UnifiedLogRow; key: string }> }> = [];
  rows.forEach((row, index) => {
    const day = utcDayLabel(row.ts);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push({ row, key: keys[index] });
    else groups.push({ day, items: [{ row, key: keys[index] }] });
  });
  return groups;
}

/**
 * The events below 768px (Round 14, SPEC §4.9.4 and the Cases phone list): one stacked
 * row per event, the time, the source's short name and the level on line one, the
 * message on line two, and the Raw event toggle at 44px. The date heads each day's list.
 */
const LogPhoneList: React.FC<{
  rows: UnifiedLogRow[];
  keys: string[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  ceilingOf: (row: UnifiedLogRow) => number;
  ruleWindow?: RuleSheetWindow;
  sourceId?: string;
}> = ({ rows, keys, expanded, onToggle, ceilingOf, ruleWindow, sourceId }) => (
  <div className="border-t border-border/70" data-testid="unified-logs-phone-list">
    {groupByDay(rows, keys).map((group, groupIndex) => (
      <div key={`${groupIndex}-${group.day}`}>
        <p className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground" data-testid="ulog-day">
          {group.day}
        </p>
        <ul className="divide-y divide-border/70" aria-label={`Events on ${group.day}`}>
          {group.items.map(({ row: r, key }) => {
            const isOpen = expanded.has(key);
            const fullSource = r.source_name || r.source_id || '';
            return (
              <li key={key}>
                <div className="flex items-start gap-1 pl-4 pr-1">
                  <div className="min-w-0 flex-1 space-y-1 py-2.5">
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 font-mono tabular-nums text-muted-foreground" title={formatTimestamp(r.ts)}>
                        {utcTimeLabel(r.ts)}
                      </span>
                      {/* Operator text and source data: plain text (#9). */}
                      <span className="min-w-0 truncate text-foreground" title={fullSource || undefined}>
                        {shortSourceName(fullSource) || DASH}
                      </span>
                      <span className="ml-auto shrink-0">
                        <RowSeverity severity={r.severity} scaleMax={ceilingOf(r)} />
                      </span>
                    </div>
                    <p className="line-clamp-2 break-words text-sm text-foreground">{r.message || DASH}</p>
                  </div>
                  <RawToggle
                    id={r.id}
                    rawKey={key}
                    open={isOpen}
                    onToggle={onToggle}
                    className="size-11 shrink-0 text-muted-foreground"
                  />
                </div>
                {isOpen ? (
                  <div id={`ulog-raw-${key}`} className="bg-muted/40 px-2 py-2" data-testid="ulog-row-detail">
                    <RowDetail row={r} ruleWindow={ruleWindow} sourceId={sourceId} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </div>
);

/**
 * The row's entities in its detail (Round 12 WP-ASK): source IP, host, user and rule,
 * each with an "Ask AI" chip that opens a new chat asking the server's question about
 * that value (a typed reference, never free text). Host and user have no table column,
 * and the rule column is too narrow for a chip, so this is where those are asked about.
 * Every value is UNTRUSTED source data (#9): a plain text node.
 */
const ROW_ENTITIES: ReadonlyArray<{ label: string; kind: AskEntityKind; pick: (r: UnifiedLogRow) => string | null }> = [
  { label: 'Source IP', kind: 'ip', pick: (r) => r.source_ip },
  { label: 'Host', kind: 'host', pick: (r) => r.host },
  { label: 'User', kind: 'user', pick: (r) => r.user },
  { label: 'Rule', kind: 'rule', pick: (r) => r.rule },
];

const RowEntities: React.FC<{ row: UnifiedLogRow; ruleWindow?: RuleSheetWindow; sourceId?: string }> = ({
  row,
  ruleWindow,
  sourceId,
}) => {
  const present = ROW_ENTITIES.map((entity) => ({ ...entity, value: entity.pick(row) })).filter(
    (entity): entity is (typeof entity & { value: string }) => typeof entity.value === 'string' && entity.value.trim() !== '',
  );
  if (present.length === 0) return null;
  return (
    <dl className="mb-2 flex flex-wrap gap-x-6 gap-y-1 px-1 text-xs" data-testid="ulog-row-entities">
      {present.map((entity) => (
        <div key={entity.label} className="group/ask flex min-w-0 items-center gap-1.5">
          <dt className="text-muted-foreground">{entity.label}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            {entity.kind === 'rule' ? (
              // Round 14 (SPEC §4.6.5): the rule opens its picture over the Logs window.
              <RuleLink
                rule={entity.value}
                window={ruleWindow}
                sourceId={sourceId}
                origin="Logs"
                className="min-w-0 break-all text-foreground"
              />
            ) : (
              <span className="min-w-0 break-all font-mono text-foreground">{entity.value}</span>
            )}
            <AskAiChip kind={entity.kind} value={entity.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
};

/* -------------------------------------------------------------------------- */
/* Standalone page (intended nav placement: top-level "Logs" under Triage)    */
/* -------------------------------------------------------------------------- */

export const UnifiedLogsView: React.FC = () => (
  <PageContainer variant="wide">
    <UnifiedLogsBody
      renderHeader={(controls) => (
        <PageHeader
          title="Logs"
          help="Recent normalised events merged across every browse-capable source, newest first."
          controls={controls}
        />
      )}
    />
  </PageContainer>
);

export default UnifiedLogsView;

/* -------------------------------------------------------------------------- */
/* Sheet variant (same body inside a right Sheet)                             */
/* -------------------------------------------------------------------------- */

export interface UnifiedLogsSheetProps {
  open: boolean;
  onClose: () => void;
}

export const UnifiedLogsSheet: React.FC<UnifiedLogsSheetProps> = ({ open, onClose }) => (
  <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
    <SheetContent
      side="right"
      size="xl"
      className="flex w-full flex-col gap-4 sm:max-w-3xl"
      aria-describedby={undefined}
    >
      <SheetHeader>
        <SheetTitle className="truncate">Logs</SheetTitle>
        <p className="text-sm text-muted-foreground">Merged across every browse-capable source</p>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">{open ? <UnifiedLogsBody /> : null}</div>
    </SheetContent>
  </Sheet>
);
