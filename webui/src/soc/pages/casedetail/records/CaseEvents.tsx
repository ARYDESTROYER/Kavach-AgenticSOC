/**
 * The raw events behind a case (Round 16 SPEC §4.5 WP14, research data-visibility R2):
 * a compact table read from `GET /api/cases/{id}/events`, a page at a time, and for one
 * event a side sheet with a Table view (every field as a path and a value) and a JSON
 * view (the source record, searchable, with Copy JSON and Download). The table offers an
 * NDJSON download of the loaded rows and "Open in Logs" over their time window.
 *
 * `filterEventIds` narrows the table to the events one finding cites ("Cites N events");
 * `onClearFilter` clears it. The envelope says honestly what the server could do: a
 * source that keeps no copy (`push_source_not_retrievable`), a source that could not be
 * read (`source_unavailable`) or events that are gone (`aged_out`). A page can be gone
 * while later pages are not, so the next page stays one click away.
 *
 * Reading raw records needs `sources:read` beside `cases:read` (the route checks both);
 * without it the table says so and asks nothing. Every value is source-controlled
 * UNTRUSTED data: text nodes, `InlineCode` or the JSON tree only, never markup (#9).
 * Nothing here reaches a model (#7) or changes the case (#3).
 */
import * as React from 'react';
import { Download, ExternalLink, X } from 'lucide-react';

import { ApiError } from '@/lib/api';
import { CASE_EVENTS_PAGE, getCaseEvents } from '@/lib/api-case-records';
import { downloadBlob } from '@/lib/download-blob';
import { errorMessage } from '@/lib/errorMessage';
import type { CaseEventRow, CaseEventsPage, CaseEventsUnavailableReason } from '@/lib/types';

import { LoadingState } from '@/design-system';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';

import { useAuth } from '@/soc/auth';
import { InlineCode } from '@/soc/components/CodeBlock';
import { JsonViewer, leafText } from '@/soc/components/JsonTree';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { pageHash } from '@/soc/router';

import { eventTime } from './time';

export interface CaseEventsProps {
  caseId: string;
  filterEventIds?: string[] | null;
  onClearFilter?: () => void;
  /** Injectable for tests. */
  load?: typeof getCaseEvents;
}

/** Why the events could not be shown, in plain words. */
export const UNAVAILABLE_WORDS: Record<CaseEventsUnavailableReason, string> = {
  aged_out: 'These events are no longer in the source. They may have passed its retention.',
  push_source_not_retrievable:
    'This source sends its events to Agentic SOC and keeps no copy to read back, so they cannot be shown again.',
  source_unavailable: 'The source could not be read. It may be turned off, removed or not answering.',
};

/** The separator of a source-qualified event key (`models._CURSOR_KEY_SEPARATOR`). */
const KEY_SEPARATOR = '\u001f';


/** A plain cell value (`null` and empty read as nothing). */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** "2026-11-20 10:00:05 UTC" as the date and the time; any other text whole. */
export function timeParts(text: string): string[] {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d UTC)$/.exec(text);
  return m ? [m[1], m[2]] : [text];
}

/** Whether a row is one of the cited ids (a bare id or an index-qualified key). */
function rowMatches(row: CaseEventRow, ids: ReadonlySet<string>): boolean {
  if (ids.has(String(row.id))) return true;
  return Boolean(row.index) && ids.has(`${row.index}${KEY_SEPARATOR}${row.id}`);
}

/** Every leaf of a record as a dotted path and its printed value, at most `limit`. */
export function flattenRecord(
  value: unknown,
  limit = 500,
): { fields: Array<{ path: string; text: string }>; total: number } {
  const fields: Array<{ path: string; text: string }> = [];
  let total = 0;
  const visit = (node: unknown, path: string, depth: number) => {
    if (node !== null && typeof node === 'object' && depth < 12) {
      const entries: Array<[string, unknown]> = Array.isArray(node)
        ? node.map((item, i) => [`${path}[${i}]`, item])
        : Object.entries(node).map(([k, v]) => [path ? `${path}.${k}` : k, v]);
      if (!entries.length) {
        total += 1;
        if (fields.length < limit) fields.push({ path: path || '(record)', text: Array.isArray(node) ? '[]' : '{}' });
      }
      for (const [p, v] of entries) visit(v, p, depth + 1);
      return;
    }
    total += 1;
    if (fields.length < limit) fields.push({ path: path || '(record)', text: leafText(node) });
  };
  visit(value, '', 0);
  return { fields, total };
}

/** A file-name-safe piece of an id. */
function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'case';
}

/**
 * The values the Logs page takes from a link (`UnifiedLogs.tsx` `SOURCE_ID_RE` and
 * `RULE_RE`). Logs ignores a link whole when any part breaks them, so a source id or a
 * rule outside them is left out and the window still opens.
 */
