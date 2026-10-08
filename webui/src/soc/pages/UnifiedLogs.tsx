/**
 * Logs — the `logs` route (Triage). Without a deep link it is the shared unified browser
 * (`UnifiedLogsBody`: recent events merged across every browse-capable source).
 *
 * With the chat's "Open in Logs" deep link (SPEC §10.7: `logQuery`, `from`, `to`,
 * `sourceId` NavOpts, serialised as `#/logs?logQuery=…`) it shows the LINKED QUERY: the
 * exact filter the answer used, read once with those bounds and that source, and stated
 * plainly above the rows so the analyst sees what the numbers were based on. "Browse all
 * logs" drops the link and returns to the normal browser.
 *
 * The router already validated the link; this page validates it AGAIN (it is reachable
 * through a typed-in hash) and ignores the whole link when any part is malformed. Every
 * row value is UNTRUSTED source data (#9): plain text, and `_raw` only in a fenced code
 * block. Read-only: nothing here writes.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Layers, RefreshCw, X } from 'lucide-react';

import type { NavOpts } from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH, formatTimestamp } from '@/lib/format';
import { LoadingState } from '@/design-system';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { SeverityBadge } from '@/soc/components/badges';
import { UnifiedLogsBody } from '@/soc/components/UnifiedLogsSheet';
import { useNavigateOptional, useRoute } from '@/soc/router';
import {
  fetchUnifiedLogs,
  type UnifiedLogRow,
  type UnifiedLogSourceStatus,
  type UnifiedLogsResponse,
} from '@/soc/UnifiedLogs.api';

/* -------------------------------------------------------------------------- */
/* The deep link.                                                              */
/* -------------------------------------------------------------------------- */

/** The router's grammars (router.tsx `DEEP_LINK_KEYS`), re-checked at the point of use. */
const SOURCE_ID_RE = /^[\w.:-]{1,128}$/;
const TIME_RE = /^(now(-\d{1,5}[mhdw])?|\d{4}-\d\d-\d\d[\dTt:.Zz+-]{0,24})$/;
const QUERY_RE = /^[^\p{C}\u2028\u2029]{1,512}$/u;
/** The longest window a linked query may span (the chat's own bound, SPEC §3.1). */
const MAX_WINDOW_MS = 90 * 86_400_000;
const ROW_LIMIT = 150;

export interface LogsDeepLink {
  query: string | null;
  from: string | null;
  to: string | null;
  sourceId: string | null;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Epoch ms of a bound (`now`, `now-<n><unit>` or ISO-8601), else null. */
export function boundMs(value: string, now: number = Date.now()): number | null {
  if (value === 'now') return now;
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(value);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The validated logs deep link, or null when there is none or ANY part is malformed
 * (a bad link is ignored whole, never half-applied).
 */
export function parseLogsDeepLink(opts: NavOpts | null | undefined, now: number = Date.now()): LogsDeepLink | null {
  if (!opts) return null;
  const { logQuery, from, to, sourceId } = opts;
  if (logQuery === undefined && from === undefined && to === undefined && sourceId === undefined) return null;
  if (logQuery !== undefined && (typeof logQuery !== 'string' || !QUERY_RE.test(logQuery) || !logQuery.trim())) return null;
  if (from !== undefined && (typeof from !== 'string' || !TIME_RE.test(from))) return null;
  if (to !== undefined && (typeof to !== 'string' || !TIME_RE.test(to))) return null;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId))) return null;
  if (from !== undefined) {
    const start = boundMs(from, now);
    const end = boundMs(to ?? 'now', now);
    if (start === null || end === null || start >= end || end - start > MAX_WINDOW_MS) return null;
  } else if (to !== undefined && boundMs(to, now) === null) {
    return null;
  }
  return { query: logQuery ?? null, from: from ?? null, to: to ?? null, sourceId: sourceId ?? null };
}

/** "last 24h" for `now-24h → now`, otherwise the bounds as given (UTC text). */
export function windowLabel(from: string | null, to: string | null): string {
  if (!from) return to ? `until ${to}` : 'the default window';
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(from);
  if (rel && (!to || to === 'now')) return `last ${rel[1]}${rel[2]}`;
  return `${from} → ${to ?? 'now'}`;
}

/* -------------------------------------------------------------------------- */
/* The linked view.                                                            */
/* -------------------------------------------------------------------------- */

const rowKey = (r: UnifiedLogRow) => `${r.source_id}::${r.id}`;

