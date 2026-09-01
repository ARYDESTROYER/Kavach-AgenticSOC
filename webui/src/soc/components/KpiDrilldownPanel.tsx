/**
 * KpiDrilldownPanel — the in-page detail disclosure behind a KPI tile.
 *
 * A NON-MODAL, docked `<section>` that opens BELOW the landing strip when an operator
 * activates a tile. It is deliberately not a Dialog and not a Sheet: both wrap
 * `@radix-ui/react-dialog`, which traps focus and marks the rest of the page `inert`,
 * so the operator could no longer read the tile the panel explains, compare it with its
 * four neighbours, or tab on into the instrument band. This panel is read ALONGSIDE the
 * strip, so it uses the plain WAI disclosure contract instead:
 *
 *   trigger  — the tile `<button>`, carrying `aria-expanded` + `aria-controls`
 *              (both OPTIONAL on `KpiTile`, so no other consumer is affected).
 *   panel    — `<section aria-labelledby>` with NO `role="dialog"` and NO `aria-modal`.
 *   focus    — moves to the panel's `<h2 tabIndex={-1}>`, never to a filter control:
 *              a screen-reader user must hear WHAT opened before they hear how to
 *              narrow it.
 *   escape   — closes and returns focus to the trigger (the parent owns the return,
 *              since only it holds the tile refs).
 *   tab      — leaves freely and NEVER auto-closes. A docked panel that vanished when
 *              focus moved on would be unusable with a keyboard.
 *
 * Honesty. The panel fetches its OWN case page against its OWN time range rather than
 * reusing the dashboard's, because two of the strip's populations are not on the
 * dashboard's horizon at all (the open-case stock is window-EXEMPT). It never claims to
 * equal the tile's numeral: the footer states how many rows it read, whether the store
 * proved that page complete (`window_total_exact`, read as the THREE-valued flag it is
 * — see `proven` below), and offers the full list. A number
 * on the tile comes from a server-side rollup over the whole window; a list here is a
 * bounded page — saying so is the difference between a drill-down and a lie.
 *
 * Vendor-agnostic (§4): every facet comes from the product's own vocabulary — severity
 * from `SEVERITY_BAND_ORDER` (badges.tsx, the ONE band authority) and status from the
 * values the fetched cases actually carry. No literal status list, no rule title, no
 * vendor field name appears here.
 *
 * Security (#9): every rendered value is a formatted number, a humanized enum, or
 * backend text rendered as a PLAIN text node. Nothing is injected as markup.
 *
 * Advisory (#3): read-only. Nothing here can reach `decide()`.
 */
import * as React from 'react';
import { Search, X } from 'lucide-react';

import type { Case, CasesResponse } from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { LoadingState } from '@/design-system';
import { SEVERITY_BAND_ORDER, SeverityBadge, StatusBadge, severityBand } from './badges';
import { EmptyState } from './EmptyState';
import { LoadError } from './LoadError';
import { MetricTrendBody, type MetricTrendSeries } from './MetricHoverTrend';

/** How many rows one panel page reads. Mirrors the dashboard's own case-sample bound. */
export const DRILLDOWN_PAGE_LIMIT = 200;

/** Sentinel for "no facet applied" (Radix Select forbids an empty string value). */
const ANY = '__any__';

/**
 * The panel's own horizon. `window` means "the range the dashboard is showing"; `all`
 * drops the bound entirely, which is the only honest default for a window-EXEMPT stock
 * such as the open-case queue.
 */
export type DrilldownRange = 'window' | '1h' | '24h' | '7d' | '30d' | 'all';

const RANGE_HOURS: Record<Exclude<DrilldownRange, 'window' | 'all'>, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
};

