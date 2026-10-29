/**
 * The audit event list (Round 14 SPEC §4.5.1, §4.5.7): one keyboard grid with a single
 * roving tab stop, on the page's full-bleed panel.
 *
 * Columns, left to right: Time, Outcome (column 2, so it stays in view beside an open
 * 560 px inspector), Event, Actor, Target and Summary. A phone shows Time, Outcome and
 * Event; below 1280 px Target folds away. `table-layout: fixed` keeps every column on one
 * line: a long value truncates with its full text in `title`, nothing wraps and nothing
 * scrolls sideways (F5).
 *
 * Keyboard: Up and Down move; J and K move and open the record (focus stays on the row);
 * Enter opens it (focus moves to the inspector title); Home and End jump; Enter or Space
 * on an investigation row shows or hides its steps. Moving past the last loaded row loads
 * the next page and continues there. Every value is a plain text node (#9).
 */
import * as React from 'react';
import { ChevronDown, ChevronRight, Workflow } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AuditRecord } from '@/lib/types-audit';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { pageHash } from '@/soc/router';
import { useRouteLinkClick } from '@/soc/route-link';

import {
  formatRowTime,
  groupOutcome,
  groupTitle,
  summaryText,
  targetText,
  type AuditTimeZone,
  type GroupItem,
  type ListItem,
} from './audit-model';
import { ActorMark, OutcomeMark } from './parts';

/** How a record was opened: a click or Enter moves focus to the inspector; J and K do not. */
export type OpenVia = 'click' | 'enter' | 'key';

export type AuditTableLayout = 'phone' | 'medium' | 'wide';

export interface AuditTableProps {
  items: readonly ListItem[];
  layout: AuditTableLayout;
  zone: AuditTimeZone;
  onZoneChange: (zone: AuditTimeZone) => void;
  order: 'desc' | 'asc';
  onOrderChange: (order: 'desc' | 'asc') => void;
  /** The record the inspector shows. */
  selectedId: string | null;
  onOpen: (record: AuditRecord, via: OpenVia) => void;
  onToggleGroup: (runId: string) => void;
  /** More rows exist past the last loaded one. */
  hasMore: boolean;
  /**
   * Load more can run now. False while a read of the list is in flight (its rows replace
   * these): an investigation's Load more is disabled and a move past the last row stays.
   */
  canLoadMore: boolean;
  /** Load the next page; resolves true when rows were added. */
  onLoadMore: () => Promise<boolean>;
  /** Case links in investigation rows (`cases:read`). */
  canOpenCase: boolean;
  /** The row elements, so a closing inspector can hand focus back. */
  registerRow: (id: string, el: HTMLElement | null) => void;
  className?: string;
}

const groupStopId = (runId: string) => `group:${runId}`;

interface Stop {
  id: string;
  record?: AuditRecord;
  group?: GroupItem;
}

function stopsOf(items: readonly ListItem[]): Stop[] {
  return items.map((item) =>
    item.kind === 'group' ? { id: groupStopId(item.runId), group: item } : { id: item.record.record_id, record: item.record },
  );
}

const ROW_FOCUS =
  'cursor-pointer outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
/**
 * The row the inspector shows: the table's selected tint plus a 2 px bar on its leading
 * edge (the Case Manager queue's open-row bar), so selection is never colour alone; in
 * forced colours, where tints flatten, an outline marks it.
 */
const SELECTED_ROW =
  'forced-colors:data-[state=selected]:outline forced-colors:data-[state=selected]:outline-2 forced-colors:data-[state=selected]:-outline-offset-2';
const SELECTED_BAR =
  "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary before:content-['']";

