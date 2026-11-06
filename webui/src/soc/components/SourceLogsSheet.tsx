/**
 * SourceLogsSheet (new UI) — a per-source "Browse logs" panel in a right Sheet.
 *
 * Shows a window of normalised events the agent would read from a source via
 * `GET /api/sources/{id}/logs`: a controls row (free-text search + relative time
 * range + a "Live tail" switch that polls every 10s + manual refresh) and a compact
 * table (time, source IP, rule, severity, message) with per-row expansion into the
 * raw event JSON. Round 14 (SPEC §4.9.4, [uib] SL1 to SL3): one-line rows; the time
 * column holds the UTC time only, with the date as a group row whenever the day
 * changes; the message takes the spare width; the severity is the named level on the
 * source's own scale (its raw score in parentheses when that scale is not 0 to 100,
 * D23, and in the tooltip).
 *
 * Two server modes: `mode:"search"` (pull source — time-range + search apply) and
 * `mode:"buffer"` (push source's in-memory live tail; the server ignores
 * from/to/query). EVERY value is source-controlled and therefore UNTRUSTED — it is
 * rendered as plain text, and `_raw` only inside a fenced <CodeBlock>. Never
 * interpolated as markup.
 */
import * as React from 'react';
import { Telescope, Search, ChevronDown, ChevronUp, Radio } from 'lucide-react';
import type { SourceInstance, SourceLogRow } from '@/lib/types';
import { api } from '@/lib/api';
import { DASH, fmtNumber, formatTimestamp } from '@/lib/format';
import { properName } from '@/lib/proper-names';
import { logRowKeys, pruneExpandedKeys } from '@/lib/log-row-keys';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Skeleton } from '@/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/ui/table';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SeverityBadge } from '@/soc/components/badges';

/** Auto-refresh cadence for the "Live tail" switch (ms). */
const LIVE_TAIL_INTERVAL_MS = 10_000;
/** Max rows we ask the backend for in one window (backend caps at 200). */
const ROW_LIMIT = 100;

/**
 * Column widths of the log table (uib SL2): the message is the column that explains an
 * event, so it takes the flexible width and every other column is as narrow as its
 * content allows (the raw toggle keeps a 28px button inside 8px padding). The sheet is
 * wide enough that the message gets about half of the table from 1024px up. Exported
 * for the layout test.
 */
export const SOURCE_LOGS_SHEET_WIDTH = 'sm:max-w-5xl';
export const SOURCE_LOG_COLUMNS = {
  time: 'w-[6.5rem] whitespace-nowrap',
  sourceIp: 'w-[7.5rem]',
  rule: 'w-[8rem]',
  severity: 'w-[6.5rem]',
  severityNative: 'w-[7.5rem]',
  raw: 'w-[2.75rem] px-2',
} as const;

/** Relative time-range presets for the pull (search) mode. */
const TIME_RANGES: Array<{ value: string; label: string }> = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last 1 hour' },
  { value: 'now-4h', label: 'Last 4 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
];

/** The UTC day ("Oct 25, 2026") and time ("14:02:11") of an event, or null when unparseable. */
export function utcDayAndTime(iso: string | null | undefined): { day: string; time: string; iso: string } | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const stamp = d.toISOString();
  const day = d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  return { day, time: stamp.slice(11, 19), iso: `${stamp.slice(0, 10)} ${stamp.slice(11, 19)} UTC` };
}

/** Rows grouped by their UTC day, in the order the server returned them (newest first). */
function groupByUtcDay<T extends { ts: string }>(rows: T[]): Array<{ day: string; items: Array<{ row: T; index: number }> }> {
  const groups: Array<{ day: string; items: Array<{ row: T; index: number }> }> = [];
  rows.forEach((row, index) => {
    const day = utcDayAndTime(row.ts)?.day ?? 'Time not recorded';
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push({ row, index });
    else groups.push({ day, items: [{ row, index }] });
  });
  return groups;
}