const LOGS_SOURCE_ID_RE = /^[\w.:-]{1,128}$/;
const LOGS_RULE_RE = /^[^\p{C}\u2028\u2029]{1,256}$/u;

/** The Logs view over a window around `rows` (a minute either side), on one source. */
export function logsHrefFor(rows: readonly CaseEventRow[]): string | null {
  const times = rows.map((row) => Date.parse(row.ts)).filter((ms) => Number.isFinite(ms));
  if (!times.length) return null;
  const pad = 60_000;
  const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  const sources = new Set(
    rows.map((row) => row.source_id).filter((id): id is string => typeof id === 'string' && LOGS_SOURCE_ID_RE.test(id)),
  );
  const rules = new Set(
    rows
      .map((row) => row.rule)
      .filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '' && LOGS_RULE_RE.test(rule)),
  );
  return pageHash('logs', {
    from: iso(Math.min(...times) - pad),
    to: iso(Math.max(...times) + pad),
    ...(sources.size === 1 ? { sourceId: [...sources][0] } : {}),
    ...(rules.size === 1 ? { rule: [...rules][0] } : {}),
  });
}

interface LoadedEvents {
  rows: CaseEventRow[];
  last: CaseEventsPage;
  /** A page that came back unavailable, with why (the newest such page). */
  unavailable: CaseEventsUnavailableReason | null;
}

