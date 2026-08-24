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
 */
import * as React from 'react';
import {
  Layers,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronUp,
  Radio,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { DASH, formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  fetchUnifiedLogs,
  type UnifiedLogRow,
  type UnifiedLogSourceStatus,
} from '@/soc/UnifiedLogs.api';

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
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
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
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SeverityBadge } from '@/soc/components/badges';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { LoadingState } from '@/design-system';

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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Could not load logs.';
  return 'Could not load logs.';
}

/* -------------------------------------------------------------------------- */
/* Per-source status strip                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How a source was read. `"buffer"` is a push source's PROCESS-LOCAL, VOLATILE
 * in-memory live-tail ring — the server IGNORES the time range and search box for it,
 * so the merged view would otherwise silently imply a filter that never ran.
 */
function modeNote(mode: string | undefined): string {
  if (mode === 'buffer') {
    return 'Live-tail buffer: the most recent in-memory events. The time range and search do NOT apply to this source, and its buffer does not survive a backend restart.';
  }
  if (mode === 'search') return 'Search: the time range and search box applied to this source.';
  return '';
}

const SourceStatusStrip: React.FC<{ sources: UnifiedLogSourceStatus[] }> = ({ sources }) => {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="unified-source-status">
      {sources.map((s) => {
        // The error string is source/connector-derived → surfaced as a plain-text title
        // only, never markup. The mode note is our own static copy.
        const note = modeNote(s.mode);
        const title = s.ok
          ? note || undefined
          : [s.error || 'This source could not be read.', note].filter(Boolean).join(' ');
        return (
          <Badge
            key={s.source_id}
            variant={s.ok ? 'success' : 'warning'}
            className="max-w-full gap-1.5"
            title={title}
          >
            {s.ok ? (
              <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            )}
            {/* source_name is operator-set text → plain text. */}
            <span className="truncate">{s.source_name || s.source_id}</span>
            <span className="tabular-nums text-xs opacity-80">
              {s.ok ? s.count : (s.error || 'error')}
            </span>
            {s.mode ? (
              // Server-reported read path — makes "the time range did not apply here"
              // visible instead of tribal knowledge.
              <span className="text-xs uppercase tracking-wide opacity-70">
                {s.mode === 'buffer' ? 'live tail' : s.mode}
              </span>
            ) : null}
          </Badge>
        );
      })}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Shared body — the controls + status strip + rows table                     */
/* -------------------------------------------------------------------------- */

export const UnifiedLogsBody: React.FC = () => {
  const [query, setQuery] = React.useState('');
  // The COMMITTED search term the fetch actually uses. Kept separate from the live
  // `query` input so typing does not refetch/skeleton-flash on every keystroke — the
  // search is manual (Enter / Refresh), matching the button contract below.
  const [submittedQuery, setSubmittedQuery] = React.useState('');
  const [start, setStart] = React.useState('now-1h');
  const [liveTail, setLiveTail] = React.useState(false);

  const [rows, setRows] = React.useState<UnifiedLogRow[]>([]);
  const [sources, setSources] = React.useState<UnifiedLogSourceStatus[]>([]);
  const [partial, setPartial] = React.useState(false);
  const [count, setCount] = React.useState(0);
  // The server bound: this view is "the most recent N", never a complete result — the
  // endpoint caps every read and offers no pagination.
  const [appliedLimit, setAppliedLimit] = React.useState(ROW_LIMIT);
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
        const res = await fetchUnifiedLogs({
          limit: ROW_LIMIT,
          query: submittedQuery.trim() || undefined,
          from: start || undefined,
          to: 'now',
        });
        if (seq !== seqRef.current) return; // superseded by a newer request
        const logs = res.logs || [];
        setRows(logs);
        setSources(res.sources || []);
        setPartial(Boolean(res.partial));
        setCount(typeof res.count === 'number' ? res.count : logs.length);
        setAppliedLimit(typeof res.limit === 'number' ? res.limit : ROW_LIMIT);
        setTruncated(Boolean(res.truncated));
        // Prune expanded ids that scrolled out of the window (ids are per-source
        // unique; a source_id prefix keeps two sources' identical ids distinct).
        setExpanded((prev) => {
          const ids = new Set(logs.map((r) => rowKey(r)));
          const next = new Set<string>();
          for (const k of prev) if (ids.has(k)) next.add(k);
          return next;
        });
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e);
      } finally {
        if (showSkeleton && seq === seqRef.current) setLoading(false);
      }
    },
    [submittedQuery, start],
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

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="h-9 pl-9"
            placeholder="Search message, rule, host across all sources…"
            aria-label="Search log events"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
          />
        </div>
        <Select value={start} onValueChange={setStart}>
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
            id="unified-live-tail"
            checked={liveTail}
            onCheckedChange={setLiveTail}
            aria-label="Auto-refresh every 10 seconds"
          />
          <Label htmlFor="unified-live-tail" className="cursor-pointer text-xs">
            Live tail
          </Label>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={runSearch}
          disabled={loading}
          aria-label="Refresh log events"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden /> Refresh
        </Button>
      </div>

      {/* Body */}
      {error ? (
        <LoadError
          error={error}
          title="Could not load logs"
          fallback={errorMessage(error)}
          onRetry={() => void load(true)}
        />
      ) : loading ? (
        <LoadingState
          label="Loading logs"
          description="Reading recent normalized events across connected sources."
          layout="panel"
          shape="rows"
          shapeRows={8}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Most recent <span className="tabular-nums">{count}</span> event
              {count === 1 ? '' : 's'} across{' '}
              <span className="tabular-nums">{sources.length}</span> source
              {sources.length === 1 ? '' : 's'}
              {truncated ? (
                <>
                  {' '}
                  <span
                    title={`Browse returns at most ${appliedLimit} rows and has no paging — narrow the time range or search to see more.`}
                  >
                    (more exist)
                  </span>
                </>
              ) : null}
            </span>
            {liveTail ? (
              <Badge variant="success" className="gap-1">
                <Radio className="h-3 w-3" aria-hidden /> Live · every 10s
              </Badge>
            ) : null}
          </div>

          {/* Per-source provenance + degraded status. */}
          <SourceStatusStrip sources={sources} />

          {partial ? (
            <Alert variant="warning">
              <AlertTitle>Partial results</AlertTitle>
              <AlertDescription>
                One or more sources could not be read in time and were skipped. The rows below
                are from the sources that responded — see the status chips above.
              </AlertDescription>
            </Alert>
          ) : null}

          {rows.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No events"
              description={
                sources.length === 0
                  ? 'No browse-capable sources are enabled. Configure a source to see its logs here.'
                  : 'No log events matched this window across your sources.'
              }
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[170px]">Timestamp</TableHead>
                    <TableHead className="w-[150px]">Source</TableHead>
                    <TableHead className="w-[130px]">source.ip</TableHead>
                    <TableHead className="w-[160px]">Module / rule</TableHead>
                    <TableHead className="w-[90px]">Severity</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[56px] text-right">Raw</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const key = rowKey(r);
                    const isOpen = expanded.has(key);
                    return (
                      <React.Fragment key={key}>
                        <TableRow>
                          <TableCell className="font-mono text-xs">
                            {formatTimestamp(r.ts)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {/* MANDATORY provenance — source_name is operator text → plain. */}
                            <Badge variant="secondary" className="max-w-full">
                              <span className="truncate">{r.source_name || r.source_id || DASH}</span>
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {r.source_ip ? (
                              <span className="break-all">{r.source_ip}</span>
                            ) : (
                              <span className="text-muted-foreground">{DASH}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {r.rule ? (
                              <span className="break-all">{r.rule}</span>
                            ) : (
                              <span className="text-muted-foreground">{DASH}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <SeverityBadge severity={r.severity} showValue />
                          </TableCell>
                          <TableCell className="max-w-0">
                            <span
                              className="block truncate text-sm"
                              title={r.message || undefined}
                            >
                              {r.message || DASH}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={
                                isOpen
                                  ? `Hide raw event for ${r.id}`
                                  : `Show raw event for ${r.id}`
                              }
                              aria-expanded={isOpen}
                              aria-controls={`ulog-raw-${key}`}
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
                          <TableRow id={`ulog-raw-${key}`}>
                            <TableCell colSpan={7} className="bg-muted/30 p-2">
                              {/* _raw is UNTRUSTED source data → fenced, never markup. */}
                              <CodeBlock
                                value={r._raw ?? {}}
                                wrap
                                maxHeightClassName="max-h-80"
                                caption={`raw event · ${r.source_name || r.source_id}`}
                              />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Log values are untrusted source data — shown as plain text and raw JSON, never
            executed. Secrets are never returned.
          </p>
        </div>
      )}
    </div>
  );
};

/**
 * A stable per-row key. Row `id` can collide across sources (two connectors may emit
 * the same event id), so we namespace by `source_id` to keep expansion state correct.
 */
function rowKey(r: UnifiedLogRow): string {
  return `${r.source_id}::${r.id}`;
}

/* -------------------------------------------------------------------------- */
/* Standalone page (intended nav placement: top-level "Logs" under Triage)    */
/* -------------------------------------------------------------------------- */

export const UnifiedLogsView: React.FC = () => (
  <PageContainer variant="wide" className="space-y-6">
    <PageHeader
      icon={Layers}
      eyebrow="Triage"
      title="Logs"
      description="Recent normalised events merged across every browse-capable source, newest first."
    />
    <UnifiedLogsBody />
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
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
            <Layers className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <SheetTitle className="truncate">Unified logs</SheetTitle>
            <p className="text-xs text-muted-foreground">
              Merged across every browse-capable source
            </p>
          </div>
        </div>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto">{open ? <UnifiedLogsBody /> : null}</div>
    </SheetContent>
  </Sheet>
);