export interface SourceLogsSheetProps {
  /** The source whose logs to browse; null/undefined keeps the sheet closed. */
  source: SourceInstance | null;
  onClose: () => void;
  /**
   * The sheet opens from state (a row menu item), so it has no Radix trigger to hand focus
   * back to. The host passes its opener-focus handler (SPEC §3.3: Esc returns focus to
   * the element that opened the layer).
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export const SourceLogsSheet: React.FC<SourceLogsSheetProps> = ({ source, onClose, onCloseAutoFocus }) => {
  const open = !!source;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        size="xl"
        className={`flex w-full flex-col p-0 ${SOURCE_LOGS_SHEET_WIDTH}`}
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {source ? <SourceLogsBody key={source.id} source={source} /> : null}
      </SheetContent>
    </Sheet>
  );
};

/* Inner body is keyed by source so all state resets when the source changes. */
const SourceLogsBody: React.FC<{ source: SourceInstance }> = ({ source }) => {
  const [query, setQuery] = React.useState('');
  const [start, setStart] = React.useState('now-15m');
  const [liveTail, setLiveTail] = React.useState(false);

  const [rows, setRows] = React.useState<SourceLogRow[]>([]);
  // One source can return the same event id more than once (Demo Mode's QRadar feed
  // does), so rows are keyed by id and event time, numbering exact repeats.
  const keys = React.useMemo(() => logRowKeys(rows), [rows]);
  const [mode, setMode] = React.useState('');
  const [count, setCount] = React.useState(0);
  // The server bound: browse is "the most recent N", never a complete result (no
  // pagination). `truncated` says more demonstrably existed.
  const [appliedLimit, setAppliedLimit] = React.useState(ROW_LIMIT);
  const [truncated, setTruncated] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRef = React.useRef<(showSkeleton: boolean) => void>(() => {});

  const load = React.useCallback(
    async (showSkeleton: boolean) => {
      if (showSkeleton) setLoading(true);
      setError(null);
      try {
        const res = await api.sourceLogs(source.id, {
          limit: ROW_LIMIT,
          query: query.trim() || undefined,
          from: start || undefined,
          to: 'now',
        });
        const logs = res.logs || [];
        setRows(logs);
        setMode(res.mode || '');
        setCount(typeof res.count === 'number' ? res.count : logs.length);
        setAppliedLimit(typeof res.limit === 'number' ? res.limit : ROW_LIMIT);
        setTruncated(Boolean(res.truncated));
        setExpanded((prev) => pruneExpandedKeys(prev, logs));
      } catch (e) {
        setError(e);
      } finally {
        if (showSkeleton) setLoading(false);
      }
    },
    [source.id, query, start],
  );

  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Load on mount, on source change, and when the time range changes — but NOT on every
  // keystroke. Typing only updates `query` (via a fresh `load` identity); the search
  // fires solely on Enter / Refresh. Reading through `loadRef` uses the latest `query`.
  React.useEffect(() => {
    void loadRef.current(true);
  }, [source.id, start]);

  // Live-tail polling.
  React.useEffect(() => {
    if (!liveTail) {
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
  }, [liveTail]);

  const toggleExpand = React.useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isBuffer = mode === 'buffer';
  // The source's own severity ladder (0 to 100 unless the operator declared another).
  const scaleMax =
    typeof source.severity_scale_max === 'number' && source.severity_scale_max > 0 ? source.severity_scale_max : 100;
  const nativeScale = scaleMax !== 100;

  return (
    <>
      <SheetHeader className="space-y-4">
        <div className="min-w-0">
          <SheetTitle className="truncate">Logs from {source.display_name || source.source_type}</SheetTitle>
          <p className="text-sm text-muted-foreground">
            {properName(source.source_type)} · {properName(source.ingest_mode)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[14rem] flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-9 pl-9"
              placeholder="Search message, rule or host"
              aria-label="Search log events"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(true);
              }}
            />
          </div>
          <Select value={start} onValueChange={setStart} disabled={isBuffer}>
            <SelectTrigger className="h-9 w-[11rem]" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Switch
              id="live-tail"
              checked={liveTail}
              onCheckedChange={setLiveTail}
              aria-label="Auto-refresh every 10 seconds"
            />
            <Label htmlFor="live-tail" className="cursor-pointer text-sm">
              Live tail
            </Label>
          </div>
          <RefreshButton
            onClick={() => void load(true)}
            refreshing={loading}
            label="Refresh log events"
            display="icon"
          />
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-6">
        {error ? (
          <LoadError
            error={error}
            title="Could not load logs"
            fallback="Could not load logs."
            onRetry={() => void load(true)}
          />
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Telescope}
            title="No events"
            description="No log events in this window."
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground" data-testid="source-logs-window">
                {isBuffer ? 'Live tail' : 'Search'} · most recent{' '}
                <span className="tabular-nums">{fmtNumber(count)}</span>
                {truncated ? (
                  <>
                    {' '}
                    <span
                      title={`Browse returns at most ${appliedLimit} rows and has no paging. Narrow the time range or the search to see more.`}
                    >
                      (more exist)
                    </span>
                  </>
                ) : null}
              </span>
              {liveTail ? (
                <Badge variant="success" className="gap-1">
                  <Radio className="h-3 w-3" aria-hidden /> Live · every 10 s
                </Badge>
              ) : null}
            </div>

            {isBuffer ? (
              <p className="text-sm text-muted-foreground">
                This is a push source, so these rows are its in-memory live tail. The time range
                and the search apply to pull sources only.
              </p>
            ) : null}

            <div className="overflow-x-auto rounded-lg border border-border">
              <Table layout="fixed" unwrapped className="min-w-[40rem]" aria-label="Log events">
                <TableHeader>
                  <TableRow>
                    <TableHead density="compact" className={SOURCE_LOG_COLUMNS.time}>
                      Time (UTC)
                    </TableHead>
                    <TableHead density="compact" className={SOURCE_LOG_COLUMNS.sourceIp}>
                      Source IP
                    </TableHead>
                    <TableHead density="compact" className={SOURCE_LOG_COLUMNS.rule}>
                      Rule
                    </TableHead>
                    <TableHead
                      density="compact"
                      className={nativeScale ? SOURCE_LOG_COLUMNS.severityNative : SOURCE_LOG_COLUMNS.severity}
                    >
                      Severity
                    </TableHead>
                    <TableHead density="compact" data-column="message">Message</TableHead>
                    <TableHead density="compact" className={`${SOURCE_LOG_COLUMNS.raw} text-right`}>
                      <span className="sr-only">Raw event</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                {groupByUtcDay(rows).map((group) => (
                  <TableBody key={`${group.day}:${group.items[0]?.index ?? 0}`}>
                    <TableRow className="hover:bg-transparent">
                      <th
                        scope="rowgroup"
                        colSpan={6}
                        className="bg-muted/40 px-4 py-1 text-left text-xs font-medium text-muted-foreground"
                      >
                        {group.day}
                      </th>
                    </TableRow>
                    {group.items.map(({ row: r, index }) => {
                      const key = keys[index];
                      const isOpen = expanded.has(key);
                      const when = utcDayAndTime(r.ts);
                      return (
                        <React.Fragment key={key}>
                          <TableRow>
                            <TableCell density="compact" numeric className="text-sm" title={when ? `${when.iso} (${formatTimestamp(r.ts)} local)` : undefined}>
                              {when ? when.time : r.ts || DASH}
                            </TableCell>
                            <TableCell density="compact" className="truncate font-mono text-xs" title={r.source_ip || undefined}>
                              {r.source_ip ? r.source_ip : <span className="text-muted-foreground">{DASH}</span>}
                            </TableCell>
                            <TableCell density="compact" className="truncate text-sm" title={r.rule || undefined}>
                              {r.rule ? r.rule : <span className="text-muted-foreground">{DASH}</span>}
                            </TableCell>
                            <TableCell density="compact">
                              <span
                                className="inline-flex"
                                title={
                                  typeof r.severity === 'number'
                                    ? `Severity ${fmtNumber(r.severity)} on a 0 to ${fmtNumber(scaleMax)} scale`
                                    : undefined
                                }
                              >
                                <SeverityBadge severity={r.severity} scaleMax={scaleMax} showValue={nativeScale} />
                              </span>
                            </TableCell>
                            <TableCell density="compact" className="max-w-0">
                              <span className="block truncate text-sm" title={r.message || undefined}>
                                {r.message || DASH}
                              </span>
                            </TableCell>
                            <TableCell density="compact" className="px-2 text-right">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label={isOpen ? `Hide raw event for ${r.id}` : `Show raw event for ${r.id}`}
                                aria-expanded={isOpen}
                                onClick={() => toggleExpand(key)}
                              >
                                {isOpen ? (
                                  <ChevronUp className="h-4 w-4" aria-hidden />
                                ) : (
                                  <ChevronDown className="h-4 w-4" aria-hidden />
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                          {isOpen ? (
                            <TableRow>
                              <TableCell colSpan={6} className="bg-muted/30 p-2">
                                {/* _raw is UNTRUSTED source data: fenced, never markup. */}
                                <CodeBlock value={r._raw ?? {}} wrap maxHeightClassName="max-h-80" caption="raw event" />
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                ))}
              </Table>
            </div>

            <p className="text-sm text-muted-foreground">
              Log values are untrusted source data: they are shown as plain text and raw JSON,
              never run.
            </p>
          </div>
        )}
      </div>
    </>
  );
};

export default SourceLogsSheet;