export const CaseEvents: React.FC<CaseEventsProps> = ({ caseId, filterEventIds = null, onClearFilter, load = getCaseEvents }) => {
  const { hasPermission } = useAuth();
  const canRead = hasPermission('sources', 'read');
  const [data, setData] = React.useState<LoadedEvents | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [reload, setReload] = React.useState(0);
  const [openRow, setOpenRow] = React.useState<CaseEventRow | null>(null);
  // The row's time button, so closing the sheet returns focus where it was (the sheet
  // opens from state, so Radix has no trigger of its own to return to).
  const opener = React.useRef<HTMLElement | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const fetchPage = React.useCallback(
    (cursor: string | null, previous: LoadedEvents | null) => {
      controller.current?.abort();
      const ctl = new AbortController();
      controller.current = ctl;
      setLoading(true);
      setError(null);
      let pending: Promise<CaseEventsPage>;
      try {
        pending = load(caseId, { limit: CASE_EVENTS_PAGE, cursor, signal: ctl.signal });
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending
        .then((page) => {
          if (ctl.signal.aborted) return;
          setData({
            rows: [...(previous?.rows ?? []), ...(page.rows ?? [])],
            last: page,
            unavailable: page.available ? (previous?.unavailable ?? null) : (page.reason ?? 'source_unavailable'),
          });
        })
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setError(e);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false);
        });
    },
    [caseId, load],
  );

  React.useEffect(() => {
    setData(null);
    setOpenRow(null);
    if (!canRead) return undefined;
    fetchPage(null, null);
    return () => controller.current?.abort();
  }, [canRead, fetchPage, reload]);

  const filter = React.useMemo(
    () => (filterEventIds && filterEventIds.length ? new Set(filterEventIds.map(String)) : null),
    [filterEventIds],
  );
  const rows = data?.rows ?? [];
  const shown = filter ? rows.filter((row) => rowMatches(row, filter)) : rows;
  const expected = data?.last.expected ?? 0;
  const next = data?.last.next_cursor ?? null;
  const missingCited = filter ? Math.max(0, filter.size - shown.length) : 0;
  const logsHref = logsHrefFor(shown);

  const downloadPage = () => {
    const text = shown.map((row) => JSON.stringify(row)).join('\n');
    downloadBlob(`${safeName(caseId)}-events.ndjson`, new Blob([text ? `${text}\n` : ''], { type: 'application/x-ndjson' }));
  };

  const header = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-sm font-semibold text-foreground">Events</h3>
      {data ? (
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="case-events-count">
          {rows.length === expected && !next
            ? `${expected.toLocaleString('en-US')} event${expected === 1 ? '' : 's'}`
            : `${rows.length.toLocaleString('en-US')} of ${expected.toLocaleString('en-US')} events shown`}
        </span>
      ) : null}
    </div>
  );

  if (!canRead) {
    return (
      <div className="space-y-1.5" data-testid="case-events">
        {header}
        <p className="text-sm text-muted-foreground">You cannot see the raw events. They need permission to read sources.</p>
      </div>
    );
  }

  return (
    <div className="@container/events min-w-0 space-y-2" data-testid="case-events">
      {header}

      {filter ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="case-events-filter">
          <span className="text-foreground">
            {`Showing the ${filter.size.toLocaleString('en-US')} event${filter.size === 1 ? '' : 's'} one finding cites.`}
            {missingCited
              ? next
                ? ` ${missingCited.toLocaleString('en-US')} ${missingCited === 1 ? 'is' : 'are'} not on the loaded pages.`
                : ` ${missingCited.toLocaleString('en-US')} could not be read from the source.`
              : ''}
          </span>
          {onClearFilter ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onClearFilter}>
              <X className="size-3.5" aria-hidden />
              Show all events
            </Button>
          ) : null}
        </div>
      ) : null}

      {!data && loading ? <LoadingState label="Loading the events" layout="inline" /> : null}

      {error ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p role="alert" className="text-critical-text">
            {error instanceof ApiError && error.status === 403
              ? 'You cannot read the events of this case.'
              : errorMessage(error, 'The events could not be loaded.')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : null}

      {data && data.unavailable && !rows.length ? (
        <p className="text-sm text-muted-foreground" data-testid="case-events-unavailable" data-reason={data.unavailable}>
          {UNAVAILABLE_WORDS[data.unavailable]}
        </p>
      ) : null}
      {data && !data.unavailable && !rows.length && !next && !error ? (
        <p className="text-sm text-muted-foreground">This case lists no events.</p>
      ) : null}
      {data && data.unavailable && rows.length ? (
        <p className="text-xs text-muted-foreground" data-reason={data.unavailable}>
          {`Some events could not be shown. ${UNAVAILABLE_WORDS[data.unavailable]}`}
        </p>
      ) : null}

      {shown.length ? (
        <>
          {/* Fixed layout: declared widths hold and a long value truncates in its cell, so
              the table never runs past the pane. Narrow panes keep the time and the
              message; the rule moves into the message cell. Each column joins only where
              the message keeps at least 12rem beside the fixed widths (the default
              1440 layout leaves it about 16rem), so the message is never the column that
              gives way. */}
          <Table
            layout="fixed"
            containerClassName="rounded-md border border-border"
            aria-label="Events behind this case"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {/* A narrow pane stacks the date over the time, so the message keeps its room. */}
                <TableHead density="compact" className="w-[7rem] @[36rem]/events:w-[12.75rem]">
                  Time
                </TableHead>
                <TableHead density="compact" className="hidden w-[30%] @[36rem]/events:table-cell">
                  Rule
                </TableHead>
                <TableHead density="compact" className="hidden w-[5.5rem] @[44rem]/events:table-cell">
                  Severity
                </TableHead>
                <TableHead density="compact" className="hidden w-[8.5rem] @[56rem]/events:table-cell">
                  Source IP
                </TableHead>
                <TableHead density="compact" className="hidden w-[8rem] @[80rem]/events:table-cell">
                  User
                </TableHead>
                <TableHead density="compact" className="hidden w-[8rem] @[80rem]/events:table-cell">
                  Host
                </TableHead>
                <TableHead density="compact">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row, index) => {
                const time = eventTime(row.ts);
                const cited = (row.in_evidence ?? []).map((i) => i + 1);
                const citedBadge = cited.length ? (
                  <Badge variant="outline" className="mt-0.5 h-5 max-w-full truncate px-1.5 text-2xs">
                    {`Cited by finding ${cited.join(', ')}`}
                  </Badge>
                ) : null;
                return (
                  <TableRow
                    key={`${row.index ?? ''}-${row.id}-${index}`}
                    className="cursor-pointer"
                    data-testid="case-event-row"
                    onClick={(event) => {
                      opener.current = event.currentTarget.querySelector('button');
                      setOpenRow(row);
                    }}
                  >
                    <TableCell density="compact" numeric className="whitespace-nowrap align-top">
                      <button
                        type="button"
                        aria-label={`Open event ${time}`}
                        aria-haspopup="dialog"
                        className="rounded-sm text-left font-mono text-xs text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {timeParts(time).map((part, i) => (
                          <span key={i} className="block @[36rem]/events:inline">
                            {i ? ' ' : ''}
                            {part}
                          </span>
                        ))}
                      </button>
                    </TableCell>
                    <TableCell density="compact" className="hidden align-top @[36rem]/events:table-cell">
                      <span className="block truncate text-xs" title={cell(row.rule)}>
                        {cell(row.rule) || 'No rule'}
                      </span>
                      {citedBadge}
                    </TableCell>
                    <TableCell density="compact" className="hidden truncate align-top text-xs @[44rem]/events:table-cell">
                      {cell(row.severity)}
                    </TableCell>
                    <TableCell density="compact" className="hidden truncate align-top font-mono text-xs @[56rem]/events:table-cell">
                      {cell(row.source_ip)}
                    </TableCell>
                    <TableCell density="compact" className="hidden align-top text-xs @[80rem]/events:table-cell">
                      <span className="block truncate" title={cell(row.user)}>
                        {cell(row.user)}
                      </span>
                    </TableCell>
                    <TableCell density="compact" className="hidden align-top text-xs @[80rem]/events:table-cell">
                      <span className="block truncate" title={cell(row.host)}>
                        {cell(row.host)}
                      </span>
                    </TableCell>
                    <TableCell density="compact" className="align-top">
                      <span className="block truncate text-xs text-muted-foreground @[36rem]/events:hidden" title={cell(row.rule)}>
                        {cell(row.rule) || 'No rule'}
                      </span>
                      <span className="block truncate text-xs text-foreground/90" title={cell(row.message)}>
                        {cell(row.message)}
                      </span>
                      <span className="@[36rem]/events:hidden">{citedBadge}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Event values are untrusted source data, shown as plain text and never run.
          </p>
        </>
      ) : null}

      {data ? (
        <div className="flex flex-wrap items-center gap-2">
          {next ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={loading}
              onClick={() => fetchPage(next, data)}
            >
              {loading ? 'Loading' : 'Load more events'}
            </Button>
          ) : null}
          {shown.length ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={downloadPage}>
              <Download className="size-3.5" aria-hidden />
              Download these events (NDJSON)
            </Button>
          ) : null}
          {logsHref ? (
            <a
              href={logsHref}
              className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              Open in Logs
            </a>
          ) : null}
        </div>
      ) : null}

      <EventSheet caseId={caseId} row={openRow} onClose={() => setOpenRow(null)} returnFocusTo={opener} />
    </div>
  );
};

