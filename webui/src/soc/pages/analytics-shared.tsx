/**
 * Shared pieces of the Analytics pages: Metrics, Agent effectiveness and Cost (Round 14,
 * SPEC §4.9: one console grammar).
 *
 *  - The Analytics time range: one set of windows (last 24 hours, 7 days, 30 days), shown
 *    with the Overview's `TimeRangePicker` pill in each page header, and remembered for the
 *    session so moving between Metrics, Agent effectiveness and Cost keeps the range the
 *    operator picked (each is its own page, so each mounts afresh).
 *  - `RouteTextLink`: an in-app link (`<a href>`, SPEC §3.3) whose plain click goes through
 *    the router, so a route-leave guard is asked first.
 *  - `SortToggle`: the Count or A to Z switch a ranked module carries in its own title row.
 *  - `StripPanel`: a titled panel whose body is a compact strip of figures (the strip
 *    grammar inside a module, never a card inside a panel).
 *  - `shareOfTotal`: a bar's share of the whole it belongs to ("51% of 77"), never of the
 *    largest bar.
 *  - `UpdatedStamp`: the header freshness line ("Updated 2m ago").
 *  - `useCappedRows` and `ShowAllToggle`: a long list shows its first rows and offers the
 *    rest ("Show all 18"), never cutting rows silently (AN1).
 *  - `tokenLabel`: an enum token as a sentence-case label that keeps known acronyms
 *    ("rag" reads "RAG", "mitre" reads "MITRE").
 *
 * Lazy only: imported by the Analytics page chunk, never by an entry module (SPEC §3.4).
 * Keep it inside that chunk: a second lazy importer (Standup, under Home) would split it
 * into its own chunk, and every chunk adds a preload-map entry to the entry bundle.
 * SECURITY (#9): every label passed in is rendered as plain text.
 */
import * as React from 'react';

import type { NavOpts } from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import { onSignedOut } from '@/lib/session-events';
import { Panel } from '@/design-system/panel';

import { Button } from '@/ui/button';

import { KpiStripContext, KpiTileGrid } from '@/soc/components/KpiTile';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { TimeRangePicker, type TimeRange } from '@/soc/components/TimeRangePicker';
import { pageHash, useNavigateOptional, type Navigate, type PageId } from '@/soc/router';

/* ----------------------------------------------------------------- windows - */

/** One Analytics time range: its hours, the picker preset and the caption a module shows. */
export interface AnalyticsWindow {
  hours: number;
  range: TimeRange;
  /** Lower-case caption for a module title row, for example "last 7 days". */
  caption: string;
}

/** The ranges every Analytics page offers, in order (the backend accepts any hours). */
export const ANALYTICS_WINDOWS: readonly AnalyticsWindow[] = [
  { hours: 24, range: { from: 'now-24h', to: 'now', label: 'Last 24 hours' }, caption: 'last 24 hours' },
  { hours: 168, range: { from: 'now-7d', to: 'now', label: 'Last 7 days' }, caption: 'last 7 days' },
  { hours: 720, range: { from: 'now-30d', to: 'now', label: 'Last 30 days' }, caption: 'last 30 days' },
];

/** The default Analytics range: the last 7 days. */
export const DEFAULT_ANALYTICS_HOURS = 168;

const PRESETS: readonly TimeRange[] = ANALYTICS_WINDOWS.map((w) => w.range);

/** The window for `hours` (the default window when `hours` is not one of the presets). */
export function analyticsWindow(hours: number): AnalyticsWindow {
  return (
    ANALYTICS_WINDOWS.find((w) => w.hours === hours) ??
    ANALYTICS_WINDOWS.find((w) => w.hours === DEFAULT_ANALYTICS_HOURS) ??
    ANALYTICS_WINDOWS[0]
  );
}

/** The caption for a module measured over `hours` ("last 24 hours"). */
export function windowCaption(hours: number): string {
  return analyticsWindow(hours).caption;
}