/** The Time column header: a menu for the time zone (D10) and the order. */
function TimeHeader({
  zone,
  onZoneChange,
  order,
  onOrderChange,
}: Pick<AuditTableProps, 'zone' | 'onZoneChange' | 'order' | 'onOrderChange'>) {
  const label = zone === 'utc' ? 'Time (UTC)' : 'Time (local)';
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${label}, ${order === 'desc' ? 'newest first' : 'oldest first'}. Change time zone or order`}
        >
          {label}
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {/* Two radio groups: the current choice is `aria-checked` (menuitemradio), with its mark. */}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Show times in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={zone} onValueChange={(z) => onZoneChange(z === 'local' ? 'local' : 'utc')}>
          <DropdownMenuRadioItem value="utc">UTC</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="local">Local time</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Order</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={order} onValueChange={(o) => onOrderChange(o === 'asc' ? 'asc' : 'desc')}>
          <DropdownMenuRadioItem value="desc">Newest first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="asc">Oldest first</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CaseTraceLink({ caseId, tabIndex }: { caseId: string; tabIndex: number }) {
  const href = pageHash('case_manager', { caseId });
  const onClick = useRouteLinkClick(href, (e) => e.stopPropagation());
  return (
    <a
      href={href}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={(e) => e.stopPropagation()}
      className="whitespace-nowrap rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Open case trace
    </a>
  );
}

export function AuditTable({
  items,
  layout,
  zone,
  onZoneChange,
  order,
  onOrderChange,
  selectedId,
  onOpen,
  onToggleGroup,
  hasMore,
  canLoadMore,
  onLoadMore,
  canOpenCase,
  registerRow,
  className,
}: AuditTableProps) {
  const rowEls = React.useRef(new Map<string, HTMLTableRowElement>());
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const stops = React.useMemo(() => stopsOf(items), [items]);
  // Runs whose steps are listed under their group row.
  const openRuns = React.useMemo(
    () => new Set(items.flatMap((i) => (i.kind === 'row' && i.child && i.record.run_id ? [i.record.run_id] : []))),
    [items],
  );
  // A move past the last row waits for the next page, then continues from there. When
  // the page has landed (`settled`) without a stop after the origin (in Agent activity
  // every row may fold into a group already listed), the move ends there, so the next
  // move past the end asks for the page after it.
  const pendingRef = React.useRef<{ from: string; open: boolean; settled: boolean } | null>(null);
  const [settleTick, setSettleTick] = React.useState(0);
  const nowMs = Date.now();

  const has = (id: string | null) => Boolean(id && stops.some((s) => s.id === id));
  const tabStop = has(focusId) ? focusId : has(selectedId) ? selectedId : stops[0]?.id ?? null;

  const focusStop = React.useCallback((stop: Stop, open: boolean) => {
    setFocusId(stop.id);
    rowEls.current.get(stop.id)?.focus();
    if (open && stop.record) onOpen(stop.record, 'key');
  }, [onOpen]);

  const move = (fromId: string, delta: number, open: boolean) => {
    const at = stops.findIndex((s) => s.id === fromId);
    const index = at + delta;
    if (index >= stops.length) {
      if (hasMore && canLoadMore && !pendingRef.current) {
        const pending = { from: fromId, open, settled: false };
        pendingRef.current = pending;
        void onLoadMore().then((added) => {
          if (pendingRef.current !== pending) return;
          if (!added) {
            pendingRef.current = null;
            return;
          }
          pending.settled = true;
          // Re-run the effect below with the rows this page added.
          setSettleTick((t) => t + 1);
        });
      }
      return;
    }
    const next = stops[Math.max(0, index)];
    if (next && next.id !== fromId) focusStop(next, open);
  };

  // The next page arrived: finish the move that asked for it, or end it when the page
  // added no stop after the origin.
  React.useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const at = stops.findIndex((s) => s.id === pending.from);
    const next = at >= 0 ? stops[at + 1] : undefined;
    if (!next) {
      if (pending.settled) pendingRef.current = null;
      return;
    }
    pendingRef.current = null;
    focusStop(next, pending.open);
  }, [stops, focusStop, settleTick]);

  const activate = (stop: Stop, via: OpenVia) => {
    if (stop.group) onToggleGroup(stop.group.runId);
    else if (stop.record) onOpen(stop.record, via);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-row-id]');
    if (!row || e.target !== row || e.altKey || e.ctrlKey || e.metaKey) return;
    const id = row.dataset.rowId ?? '';
    const stop = stops.find((s) => s.id === id);
    if (!stop) return;
    const key = e.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') move(id, key === 'ArrowDown' ? 1 : -1, false);
    else if (key === 'j' || key === 'J' || key === 'k' || key === 'K') move(id, key.toLowerCase() === 'j' ? 1 : -1, true);
    else if (key === 'Home') focusStop(stops[0], false);
    else if (key === 'End') focusStop(stops[stops.length - 1], false);
    else if (key === 'Enter') activate(stop, 'enter');
    else if (key === ' ' && stop.group) activate(stop, 'enter');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const rowRef = (id: string) => (el: HTMLTableRowElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
    registerRow(id, el);
  };

  const phone = layout === 'phone';
  const showActor = !phone;
  const showTarget = layout === 'wide';
  const showSummary = !phone;
  // A phone has room for three columns only: tighter cell padding, and the event name may
  // take two lines rather than truncate to a word.
  const timePad = phone ? 'px-3' : undefined;
  const outcomePad = phone ? 'px-2' : 'pr-2';
  const eventPad = phone ? 'pl-2 pr-3' : undefined;
  const columns = 3 + (showActor ? 1 : 0) + (showTarget ? 1 : 0) + (showSummary ? 1 : 0);

  const recordCells = (record: AuditRecord, child: boolean, selected: boolean) => {
    const target = targetText(record);
    const summary = summaryText(record);
    const time = formatRowTime(record.ts, zone, nowMs);
    return (
      <>
        <TableCell density="compact" numeric className={cn('relative truncate text-muted-foreground', timePad, selected && SELECTED_BAR)}>
          <time dateTime={record.ts} title={record.ts}>
            {time}
          </time>
        </TableCell>
        <TableCell density="compact" className={outcomePad}>
          <OutcomeMark record={record} className="max-w-full text-sm" />
        </TableCell>
        <TableCell density="compact" className={cn('min-w-0', eventPad, child && (phone ? 'pl-6' : 'pl-7'))}>
          {/* A phone wraps the name over two lines at word boundaries, the Demo badge on a
              line of its own; wider screens keep one line, the badge at the cell's end. */}
          <span className={cn('flex min-w-0', phone ? 'flex-col items-start gap-0.5' : 'items-center gap-2')}>
            <span
              className={cn('min-w-0 font-medium text-foreground', phone ? 'line-clamp-2 max-w-full' : 'block flex-1 truncate')}
              title={record.event_label}
            >
              {record.event_label}
            </span>
            {record.demo ? (
              <span className={cn('shrink-0 rounded-sm border border-border px-1 text-2xs text-muted-foreground', !phone && 'ml-auto')}>
                Demo
              </span>
            ) : null}
          </span>
        </TableCell>
        {showActor ? (
          <TableCell density="compact" className="min-w-0">
            <ActorMark record={record} />
          </TableCell>
        ) : null}
        {showTarget ? (
          <TableCell density="compact" className="min-w-0">
            {target ? (
              <span
                className={cn('block truncate', record.target?.type === 'case' || (!record.target && record.case_id) ? 'font-mono text-xs' : '')}
                title={target}
              >
                {target}
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span aria-hidden>-</span>
                <span className="sr-only">No target</span>
              </span>
            )}
          </TableCell>
        ) : null}
        {showSummary ? (
          <TableCell density="compact" className="min-w-0 text-muted-foreground">
            <span className="block truncate" title={summary || undefined}>
              {summary}
            </span>
          </TableCell>
        ) : null}
      </>
    );
  };

  return (
    <div className={cn('min-w-0', className)} data-audit-list="">
      <Table
        unwrapped
        layout="fixed"
        role="grid"
        aria-label="Audit events"
        aria-describedby="audit-list-keys"
        className="min-w-0"
      >
        <colgroup>
          <col className={phone ? 'w-[8rem]' : 'w-[9.5rem]'} />
          <col className={phone ? 'w-[7.5rem]' : 'w-[8rem]'} />
          <col className={phone ? undefined : 'w-[14rem] min-[1440px]:w-[15rem] 2xl:w-[18rem]'} />
          {showActor ? <col className="w-[9rem] 2xl:w-[10rem]" /> : null}
          {showTarget ? <col className="w-[11rem] 2xl:w-[13rem]" /> : null}
          {showSummary ? <col /> : null}
        </colgroup>
        <TableHeader sticky>
          <TableRow className="hover:bg-transparent">
            <TableHead density="compact" scope="col" aria-sort={order === 'desc' ? 'descending' : 'ascending'} className={timePad}>
              <TimeHeader zone={zone} onZoneChange={onZoneChange} order={order} onOrderChange={onOrderChange} />
            </TableHead>
            <TableHead density="compact" scope="col" className={phone ? outcomePad : undefined}>
              Outcome
            </TableHead>
            <TableHead density="compact" scope="col" className={eventPad}>
              Event
            </TableHead>
            {showActor ? (
              <TableHead density="compact" scope="col">
                Actor
              </TableHead>
            ) : null}
            {showTarget ? (
              <TableHead density="compact" scope="col">
                Target
              </TableHead>
            ) : null}
            {showSummary ? (
              <TableHead density="compact" scope="col">
                Summary
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody onKeyDown={onKeyDown}>
          {items.map((item) => {
            if (item.kind === 'group') {
              const id = groupStopId(item.runId);
              const first = item.records[0];
              const { title, detail } = groupTitle(item);
              const open = openRuns.has(item.runId);
              const partial = item.records.length < item.total;
              const inner = id === tabStop ? 0 : -1;
              const chevron = (
                <ChevronRight
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-standard motion-reduce:transition-none',
                    phone && 'mt-0.5',
                    open && 'rotate-90',
                  )}
                  aria-hidden
                />
              );
              const loadMoreHere = partial && hasMore;
              const traceHere = Boolean(item.caseId && canOpenCase);
              const actions =
                loadMoreHere || traceHere ? (
                  <span className="contents" data-testid="audit-group-actions">
                    {loadMoreHere ? (
                      <button
                        type="button"
                        tabIndex={inner}
                        // Stays focusable while a read is in flight (the roving focus
                        // never lands on nothing) and never toggles the row it sits in.
                        aria-disabled={canLoadMore ? undefined : true}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (canLoadMore) void onLoadMore();
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
                      >
                        Load more
                      </button>
                    ) : null}
                    {traceHere && item.caseId ? <CaseTraceLink caseId={item.caseId} tabIndex={inner} /> : null}
                  </span>
                ) : null;
              return (
                <TableRow
                  key={id}
                  ref={rowRef(id)}
                  data-row-id={id}
                  data-audit-group=""
                  tabIndex={inner}
                  aria-expanded={open}
                  onFocus={() => setFocusId(id)}
                  onClick={() => onToggleGroup(item.runId)}
                  className={cn(ROW_FOCUS, 'bg-muted/40')}
                >
                  {phone ? (
                    // A phone has one narrow Event column: the investigation takes the
                    // whole row, its title first, then its time, outcome and steps, then
                    // its actions, each on a line of its own.
                    <TableCell density="compact" colSpan={columns} className="min-w-0 px-3">
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="flex min-w-0 items-start gap-2">
                          {chevron}
                          <Workflow className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                          <span className="line-clamp-2 min-w-0 font-medium text-foreground [overflow-wrap:anywhere]" title={title}>
                            {title}
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-12 text-xs text-muted-foreground">
                          <time dateTime={first.ts} title={first.ts} className="tabular-nums">
                            {formatRowTime(first.ts, zone, nowMs)}
                          </time>
                          <span aria-hidden>·</span>
                          <OutcomeMark record={{ outcome: groupOutcome(item.records), outcome_derived: false }} />
                          <span aria-hidden>·</span>
                          <span>{detail}</span>
                        </span>
                        {actions ? <span className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12">{actions}</span> : null}
                      </span>
                    </TableCell>
                  ) : (
                    <>
                      <TableCell density="compact" numeric className={cn('truncate text-muted-foreground', timePad)}>
                        <time dateTime={first.ts} title={first.ts}>
                          {formatRowTime(first.ts, zone, nowMs)}
                        </time>
                      </TableCell>
                      <TableCell density="compact" className={outcomePad}>
                        <OutcomeMark record={{ outcome: groupOutcome(item.records), outcome_derived: false }} className="max-w-full text-sm" />
                      </TableCell>
                      <TableCell density="compact" colSpan={columns - 2} className={cn('min-w-0', eventPad)}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            {chevron}
                            <Workflow className="size-4 shrink-0 text-primary" aria-hidden />
                            <span className="min-w-0 truncate font-medium text-foreground" title={title}>
                              {title}
                            </span>
                            <span className="min-w-0 truncate text-muted-foreground">· {detail}</span>
                          </span>
                          {actions ? <span className="ml-auto flex shrink-0 items-center gap-3">{actions}</span> : null}
                        </span>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              );
            }
            const r = item.record;
            const selected = r.record_id === selectedId;
            return (
              <TableRow
                key={r.record_id}
                ref={rowRef(r.record_id)}
                data-row-id={r.record_id}
                tabIndex={r.record_id === tabStop ? 0 : -1}
                aria-selected={selected}
                data-state={selected ? 'selected' : undefined}
                onFocus={() => setFocusId(r.record_id)}
                onClick={() => {
                  setFocusId(r.record_id);
                  onOpen(r, 'click');
                }}
                className={cn(ROW_FOCUS, SELECTED_ROW)}
              >
                {recordCells(r, item.child, selected)}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p id="audit-list-keys" className="sr-only">
        Up and Down move between events. J and K move and open the event. Enter opens the event.
      </p>
    </div>
  );
}