type EventView = 'table' | 'json';

/** One event: every field as a path and a value, or the source record as JSON. */
const EventSheet: React.FC<{
  caseId: string;
  row: CaseEventRow | null;
  onClose: () => void;
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}> = ({ caseId, row, onClose, returnFocusTo }) => {
  const [view, setView] = React.useState<EventView>('table');
  const [announce, setAnnounce] = React.useState('');
  const record = React.useMemo(() => row?._raw ?? {}, [row]);
  const flat = React.useMemo(() => flattenRecord(record), [record]);
  const logsHref = row ? logsHrefFor([row]) : null;
  return (
    <Sheet open={row !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        size="lg"
        className="gap-0 overflow-y-auto p-0"
        data-testid="case-event-sheet"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {row ? (
          <div className="flex min-h-0 flex-col gap-4 p-5 pt-4">
            <SheetHeader className="pr-12 text-left">
              <SheetTitle>{`Event ${eventTime(row.ts)}`}</SheetTitle>
              <SheetDescription className="[overflow-wrap:anywhere]">
                {/* UNTRUSTED rule: plain text. */}
                {cell(row.rule) ? `Rule ${cell(row.rule)}` : 'No rule recorded'}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Event id</dt>
              <dd className="min-w-0">
                <InlineCode className="text-xs">{cell(row.id)}</InlineCode>
              </dd>
              {row.index ? (
                <>
                  <dt className="text-muted-foreground">Index</dt>
                  <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{cell(row.index)}</dd>
                </>
              ) : null}
              {row.source_id ? (
                <>
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{cell(row.source_id)}</dd>
                </>
              ) : null}
              {row.in_evidence?.length ? (
                <>
                  <dt className="text-muted-foreground">Cited by</dt>
                  <dd>{`Finding ${row.in_evidence.map((i) => i + 1).join(', ')}`}</dd>
                </>
              ) : null}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl<EventView>
                size="sm"
                aria-label="Show the event as"
                value={view}
                onValueChange={setView}
                options={[
                  { value: 'table', label: 'Table' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
              {logsHref ? (
                <a
                  href={logsHref}
                  className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open in Logs
                </a>
              ) : null}
            </div>
            <p aria-live="polite" className="sr-only">
              {announce}
            </p>
            {view === 'table' ? (
              <div className="min-w-0" data-testid="case-event-fields">
                <dl className="grid grid-cols-1 gap-y-1.5 rounded-md border border-border bg-card p-2 font-mono text-xs sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] sm:gap-x-3">
                  {flat.fields.map((field, index) => (
                    <React.Fragment key={`${field.path}-${index}`}>
                      <dt className="text-muted-foreground [overflow-wrap:anywhere]">{field.path}</dt>
                      <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{field.text}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                {flat.total > flat.fields.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {`and ${(flat.total - flat.fields.length).toLocaleString('en-US')} more fields; the JSON view has them all.`}
                  </p>
                ) : null}
              </div>
            ) : (
              <JsonViewer
                value={record}
                label="Event record"
                filename={`${safeName(caseId)}-event-${safeName(String(row.id))}.json`}
                onCopied={(ok) => setAnnounce(ok ? 'Copied the event record.' : 'Could not copy the event record.')}
              />
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
};

export default CaseEvents;