/**
 * The range picked last by the person signed in to this tab (a module value, so it
 * outlives a page change). It is theirs: a sign-out, an ended session or another person
 * signing in forgets it, so the next person starts on the default range.
 */
let rememberedHours = DEFAULT_ANALYTICS_HOURS;

/** Forget the remembered range: the next Analytics page opens on the default range. */
export function resetAnalyticsWindow(): void {
  rememberedHours = DEFAULT_ANALYTICS_HOURS;
}

onSignedOut(resetAnalyticsWindow);

/**
 * The Analytics range, shared by the Analytics pages for the session: `[hours, setHours]`.
 * Metrics, Agent effectiveness and Cost are separate pages (the navigation switches them),
 * so the choice lives outside the component that shows it.
 */
export function useAnalyticsWindow(): [number, (hours: number) => void] {
  const [hours, setHoursState] = React.useState(rememberedHours);
  const setHours = React.useCallback((next: number) => {
    const known = ANALYTICS_WINDOWS.some((w) => w.hours === next) ? next : DEFAULT_ANALYTICS_HOURS;
    rememberedHours = known;
    setHoursState(known);
  }, []);
  return [hours, setHours];
}

/** The page header's range control: the Overview's pill with the Analytics presets. */
export function AnalyticsWindowPicker({
  hours,
  onChange,
  presets,
}: {
  hours: number;
  onChange: (hours: number) => void;
  /** A page that offers fewer ranges passes its own windows. */
  presets?: readonly AnalyticsWindow[];
}) {
  const windows = presets ?? ANALYTICS_WINDOWS;
  const current = windows.find((w) => w.hours === hours) ?? windows[0];
  return (
    <TimeRangePicker
      value={current.range}
      presets={presets ? windows.map((w) => w.range) : PRESETS}
      onChange={(range) => {
        const picked = windows.find((w) => w.range.from === range.from && w.range.to === range.to);
        if (picked) onChange(picked.hours);
      }}
      size="sm"
      chrome="command"
    />
  );
}

/* ------------------------------------------------------------------- links - */

export interface RouteTextLinkProps {
  page: PageId;
  opts?: NavOpts;
  /** A host-supplied navigate (tests and embedded hosts); the router's otherwise. */
  onNavigate?: Navigate;
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
  title?: string;
}

/**
 * A text link to a Console page. It is an `<a href>` (SPEC §3.3), so it opens in a new tab
 * on a modified click; a plain click navigates through the router (or `onNavigate`).
 */
export function RouteTextLink({
  page,
  opts,
  onNavigate,
  children,
  className,
  'aria-label': ariaLabel,
  title,
}: RouteTextLinkProps) {
  const routerNavigate = useNavigateOptional();
  const navigate = onNavigate ?? routerNavigate;
  const href = pageHash(page, opts);
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      title={title}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        navigate(page, opts);
      }}
      className={cn(
        'rounded-sm font-medium text-primary underline-offset-2 hover:underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
        className,
      )}
    >
      {children}
    </a>
  );
}

/* -------------------------------------------------------------------- sort - */

export type RankSort = 'count' | 'alpha';