const RANGE_LABEL: Record<Exclude<DrilldownRange, 'window'>, string> = {
  '1h': 'Last 1 hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

/** Sort orders over fields every case carries — never a vendor-specific column. */
export type DrilldownSort = 'recent' | 'oldest' | 'risk_desc' | 'risk_asc';

const SORT_LABEL: Record<DrilldownSort, string> = {
  recent: 'Most recent',
  oldest: 'Oldest first',
  risk_desc: 'Highest risk',
  risk_asc: 'Lowest risk',
};

/** Where the "see them all" affordance goes, when a full list can honestly show it. */
export interface DrilldownTarget {
  label: string;
  onSelect: () => void;
}

/** Everything a tile has to say about the population behind its numeral. */
export interface KpiDrilldownSpec {
  /** Stable key — the tile's `testId`. Changing it re-runs the open/focus effect. */
  key: string;
  /** Panel heading. The tile's own label, verbatim. */
  title: string;
  /** ONE plain-text sentence naming the population this panel lists. */
  population: string;
  /** Selects the tile's population out of a fetched page. */
  match: (c: Case) => boolean;
  /** The horizon this population naturally lives on. */
  defaultRange: DrilldownRange;
  /** The dashboard's own window, for the `window` option's label. */
  windowHours: number;
  /** The tile's honest server trend, restated here so touch/keyboard can reach it. */
  trend?: MetricTrendSeries;
  /** The full-list drill-through, when one exists for this population. */
  target?: DrilldownTarget;
  /**
   * Open one listed case. Omitted when the page has no navigator, and the rows then
   * render as plain, non-interactive text rather than dead buttons.
   */
  onOpenCase?: (caseId: string) => void;
}

export interface KpiDrilldownPanelProps {
  spec: KpiDrilldownSpec;
  /** `aria-controls` target on the trigger. */
  panelId: string;
  /** `aria-labelledby` target — the panel's own heading. */
  headingId: string;
  /** Close the panel. The PARENT restores focus to the trigger tile. */
  onClose: () => void;
  className?: string;
}

/** The one place a case's display id is resolved (number first, then id). */
/**
 * First NON-BLANK candidate, trimmed. Trimming after a `||` chain is the wrong order:
 * a whitespace-only earlier field is truthy, so it wins the chain and then trims away to
 * nothing, discarding a perfectly good later candidate.
 */
export function firstNonBlank(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const trimmed = (candidate || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function displayId(c: Case): string {
  return firstNonBlank(c.case_number, c.case_id) || DASH;
}

/** The one place a case's display title is resolved. Falls back, never blanks. */
function displayTitle(c: Case): string {
  return firstNonBlank(c.title, c.cluster_signature, c.rule_ids?.[0]) || 'Untitled case';
}

/** Sort key: the most recent activity instant, or 0 when nothing is parseable. */
function activityMs(c: Case): number {
  return Date.parse(c.updated_at || c.created_at || '') || 0;
}

function riskOf(c: Case): number {
  return typeof c.risk_score === 'number' && Number.isFinite(c.risk_score) ? c.risk_score : 0;
}

/** Free-text haystack — the same fields the Cases list searches. */
function haystack(c: Case): string {
  return [
    c.title,
    c.case_id,
    c.case_number,
    c.summary,
    c.entity?.value,
    c.entity?.type,
    c.assignee,
    c.source_name,
    c.cluster_signature,
    ...(Array.isArray(c.rule_ids) ? c.rule_ids : []),
    ...(Array.isArray(c.tags) ? c.tags : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Band a case exactly the way the Cases list and every badge do: the advisory
 * `severity_band` when the source asserted one, else the deterministic `risk_score` on
 * the ONE ladder. Returns null when neither exists — such a case is simply not in any
 * band facet, never silently filed under the lowest one.
 */
function bandOf(c: Case): string | null {
  const explicit = severityBand(c.severity_band);
  if (explicit) return explicit;
  return severityBand(typeof c.risk_score === 'number' ? c.risk_score : null);
}

export function KpiDrilldownPanel({
  spec,
  panelId,
  headingId,
  onClose,
  className,
}: KpiDrilldownPanelProps) {
  const { onOpenCase } = spec;
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const sectionRef = React.useRef<HTMLElement>(null);

  const [range, setRange] = React.useState<DrilldownRange>(spec.defaultRange);
  const [sort, setSort] = React.useState<DrilldownSort>('recent');
  const [search, setSearch] = React.useState('');
  const [band, setBand] = React.useState<string>(ANY);
  const [status, setStatus] = React.useState<string>(ANY);

  const [rows, setRows] = React.useState<Case[] | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  /**
   * Did the store PROVE `total` for the question this page actually asked?
   *
   * `window_total_exact` is three-valued on the wire and each value means something
   * different (`routes.py`: "`null` when NO window was requested … so a client can
   * distinguish 'not applicable' from 'not proven'"). Collapsing it to a boolean
   * labelled every all-time page — the DEFAULT state of a window-exempt stock such as
   * the open-case queue — a lower bound, even when the store returned its real total
   * and every row of it was read. So the answer is resolved at fetch time, where the
   * panel still knows whether it sent a bound, and stored as one already-decided flag.
   */
  const [proven, setProven] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // A tile swap re-seeds the panel: a new population must never inherit the previous
  // one's horizon or facets (the open-case stock is all-time, the cohorts are not).
  React.useEffect(() => {
    setRange(spec.defaultRange);
    setSort('recent');
    setSearch('');
    setBand(ANY);
    setStatus(ANY);
  }, [spec.key, spec.defaultRange]);

  /**
   * Move focus to the panel HEADING on open — not to the first filter, which would
   * announce "search" to a screen-reader user who has no idea what just opened. Runs
   * on a tile SWAP too, so activating a second tile re-announces the new panel.
   */
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [spec.key]);

  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const hours =
        range === 'all'
          ? null
          : range === 'window'
            ? spec.windowHours
            : RANGE_HOURS[range];
      const windowed = hours != null && hours > 0;
      const query: Record<string, unknown> = { limit: DRILLDOWN_PAGE_LIMIT };
      if (windowed) query.from = `now-${hours}h`;
      const res = (await api.listCases(query)) as CasesResponse;
      if (seq !== loadSeq.current) return;
      setRows(res.cases ?? []);
      setTotal(typeof res.total === 'number' ? res.total : null);
      // `true`  → the store proved the windowed total exactly.
      // absent  → "not applicable" when NO window was sent (the store counted the whole
      //           population, which is exactly the question asked) but "not proven" when
      //           one WAS sent and this backend predates the flag. The request shape is
      //           the only thing that separates them, and only this scope knows it.
      // `false` → the store said it could not prove the total. Never proof.
      setProven(res.window_total_exact === true || (!windowed && res.window_total_exact == null));
    } catch (e) {
      if (seq === loadSeq.current) setError(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [range, spec.windowHours]);

  React.useEffect(() => {
    void load();
  }, [load]);
  // A superseded batch is already discarded by the sequence guard; this stops a late
  // one from calling setState after the panel closes.
  React.useEffect(() => () => void ++loadSeq.current, []);

  /** The tile's population out of the fetched page — before the operator's facets. */
  const population = React.useMemo(
    () => (rows ?? []).filter(spec.match),
    [rows, spec],
  );

  /** Status facet options, derived from the population itself (never a literal list). */
  const statusFacets = React.useMemo(() => {
    const seen = new Set<string>();
    for (const c of population) {
      const s = (c.status || '').trim();
      if (s) seen.add(s);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [population]);

  /** Band facet options: the product ladder, most severe first, present rows only. */
  const bandFacets = React.useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const c of population) {
      const b = bandOf(c);
      if (b) seen.add(b);
    }
    // SEVERITY_BAND_ORDER is the product's ONE ladder and is ASCENDING, so reversing it
    // puts the most severe band first without ever restating the band names here.
    return [...SEVERITY_BAND_ORDER].reverse().filter((b) => seen.has(b));
  }, [population]);

  // A facet the refreshed population can no longer satisfy is dropped rather than
  // left selected over an empty list (the Cases list's self-healing rule).
  React.useEffect(() => {
    if (status !== ANY && !statusFacets.includes(status)) setStatus(ANY);
  }, [status, statusFacets]);
  React.useEffect(() => {
    if (band !== ANY && !bandFacets.includes(band)) setBand(ANY);
  }, [band, bandFacets]);

  const visible = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = population.filter((c) => {
      if (status !== ANY && (c.status || '') !== status) return false;
      if (band !== ANY && bandOf(c) !== band) return false;
      if (q && !haystack(c).includes(q)) return false;
      return true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return activityMs(a) - activityMs(b);
        case 'risk_desc':
          return riskOf(b) - riskOf(a) || activityMs(b) - activityMs(a);
        case 'risk_asc':
          return riskOf(a) - riskOf(b) || activityMs(b) - activityMs(a);
        default:
          return activityMs(b) - activityMs(a);
      }
    });
    return sorted;
  }, [population, search, status, band, sort]);

  const facetsApplied = search.trim() !== '' || status !== ANY || band !== ANY;

  /**
   * ESCAPE closes — but only its OWN Escape.
   *
   * A Radix Select inside this panel portals its content out to `document.body` while
   * keeping it in the panel's REACT tree, so its Escape dismissal still bubbles to this
   * handler; without a guard, closing a dropdown would tear the whole panel down with
   * it. `defaultPrevented` alone is the WRONG guard for that, because every Radix
   * dismissable layer marks Escape prevented from a DOCUMENT-level capture listener —
   * including a neighbouring tile's hover card, which is not ours and which the operator
   * never asked to be a modal barrier. Trusting that flag globally left the panel
   * un-closable after an ordinary click-A-then-click-B, or after the pointer merely
   * drifted onto another tile.
   *
   * The discriminator is CONTAINMENT, not the flag: when one of our own Selects consumes
   * the key, Radix has moved focus into its portalled listbox, so `e.target` is outside
   * this section's DOM subtree (while still inside its React tree — which is why the
   * event reaches us at all). An Escape whose target is inside the panel was never
   * consumed by a layer of ours, whoever else may have marked it prevented.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    const target = e.target instanceof Node ? e.target : null;
    const fromInsidePanel = target != null && sectionRef.current?.contains(target) === true;
    if (!fromInsidePanel && e.defaultPrevented) return;
    e.stopPropagation();
    onClose();
  };

  const rangeOptions: DrilldownRange[] = ['window', '1h', '24h', '7d', '30d', 'all'];
  const windowOptionLabel = `Dashboard window (${spec.windowHours}h)`;

  return (
    /* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- Escape-to-close
       is the WAI disclosure contract, and the handler has to sit on the SUBTREE ROOT:
       focus is moved into this section on open (the heading is programmatically
       focusable) and then moves freely across its search box, four Selects and the
       drill-through, so any narrower target would leave Escape dead from most of the
       panel. A document-level listener would be worse, not better — it would close a
       NON-MODAL panel from Escape presses that belong to the rest of the page. The
       section deliberately carries no role: it is not a dialog and must not claim to
       be one. */
    <section
      ref={sectionRef}
      id={panelId}
      aria-labelledby={headingId}
      data-testid="kpi-drilldown"
      data-kpi={spec.key}
      onKeyDown={onKeyDown}
      className={cn(
        'min-w-0 rounded-md border border-border bg-card/40 p-3 sm:p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* tabIndex -1 so open() can move focus here. The heading is OUTSIDE the
              trigger button by design: a heading swallowed by a button's
              name-from-contents breaks heading-jump navigation. */}
          <h2
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            data-testid="kpi-drilldown-heading"
            className="text-xs font-semibold uppercase tracking-widest text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {spec.title} · details
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">{spec.population}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="kpi-drilldown-close"
          className="h-7 shrink-0 px-2 text-2xs"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Close
        </Button>
      </div>

      {spec.trend ? (
        <div
          data-testid="kpi-drilldown-trend"
          className="mt-3 rounded-md border border-border/70 bg-background/40 p-3"
        >
          <MetricTrendBody {...spec.trend} />
        </div>
      ) : null}

      <div
        role="group"
        aria-label={`${spec.title} detail filters`}
        data-testid="kpi-drilldown-controls"
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
      >
        <div className="relative min-w-0 sm:col-span-2 xl:col-span-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter these cases…"
            aria-label={`Filter ${spec.title} cases`}
            data-testid="kpi-drilldown-search"
            className="h-8 rounded-[4px] pl-8 text-xs"
          />
        </div>

        <Select value={band} onValueChange={setBand}>
          <SelectTrigger
            className="h-8 rounded-[4px] text-xs"
            aria-label={`Filter ${spec.title} cases by severity`}
            data-testid="kpi-drilldown-severity"
          >
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All severities</SelectItem>
            {bandFacets.map((b) => (
              <SelectItem key={b} value={b}>
                {humanizeToken(b)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger
            className="h-8 rounded-[4px] text-xs"
            aria-label={`Filter ${spec.title} cases by status`}
            data-testid="kpi-drilldown-status"
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All statuses</SelectItem>
            {statusFacets.map((s) => (
              <SelectItem key={s} value={s}>
                {humanizeToken(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="grid min-w-0 grid-cols-2 gap-2">
          <Select value={sort} onValueChange={(v) => setSort(v as DrilldownSort)}>
            <SelectTrigger
              className="h-8 rounded-[4px] text-xs"
              aria-label={`Sort ${spec.title} cases`}
              data-testid="kpi-drilldown-sort"
            >
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABEL) as DrilldownSort[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={range} onValueChange={(v) => setRange(v as DrilldownRange)}>
            <SelectTrigger
              className="h-8 rounded-[4px] text-xs"
              aria-label={`Time range for ${spec.title} cases`}
              data-testid="kpi-drilldown-range"
            >
              <SelectValue placeholder="Time range" />
            </SelectTrigger>
            <SelectContent>
              {rangeOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r === 'window' ? windowOptionLabel : RANGE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-3 min-w-0">
        {error ? (
          <LoadError
            error={error}
            title="Could not load these cases"
            onRetry={() => void load()}
          />
        ) : loading && rows === null ? (
          <LoadingState label={`Loading ${spec.title} cases`} layout="inline" />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={Search}
            title={facetsApplied ? 'No cases match these filters' : 'No cases in this range'}
            description={
              facetsApplied
                ? 'Clear a filter, or widen the time range.'
                : 'Widen the time range to look further back.'
            }
          />
        ) : (
          <ul
            data-testid="kpi-drilldown-rows"
            className="max-h-80 min-w-0 space-y-1 overflow-y-auto pr-1"
          >
            {visible.map((c) => {
              const id = displayId(c);
              const title = displayTitle(c);
              const body = (
                <>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
                      <span className="max-w-28 shrink-0 truncate text-primary" title={id}>
                        {id}
                      </span>
                      <span className="truncate text-foreground" title={title}>
                        {title}
                      </span>
                    </span>
                    <span className="block font-mono text-2xs text-muted-foreground">
                      {humanizeAge(c.updated_at || c.created_at) || 'Just now'}
                    </span>
                  </span>
                  <SeverityBadge
                    severity={c.severity_band ?? c.risk_score ?? null}
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs"
                  />
                  <StatusBadge
                    status={c.status}
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs"
                  />
                </>
              );
              const rowClass =
                'flex w-full min-w-0 items-center gap-2 rounded-sm border border-border/70 bg-background/40 px-2 py-1.5 text-left';
              return (
                <li key={c.case_id} data-testid="kpi-drilldown-row" className="min-w-0">
                  {onOpenCase ? (
                    <button
                      type="button"
                      onClick={() => onOpenCase(c.case_id)}
                      aria-label={`Open case ${title}`}
                      className={cn(
                        rowClass,
                        'transition-colors hover:border-border hover:bg-muted/40',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <span className={rowClass}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2">
        <p data-testid="kpi-drilldown-scope" className="min-w-0 text-2xs text-muted-foreground">
          {error ? (
            'This page could not be read.'
          ) : loading ? (
            // A range change keeps the previous rows mounted rather than blanking the
            // panel, so the footer must NOT keep describing them as this range's
            // answer while the new one is still in flight.
            'Re-reading this range\u2026'
          ) : (
            <>
              {`Showing ${fmtNumber(visible.length)} of ${fmtNumber(population.length)} in this page`}
              {/* The tile's numeral is a server rollup over the whole window; this list
                  is one page. Never imply they are the same measurement. */}
              {total != null && rows != null
                ? proven && total <= rows.length
                  ? ` · complete page of ${fmtNumber(total)} case${total === 1 ? '' : 's'}`
                  : ` · newest ${fmtNumber(rows.length)} of ${fmtNumber(total)} read · lower bound`
                : ' · bounded page'}
            </>
          )}
        </p>
        {spec.target ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={spec.target.onSelect}
            data-testid="kpi-drilldown-drillthrough"
            className="h-7 shrink-0 px-2 text-2xs"
          >
            {spec.target.label}
          </Button>
        ) : null}
      </div>
    </section>
    /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
  );
}

export default KpiDrilldownPanel;
