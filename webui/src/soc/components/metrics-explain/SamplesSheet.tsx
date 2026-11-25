/**
 * The cases behind a lifecycle median, in a side sheet (Round 16 SPEC §4.5 WP12;
 * research explainability §5.1 "Show all N").
 *
 * One row per measured case from `GET /api/metrics/explain`: its rank in the sorted
 * times, the case, the time in words and in minutes, where the clock started and what
 * stopped it, and who the case records as its decider. The median's rows are marked, so
 * a reader can check the figure. Sortable by time or by case. Every case value is a
 * text node (#9).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';
import type { MetricExplainResponse, MetricExplainSample } from '@/lib/types-metrics-explain';
import { isSafeCaseId } from '@/soc/case-result-route';
import { RouteTextLink } from '@/soc/pages/analytics-shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';

import { ANCHOR_WORDS, DECIDER_WORDS, sampleMinutes } from './builders';

type SortKey = 'time_asc' | 'time_desc' | 'case';

export interface SamplesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  data: MetricExplainResponse | null;
  /** Where focus goes when the sheet closes (the explain trigger). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** The 0-based ranks the median interpolates between, for `n` sorted samples. */
export function medianRanks(n: number): number[] {
  if (n <= 0) return [];
  const rank = 0.5 * (n - 1);
  return Array.from(new Set([Math.floor(rank), Math.ceil(rank)]));
}

function sorted(rows: readonly MetricExplainSample[], offset: number, sort: SortKey) {
  const ranked = rows.map((row, index) => ({ row, rank: offset + index }));
  if (sort === 'time_desc') return [...ranked].reverse();
  if (sort === 'case') {
    return [...ranked].sort((a, b) => (a.row.case_number || a.row.case_id).localeCompare(b.row.case_number || b.row.case_id));
  }
  return ranked;
}

export function SamplesSheet({ open, onOpenChange, title, data, onCloseAutoFocus }: SamplesSheetProps) {
  const [sort, setSort] = React.useState<SortKey>('time_asc');
  const rows = data?.samples ?? [];
  const offset = data?.samples_offset ?? 0;
  const median = data && data.hidden_by_scope === 0 ? new Set(medianRanks(data.visible_count)) : new Set<number>();
  const notes: string[] = [];
  if (data) {
    if (data.samples_withheld) notes.push(data.samples_withheld);
    if (data.samples_truncated) {
      notes.push(
        `Showing ranks ${(offset + 1).toLocaleString('en-US')} to ${(offset + rows.length).toLocaleString('en-US')} of ${data.visible_count.toLocaleString('en-US')}: the cases around the median.`,
      );
    }
    if (data.hidden_by_scope > 0) {
      notes.push(
        `${data.hidden_by_scope.toLocaleString('en-US')} of ${data.sample_count.toLocaleString('en-US')} cases are outside your data scope. They count in the figure but are not listed, so the median cannot be checked from this list.`,
      );
    }
    if (data.truncated) {
      notes.push(
        `The figure was computed over the newest ${data.fetched.toLocaleString('en-US')} of ${data.store_total.toLocaleString('en-US')} cases.`,
      );
    }
  }
  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => setSort(key)}
      aria-pressed={sort === key}
      className={cn(
        'rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        sort === key ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-hover',
      )}
    >
      {label}
    </button>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-3xl" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <SheetTitle>{`${title}: the cases behind it`}</SheetTitle>
          <SheetDescription>{data ? `${data.population} Window: ${data.window}.` : 'Loading the cases.'}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4" data-testid="metric-samples-sheet">
          {notes.length ? (
            <ul className="mb-3 space-y-1 text-xs leading-relaxed text-muted-foreground" data-testid="metric-samples-notes">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Sort the cases">
            {sortButton('time_asc', 'Shortest first')}
            {sortButton('time_desc', 'Longest first')}
            {sortButton('case', 'By case')}
          </div>
          {/* Every cell keeps to one line (a case id or a date never breaks); at phone
              width the table scrolls sideways inside its own frame, not the page. */}
          <Table aria-label={`${title} cases`} className="whitespace-nowrap" containerClassName="rounded-md border border-border/70">
            <TableHeader>
              <TableRow>
                <TableHead density="compact">Rank</TableHead>
                <TableHead density="compact">Case</TableHead>
                <TableHead density="compact">Time</TableHead>
                <TableHead density="compact">Started</TableHead>
                <TableHead density="compact">Stopped</TableHead>
                <TableHead density="compact">Decided by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted(rows, offset, sort).map(({ row, rank }) => {
                const label = row.case_number || row.case_id;
                const isMedian = median.has(rank);
                return (
                  <TableRow key={`${row.case_id}-${rank}`} data-testid="metric-sample-row" data-median={isMedian ? '' : undefined}>
                    <TableCell className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                      {(rank + 1).toLocaleString('en-US')}
                      {isMedian ? <span className="ml-1 font-medium text-foreground">Median</span> : null}
                    </TableCell>
                    <TableCell className="px-4 py-2">
                      {isSafeCaseId(row.case_id) ? (
                        <RouteTextLink page="case_manager" opts={{ caseId: row.case_id }} className="font-mono text-xs" aria-label={`Open ${label}`}>
                          {label}
                        </RouteTextLink>
                      ) : (
                        <span className="font-mono text-xs">{label}</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-2 text-xs tabular-nums">{sampleMinutes(row)}</TableCell>
                    <TableCell className="px-4 py-2 text-xs text-muted-foreground">
                      <span className="block">{ANCHOR_WORDS[row.start_anchor ?? ''] ?? row.start_anchor ?? ''}</span>
                      <span className="block tabular-nums">{row.start_at ? formatTimestamp(row.start_at) : ''}</span>
                    </TableCell>
                    <TableCell className="px-4 py-2 text-xs text-muted-foreground">
                      <span className="block">{ANCHOR_WORDS[row.anchor ?? ''] ?? row.anchor ?? ''}</span>
                      <span className="block tabular-nums">{row.end_at ? formatTimestamp(row.end_at) : ''}</span>
                    </TableCell>
                    <TableCell className="px-4 py-2 text-xs text-muted-foreground">
                      {row.decided_by ? DECIDER_WORDS[row.decided_by] ?? row.decided_by : ''}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {data && !rows.length && !data.samples_withheld ? (
            <p className="mt-3 text-sm text-muted-foreground">No case in this window has this figure.</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