function SourceChips({ sources }: { sources: UnifiedLogSourceStatus[] }) {
  if (!sources.length) return null;
  const buffers = sources.filter((s) => s.mode === 'buffer');
  return (
    <div className="space-y-1.5" data-testid="linked-source-status">
      <div className="flex flex-wrap items-center gap-2">
        {sources.map((s) => (
          <Badge key={s.source_id} variant={s.ok ? 'success' : 'warning'} className="max-w-full gap-1.5" title={s.ok ? undefined : s.error || 'This source could not be read.'}>
            {s.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden /> : <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />}
            <span className="truncate">{s.source_name || s.source_id}</span>
            <span className="tabular-nums text-xs">{s.ok ? s.count : s.error || 'error'}</span>
          </Badge>
        ))}
      </div>
      {buffers.length ? (
        <p className="text-xs text-muted-foreground">
          Live-tail {buffers.length === 1 ? 'source' : 'sources'} ({buffers.map((s) => s.source_name || s.source_id).join(', ')}) return an
          in-memory buffer: the query and window do not apply to {buffers.length === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
    </div>
  );
}

export function LinkedLogsView({ link, onClear }: { link: LogsDeepLink; onClear: () => void }) {
  const [data, setData] = React.useState<UnifiedLogsResponse | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchUnifiedLogs({
        limit: ROW_LIMIT,
        query: link.query ?? undefined,
        from: link.from ?? undefined,
        to: link.to ?? (link.from ? 'now' : undefined),
        source_id: link.sourceId ?? undefined,
      });
      if (id !== seq.current) return;
      setData(res);
    } catch (err) {
      if (id !== seq.current) return;
      setError(err);
      setData(null);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [link.query, link.from, link.to, link.sourceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const sources = data?.sources ?? [];
  const sourceName = link.sourceId ? (sources.find((s) => s.source_id === link.sourceId)?.source_name || link.sourceId) : null;
  const rows = data?.logs ?? [];
  const count = typeof data?.count === 'number' ? data.count : rows.length;

  return (
    <div className="space-y-4" data-testid="linked-logs">
      <section aria-label="Linked query" className="rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Opened from a linked query</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {link.query ? (
                <>
                  <dt className="text-muted-foreground">Query</dt>
                  <dd className="min-w-0">
                    {/* Untrusted: shown verbatim as code, never interpreted. */}
                    <code className="break-all rounded bg-muted px-1 font-mono text-xs">{link.query}</code>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Window</dt>
              <dd>{windowLabel(link.from, link.to)}</dd>
              <dt className="text-muted-foreground">Sources</dt>
              <dd className="min-w-0 truncate">{sourceName ?? 'All browse-capable sources'}</dd>
            </dl>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh linked query">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin motion-reduce:animate-none')} aria-hidden /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={onClear}>
              <X className="h-4 w-4" aria-hidden /> Browse all logs
            </Button>
          </div>
        </div>
      </section>

      {error ? (
        <LoadError error={error} title="Could not run the linked query" fallback="The logs could not be read." onRetry={() => void load()} />
      ) : loading && !data ? (
        <LoadingState label="Loading logs" description="Running the linked query." layout="panel" shape="rows" shapeRows={6} />
      ) : (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Most recent <span className="tabular-nums">{count}</span> matching event{count === 1 ? '' : 's'}
            {data?.truncated ? ' (more exist — the view is capped and has no paging)' : ''}
          </p>
          <SourceChips sources={sources} />
          {data?.partial ? (
            <Alert variant="warning">
              <AlertTitle>Partial results</AlertTitle>
              <AlertDescription>One or more sources could not be read in time; the rows below are from the sources that answered.</AlertDescription>
            </Alert>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState icon={Layers} state="no-results" title="No matching events" description="Nothing matched this query in the window. Older events may have aged out of the sources." />
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
                    const open = expanded.has(key);
                    const rawId = `linked-raw-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
                    return (
                      <React.Fragment key={key}>
                        <TableRow>
                          <TableCell className="font-mono text-xs">{formatTimestamp(r.ts)}</TableCell>
                          <TableCell className="text-sm">
                            <Badge variant="secondary" className="max-w-full">
                              <span className="truncate">{r.source_name || r.source_id || DASH}</span>
                            </Badge>
                          </TableCell>
                          <TableCell className="break-all font-mono text-xs">{r.source_ip || DASH}</TableCell>
                          <TableCell className="break-all text-sm">{r.rule || DASH}</TableCell>
                          <TableCell>
                            <SeverityBadge severity={r.severity} showValue />
                          </TableCell>
                          <TableCell className="max-w-0">
                            <span className="block truncate text-sm" title={r.message || undefined}>
                              {r.message || DASH}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={open ? `Hide raw event for ${r.id}` : `Show raw event for ${r.id}`}
                              aria-expanded={open}
                              aria-controls={rawId}
                              onClick={() =>
                                setExpanded((s) => {
                                  const next = new Set(s);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                            >
                              {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow id={rawId}>
                            <TableCell colSpan={7} className="bg-muted/30 p-2">
                              <CodeBlock value={r._raw ?? {}} wrap maxHeightClassName="max-h-80" caption={`raw event · ${r.source_name || r.source_id}`} />
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
            Log values are untrusted source data — shown as plain text and raw JSON, never executed.
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The page.                                                                   */
/* -------------------------------------------------------------------------- */

export interface UnifiedLogsPageProps {
  /**
   * NavOpts to read instead of the router's (an embed or a test). The route itself passes
   * nothing: the page reads the router, so the registry carries no render thunk.
   */
  opts?: NavOpts;
}

export default function UnifiedLogsPage({ opts: explicit }: UnifiedLogsPageProps = {}) {
  const navigate = useNavigateOptional();
  const route = useRoute();
  const opts = explicit ?? (route.page === 'logs' ? route.opts : undefined);
  const logQuery = opts?.logQuery;
  const from = opts?.from;
  const to = opts?.to;
  const sourceId = opts?.sourceId;
  const link = React.useMemo(
    () => parseLogsDeepLink({ logQuery, from, to, sourceId }),
    [logQuery, from, to, sourceId],
  );
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => setDismissed(false), [link]);
  const active = link && !dismissed ? link : null;

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={Layers}
        eyebrow="Triage"
        title="Logs"
        description={
          active
            ? 'The exact query behind an answer, read again from the source with the same bounds.'
            : 'Recent normalised events merged across every browse-capable source, newest first.'
        }
      />
      {active ? (
        <LinkedLogsView
          link={active}
          onClear={() => {
            setDismissed(true);
            // Drop the deep link from the hash so a refresh shows the normal browser.
            navigate('logs');
          }}
        />
      ) : (
        <UnifiedLogsBody />
      )}
    </PageContainer>
  );
}