/** The Count or A to Z switch of one ranked module (it sorts only that module). */
export function SortToggle({
  label,
  value,
  onChange,
}: {
  /** The accessible name, naming what it sorts ("Sort persona usage"). */
  label: string;
  value: RankSort;
  onChange: (value: RankSort) => void;
}) {
  return (
    <SegmentedControl<RankSort>
      aria-label={label}
      size="sm"
      value={value}
      onValueChange={onChange}
      options={[
        { value: 'count', label: 'Count' },
        { value: 'alpha', label: 'A to Z' },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ shares - */

/**
 * A part's share of its whole as a caption: "51% of 77". Rounded to a whole percent; a
 * part above zero that rounds to nothing reads "<1% of 77", never "0%". `undefined` when
 * the whole is not a positive number (nothing honest to say).
 */
export function shareOfTotal(value: number, total: number, format: (n: number) => string = fmtNumber): string | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return undefined;
  const pct = (Math.max(0, value) / total) * 100;
  const rounded = Math.round(pct);
  const label = value > 0 && rounded === 0 ? '<1%' : `${Math.min(100, rounded)}%`;
  return `${label} of ${format(total)}`;
}

/* ------------------------------------------------------------------ labels - */

/** Words that stay upper case inside a humanised token. */
const ACRONYMS: ReadonlySet<string> = new Set([
  'ai', 'api', 'edr', 'ioc', 'ip', 'llm', 'mitre', 'rag', 'siem', 'sla', 'soc', 'sso', 'ttl', 'url', 'id',
]);

/**
 * An enum token (a role, a surface, a source kind) as a sentence-case label that keeps the
 * acronyms it holds: "rag" reads "RAG", "llm_router" reads "LLM router", never "Rag". An
 * empty token reads as the dash.
 */
export function tokenLabel(token: string | null | undefined): string {
  const label = humanizeToken(token);
  if (label === DASH) return DASH;
  return label
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');
}

/* ------------------------------------------------------------- strip panel - */

/**
 * A titled module whose body is a compact strip of figures: the panel's title row, then
 * strip tiles on the panel (hairlines only between tiles). Put `KpiTile`s inside; the
 * panel tells them their strip density, so they need no chrome props.
 */
export function StripPanel({
  title,
  caption,
  count,
  aside,
  children,
  className,
  'data-testid': testId,
}: {
  title: string;
  caption?: React.ReactNode;
  count?: number;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  const tiles = React.Children.toArray(children).filter(Boolean);
  const context = React.useMemo(() => ({ density: 'compact' as const }), []);
  return (
    <Panel title={title} caption={caption} count={count} aside={aside} padding="none" className={className} data-testid={testId}>
      <KpiStripContext.Provider value={context}>
        <KpiTileGrid count={tiles.length} surface="panel" data-strip-panel="">
          {tiles}
        </KpiTileGrid>
      </KpiStripContext.Provider>
    </Panel>
  );
}

/* ------------------------------------------------------------ capped lists - */

/**
 * A list that shows its first `cap` rows until the reader asks for the rest (AN1: a long
 * list caps its rows with "Show all", never silently). `listId` names the list for the
 * toggle's `aria-controls`; the list is rendered in both states.
 */
export function useCappedRows<T>(rows: readonly T[], cap: number) {
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const capped = rows.length > cap;
  const shown = expanded || !capped ? rows : rows.slice(0, cap);
  const toggle = React.useCallback(() => setExpanded((open) => !open), []);
  return { shown, expanded, capped, hidden: rows.length - shown.length, listId, toggle };
}

/**
 * The toggle of a capped list, for the panel's actions. `complete` says the rows in hand
 * are every row there is ("Show all 18"); otherwise the server sent only the first part
 * and the button offers what it has ("Show 2 more").
 */
export function ShowAllToggle({
  total,
  hidden,
  expanded,
  controls,
  onToggle,
  complete = true,
}: {
  /** Every row in hand. */
  total: number;
  /** The rows the collapsed list leaves out. */
  hidden: number;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  complete?: boolean;
}) {
  return (
    <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {expanded ? 'Show fewer' : complete ? `Show all ${fmtNumber(total)}` : `Show ${fmtNumber(hidden)} more`}
    </Button>
  );
}

/* --------------------------------------------------------------- freshness - */

/** Re-render every `ms` while mounted (a relative time stays true). */
function useTick(ms: number): void {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/**
 * The header's freshness line: when the page's figures were last read ("Updated just
 * now", "Updated 4m ago"), with the exact local time in the tooltip. Nothing before the
 * first successful read.
 */
export function UpdatedStamp({ at }: { at: string | null | undefined }) {
  useTick(30_000);
  if (!at) return null;
  const age = humanizeAge(at);
  if (!age || age === DASH) return null;
  let exact: string | undefined;
  const parsed = Date.parse(at);
  if (!Number.isNaN(parsed)) {
    exact = new Date(parsed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return (
    <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground" title={exact} data-testid="analytics-updated">
      Updated {age}
    </span>
  );
}
