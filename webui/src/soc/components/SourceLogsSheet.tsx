/**
 * SourceLogsSheet (new UI) — a per-source "Browse logs" panel in a right Sheet.
 *
 * Shows a window of normalised events the agent would read from a source via
 * `GET /api/sources/{id}/logs`: a controls row (free-text search + relative time
 * range + a "Live tail" switch that polls every 10s + manual refresh) and a table
 * of rows (timestamp / source.ip / module-rule / severity / message) with per-row
 * expansion into the raw event JSON.
 *
 * Two server modes: `mode:"search"` (pull source — time-range + search apply) and
 * `mode:"buffer"` (push source's in-memory live tail; the server ignores
 * from/to/query). EVERY value is source-controlled and therefore UNTRUSTED — it is
 * rendered as plain text, and `_raw` only inside a fenced <CodeBlock>. Never
 * interpolated as markup.
 */
import * as React from 'react';
import {
  Telescope,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronUp,
  Radio,
} from 'lucide-react';
import type { SourceInstance, SourceLogRow } from '@/lib/types';
import { api } from '@/lib/api';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

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
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SeverityBadge } from '@/soc/components/badges';

/** Auto-refresh cadence for the "Live tail" switch (ms). */
const LIVE_TAIL_INTERVAL_MS = 10_000;
/** Max rows we ask the backend for in one window (backend caps at 200). */
const ROW_LIMIT = 100;

/** Relative time-range presets for the pull (search) mode. */
const TIME_RANGES: Array<{ value: string; label: string }> = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last 1 hour' },
  { value: 'now-4h', label: 'Last 4 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
];

export interface SourceLogsSheetProps {
  /** The source whose logs to browse; null/undefined keeps the sheet closed. */
  source: SourceInstance | null;
  onClose: () => void;
}

export const SourceLogsSheet: React.FC<SourceLogsSheetProps> = ({ source, onClose }) => {
  const open = !!source;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        size="xl"
        className="flex w-full flex-col p-0 sm:max-w-3xl"
        aria-describedby={undefined}
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
        setExpanded((prev) => {
          const ids = new Set(logs.map((r) => r.id));
          const next = new Set<string>();
          for (const k of prev) if (ids.has(k)) next.add(k);
          return next;
        });
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

  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isBuffer = mode === 'buffer';

  return (
    <>
      <SheetHeader className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
            <Telescope className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <SheetTitle className="truncate">
              {source.display_name || source.source_type} · Logs
            </SheetTitle>
            <p className="text-xs text-muted-foreground">
              {humanizeToken(source.source_type)} · {humanizeToken(source.ingest_mode)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[14rem] flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-9 pl-9"
              placeholder="Search message, rule, host…"
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
            <Label htmlFor="live-tail" className="cursor-pointer text-xs">
              Live tail
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={loading}
            aria-label="Refresh log events"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden /> Refresh
          </Button>
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
              <span className="text-xs font-medium text-muted-foreground">
                <span className="uppercase tracking-wide">{mode || DASH}</span> · most
                recent <span className="tabular-nums">{count}</span>
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

            {isBuffer ? (
              <p className="text-xs text-muted-foreground">
                This is a push source — these rows are its in-memory live tail. The time range
                and search apply to pull (search) sources only.
              </p>
            ) : null}

            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[170px]">Timestamp</TableHead>
                    <TableHead className="w-[140px]">source.ip</TableHead>
                    <TableHead className="w-[170px]">Module / rule</TableHead>
                    <TableHead className="w-[90px]">Severity</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[56px] text-right">Raw</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const isOpen = expanded.has(r.id);
                    return (
                      <React.Fragment key={r.id}>
                        <TableRow>
                          <TableCell className="font-mono text-xs">
                            {formatTimestamp(r.ts)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {r.source_ip ? (
                              r.source_ip
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
                              onClick={() => toggleExpand(r.id)}
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
                              {/* _raw is UNTRUSTED source data → fenced, never markup. */}
                              <CodeBlock
                                value={r._raw ?? {}}
                                wrap
                                maxHeightClassName="max-h-80"
                                caption="raw event"
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

            <p className="text-xs text-muted-foreground">
              Log values are untrusted source data — shown as plain text and raw JSON, never
              executed.
            </p>
          </div>
        )}
      </div>
    </>
  );
};

export default SourceLogsSheet;
