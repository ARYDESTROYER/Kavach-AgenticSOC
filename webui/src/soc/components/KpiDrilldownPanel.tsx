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
 * Depth. The panel asks the STORE the question, rather than asking for the newest page
 * and answering whole-population questions over it in the browser:
 *
 *   sort    — a real server sort, chosen from the allow-list the response ECHOES, so a
 *             deployment with a different sortable set gets the right menu unchanged.
 *   paging  — `offset` paging under a PINNED HEAD: every page of one range carries the
 *             same head instant, because rows arriving mid-session are exactly what
 *             makes offset paging repeat some rows and skip others.
 *   facets  — the two multi-status populations are pushed down as a scalar
 *             `status_group` the server resolves from its own status constants, the
 *             status menu is the union of every page read here, and the severity menu
 *             is seeded from the server's whole-window band tally when the panel is on
 *             the dashboard's own window.
 *
 * Honesty. The panel fetches its OWN case page against its OWN time range rather than
 * reusing the dashboard's, because two of the strip's populations are not on the
 * dashboard's horizon at all (the open-case stock is window-EXEMPT). It never claims to
 * equal the tile's numeral: the footer states how many rows it read, whether the store
 * proved that page complete (`window_total_exact`, read as the THREE-valued flag it is
 * — see `proven` below), WHICH narrowings were applied to the rows read rather than to
 * the population, and offers the full list. A number
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
import { ChevronDown, Search, X } from 'lucide-react';

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

/**
 * How many rows one panel page reads. Mirrors the dashboard's own case-sample bound AND
 * the server's own clamp on this endpoint. It is deliberately NOT raised to cover more
 * of a population: reading further is what `offset` is for, and a client constant that
 * drifted above the server clamp would be silently truncated with no signal (the clamp
 * emits no error and no header — only the response's echoed `limit_applied`).
 */
export const DRILLDOWN_PAGE_LIMIT = 200;

/** Sentinel for "no facet applied" (Radix Select forbids an empty string value). */
const ANY = '__any__';

/** A stable empty list, so a reset cannot hand a memo a fresh identity for nothing. */
const NO_TOKENS: string[] = [];

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

/** One sort choice: the operator's label plus the SERVER field/direction it asks for. */
export interface DrilldownSortOption {
  key: DrilldownSort;
  label: string;
  field: string;
  order: 'asc' | 'desc';
}

/**
 * The four sorts, each expressed as the server sort it now really is.
 *
 * The two recency sorts map to the CREATION timestamp, not the update timestamp, and
 * that is a deliberate change of axis. `created_at` is IMMUTABLE and is the same axis as
 * both the range bound the panel sends and the pinned head it pages under, whereas the
 * comparator this replaces preferred `updated_at` — a MUTABLE key. A sort key that moves
 * while the operator is reading is exactly what makes offset paging repeat some rows on
 * the next page and skip others, because a row touched between two page reads changes
 * its own position in the order the offsets are counted against. Ordering by the
 * creation instant means the panel's order, its window and its head pin all count the
 * same axis, so page N+1 continues page N.
 */
export const DRILLDOWN_SORTS: readonly DrilldownSortOption[] = [
  { key: 'recent', label: 'Most recent', field: 'created_at', order: 'desc' },
  { key: 'oldest', label: 'Oldest first', field: 'created_at', order: 'asc' },
  { key: 'risk_desc', label: 'Highest risk', field: 'risk_score', order: 'desc' },
  { key: 'risk_asc', label: 'Lowest risk', field: 'risk_score', order: 'asc' },
];

/**
 * What the operator had narrowed to when they asked for the full list. The drill-through
 * receives this so their work travels with them; the destination declares which of it it
 * can honour (`DrilldownTarget.honours`) and the panel DISCLOSES the rest rather than
 * dropping it silently.
 */
export interface DrilldownTargetContext {
  /** The severity band selected, or null for "all severities". */
  band: string | null;
  /** The single status selected, or null for "all statuses". */
  status: string | null;
  /** The panel's current horizon in hours, or null when it is all-time. */
  windowHours: number | null;
  /** Free text the operator typed. Empty when they typed none. */
  search: string;
  /** The sort the operator chose. */
  sort: DrilldownSort;
}

/** Human names for the context keys, for the "not carried" disclosure. */
const CONTEXT_LABEL: Record<keyof DrilldownTargetContext, string> = {
  band: 'severity',
  status: 'status',
  windowHours: 'time range',
  search: 'search text',
  sort: 'ordering',
};

/** Where the "see them all" affordance goes, when a full list can honestly show it. */
export interface DrilldownTarget {
  label: string;
  onSelect: (context: DrilldownTargetContext) => void;
  /**
   * Which parts of the operator's context the destination can apply. Anything the
   * operator actually set that is NOT listed here is named on the button as dropped —
   * a filter that silently disappears on a hand-off is worse than one that never
   * travelled, because the list looks authoritative and is wider than it claims.
   */
  honours?: readonly (keyof DrilldownTargetContext)[];
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
  /**
   * The scalar multi-status lifecycle group the STORE can resolve for this population,
   * when one exists. Sending it makes the fetched page the tile's population instead of
   * an undifferentiated page the browser then carves up, which is what lets the facet
   * menus and the paging describe the population rather than the page.
   */
  statusGroup?: string;
  /**
   * Where the tile's population predicate is really resolved. `'store'` when the
   * request itself selects it (a `statusGroup`, or a tile with no predicate at all);
   * `'rows-read'` when `match` runs in the browser over the rows that were read. The
   * default is the CONSERVATIVE answer, so a tile that forgets to declare it
   * over-discloses instead of over-claiming.
   */
  populationResolvedBy?: 'store' | 'rows-read';
  /**
   * A server-computed, whole-window band tally for the dashboard's own window, keyed by
   * band name. Used to seed the severity menu with bands the WINDOW contains rather than
   * the bands that happen to be on the rows read — and only while the panel is actually
   * on that window, because outside it the tally answers a different question.
   */
  severityHistogram?: Record<string, number> | null;
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

/**
 * Append `incoming` to `previous`, dropping any case already held.
 *
 * Paging accumulates, and an accumulation cannot assume the pages are disjoint: the head
 * pin narrows the race but cannot close it (a row can still be written between the pin
 * being taken and the store reading it), a tie on the sort key is resolved by the store's
 * own tiebreaker rather than by anything this client can see, and a store that reports a
 * lower bound may simply hand back overlapping pages. A duplicated row would render
 * twice AND double-count in every footer number, so identity is enforced here rather
 * than hoped for.
 */
export function dedupeById(previous: readonly Case[], incoming: readonly Case[]): Case[] {
  const seen = new Set(previous.map((c) => c.case_id));
  const merged = [...previous];
  for (const c of incoming) {
    if (seen.has(c.case_id)) continue;
    seen.add(c.case_id);
    merged.push(c);
  }
  return merged;
}

/**
 * Union of `previous` with the non-blank members of `incoming`, KEEPING the previous
 * array's identity when nothing new arrived.
 *
 * The identity contract is the point, not an optimisation: the facet menus are derived
 * from these unions, and the self-healing effects that drop an unsatisfiable facet are
 * keyed on the menus. A union that returned a fresh array on every page would re-run
 * those effects on every page arrival, which is precisely the behaviour that must not
 * happen (see the effects below).
 */
export function mergeTokens(
  previous: string[],
  incoming: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set(previous);
  let added = false;
  for (const token of incoming) {
    const value = (token || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    added = true;
  }
  return added ? Array.from(seen) : previous;
}

function displayId(c: Case): string {
  return firstNonBlank(c.case_number, c.case_id) || DASH;
}

/** The one place a case's display title is resolved. Falls back, never blanks. */
function displayTitle(c: Case): string {
  return firstNonBlank(c.title, c.cluster_signature, c.rule_ids?.[0]) || 'Untitled case';
}

/**
 * Sort key: the case's CREATION instant, or 0 when nothing is parseable.
 *
 * The same immutable axis the server is asked to sort on, so the client's re-sort of the
 * accumulated rows agrees with the order the pages were drawn in instead of quietly
 * reshuffling them against a mutable key.
 */
function createdMs(c: Case): number {
  return Date.parse(c.created_at || '') || 0;
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

/** What the last completed read consumed, so the footer can be page-aware. */
interface ReadProgress {
  /** Rows of the ordered population consumed so far (offset + that page's length). */
  through: number;
  /** How many pages have been read for the current question. */
  pages: number;
  /** Rows the last page returned — a short page means the store is exhausted. */
  lastPage: number;
  /**
   * The page size that read was actually served at. Compared against `lastPage` to tell
   * "the store has no more rows" from "the server clamped this page", which are the same
   * observation until the clamp is known.
   */
  size: number;
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
  const [page, setPage] = React.useState(0);

  const [rows, setRows] = React.useState<Case[] | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [read, setRead] = React.useState<ReadProgress | null>(null);
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

  /** The sortable set THIS deployment reported, or null before the first response. */
  const [sortableFields, setSortableFields] = React.useState<string[] | null>(null);
  /** The sort the server said it applied, so an ignored sort can be disclosed. */
  const [appliedSort, setAppliedSort] = React.useState<{ field: string; order: string } | null>(
    null,
  );
  /** The deepest offset this endpoint serves, echoed by the server. */
  const [maxOffset, setMaxOffset] = React.useState<number | null>(null);
  /** Every status / band seen across every page read for the CURRENT question. */
  const [statusUniverse, setStatusUniverse] = React.useState<string[]>(NO_TOKENS);
  const [bandUniverse, setBandUniverse] = React.useState<string[]>(NO_TOKENS);

  /**
   * A tile swap re-seeds the panel: a new population must never inherit the previous
   * one's horizon or facets (the open-case stock is all-time, the cohorts are not).
   *
   * This is a RENDER-phase adjustment rather than an effect on purpose. As an effect it
   * ran AFTER the fetch effect had already seen the new spec against the old range, so
   * every tile swap that changed the default range issued two requests — the second
   * superseding the first, which the sequence guard discards but which the network and
   * the store still paid for. Adjusting during render means the fetch effect only ever
   * observes the settled state.
   */
  const seedKey = `${spec.key}\u0000${spec.defaultRange}`;
  const [seededFor, setSeededFor] = React.useState(seedKey);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    setRange(spec.defaultRange);
    setSort('recent');
    setSearch('');
    setBand(ANY);
    setStatus(ANY);
  }

  /**
   * The head pin and the facet universes are scoped to ONE tile on ONE range: both
   * describe a population, and a range change asks about a different one.
   */
  const questionKey = `${seedKey}\u0000${range}`;
  const [questionFor, setQuestionFor] = React.useState(questionKey);
  const pinRef = React.useRef<{ key: string; at: string } | null>(null);
  if (questionFor !== questionKey) {
    setQuestionFor(questionKey);
    setStatusUniverse(NO_TOKENS);
    setBandUniverse(NO_TOKENS);
  }

  /**
   * Paging returns to the first page whenever the question changes — the tile, the
   * range, the sort, the free text, or either facet. Anything else would leave the
   * reader deep inside an ordering or a narrowing they have just replaced, reading
   * page four of a list whose page one they have never seen.
   */
  // NUL joins the parts because one of them is ARBITRARY operator text: any printable
  // separator could be typed into the search box and collide two different questions
  // into one key, which would silently skip a paging reset.
  const pagingKey = [questionKey, sort, search, band, status].join('\u0000');
  const [pagedFor, setPagedFor] = React.useState(pagingKey);
  if (pagedFor !== pagingKey) {
    setPagedFor(pagingKey);
    setPage(0);
  }

  /**
   * Move focus to the panel HEADING on open — not to the first filter, which would
   * announce "search" to a screen-reader user who has no idea what just opened. Runs
   * on a tile SWAP too, so activating a second tile re-announces the new panel.
   */
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [spec.key]);

  const sortOption = React.useMemo(
    () => DRILLDOWN_SORTS.find((o) => o.key === sort) ?? DRILLDOWN_SORTS[0],
    [sort],
  );
  /**
   * The page size to step `offset` by — the server's ECHOED effective limit once one has
   * been seen, and the client constant before that.
   *
   * A ref rather than state, deliberately. The step has to be the size the server really
   * served: a deployment that clamps below what this panel asks for would otherwise leave
   * a gap between page N's last row and page N+1's first, and a short page would read as
   * "the store is exhausted" when it was only clamped. But it must not be a fetch input
   * either — `page` is 0 when the first response arrives, and `0 * anything` is 0, so
   * making it reactive would only ever re-arm a request that could not change.
   */
  const pageSizeRef = React.useRef(DRILLDOWN_PAGE_LIMIT);
  const [pageSize, setPageSize] = React.useState(DRILLDOWN_PAGE_LIMIT);
  const offset = page * pageSizeRef.current;
  const { statusGroup } = spec;

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
      /**
       * The PINNED HEAD. Captured on the first read of a question and reused for every
       * later page of it, because `offset` counts from the newest row and a case created
       * while the operator reads shifts every subsequent offset by one — page two then
       * repeats a row page one already showed and skips one it never will. A ref, not
       * state: it is an input to the request, so making it reactive would re-arm the very
       * fetch that sets it.
       *
       * It is a HEAD bound only. The `from` bound stays relative, so the tail of a
       * bounded range still drifts by however long the reading session lasts — a real,
       * bounded residual, and the smaller half: rows leaving at the tail cannot move the
       * offsets of newer rows under the default newest-first order.
       *
       * The second residual, named rather than glossed: the instant comes from the
       * BROWSER's clock, so a host whose clock runs behind the server's hides cases
       * created inside that skew from every page. It is bounded by the skew and is the
       * price of a head bound the client can hold stable across pages — the alternative,
       * pinning only from page two, trades it for pages that skip rows outright, which is
       * the defect the pin exists to prevent.
       */
      if (!pinRef.current || pinRef.current.key !== questionKey) {
        pinRef.current = { key: questionKey, at: new Date().toISOString() };
      }
      const query: Record<string, unknown> = {
        limit: DRILLDOWN_PAGE_LIMIT,
        offset,
        sort_field: sortOption.field,
        sort_order: sortOption.order,
        to: pinRef.current.at,
      };
      if (windowed) query.from = `now-${hours}h`;
      // A scalar the SERVER resolves. A status LIST cannot be sent: the query helper
      // stringifies an array into one comma-joined term, which the store applies as a
      // single exact match and which therefore matches nothing, with no error anywhere.
      if (statusGroup) query.status_group = statusGroup;
      const res = (await api.listCases(query)) as CasesResponse;
      if (seq !== loadSeq.current) return;
      const fresh = res.cases ?? [];
      setRows((prev) => (offset === 0 || prev == null ? fresh : dedupeById(prev, fresh)));
      const served =
        typeof res.limit_applied === 'number' && res.limit_applied > 0
          ? res.limit_applied
          : DRILLDOWN_PAGE_LIMIT;
      pageSizeRef.current = served;
      setPageSize(served);
      setRead({
        through: offset + fresh.length,
        pages: page + 1,
        lastPage: fresh.length,
        size: served,
      });
      setStatusUniverse((prev) => mergeTokens(prev, fresh.map((c) => c.status)));
      setBandUniverse((prev) => mergeTokens(prev, fresh.map(bandOf)));
      setTotal(typeof res.total === 'number' ? res.total : null);
      setSortableFields(Array.isArray(res.sortable_fields) ? res.sortable_fields : null);
      setAppliedSort(
        typeof res.sort_field === 'string' && typeof res.sort_order === 'string'
          ? { field: res.sort_field, order: res.sort_order }
          : null,
      );
      setMaxOffset(typeof res.max_offset === 'number' ? res.max_offset : null);
      // `true`  → the store proved the total for the narrowing that was asked for.
      // absent  → "not applicable" when the request NARROWED nothing (the store counted
      //           the whole population, which is exactly the question asked) but "not
      //           proven" when it did and this backend predates the flag. The request
      //           shape is the only thing that separates them, and only this scope
      //           knows it.
      // `false` → the store said it could not prove the total. Never proof, under any
      //           branch. A repository that resolves a lifecycle group in Python reports
      //           exactly that for a group request carrying no time window at all, and
      //           that windowless-but-not-exact answer must never read as a complete
      //           page — which is precisely why the `false` case is tested first and
      //           unconditionally.
      //
      // "Narrowed" is what the server SAYS it applied, not what was asked for. The head
      // pin does not count: it is this panel's own paging device, not a question the
      // operator posed. A lifecycle group counts only when the response echoes it back,
      // because a deployment that does not implement the parameter narrowed nothing —
      // its total then really is the unnarrowed one, and the three-valued read is the
      // windowless one.
      const groupApplied = Boolean(statusGroup) && res.status_group_applied === statusGroup;
      const narrowed = windowed || groupApplied;
      setProven(res.window_total_exact === true || (!narrowed && res.window_total_exact == null));
    } catch (e) {
      if (seq === loadSeq.current) setError(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // Every request input is listed, so no stale closure can re-send a superseded value.
  }, [range, spec.windowHours, statusGroup, questionKey, sortOption, offset, page]);

  React.useEffect(() => {
    void load();
  }, [load]);
  // A superseded batch is already discarded by the sequence guard; this stops a late
  // one from calling setState after the panel closes.
  React.useEffect(() => () => void ++loadSeq.current, []);

  /** The tile's population out of the rows read — before the operator's facets. */
  const population = React.useMemo(
    () => (rows ?? []).filter(spec.match),
    [rows, spec],
  );

  /**
   * Status facet options: the UNION of statuses seen across every page read for this
   * question, never just the current page. A status that first appears on page two used
   * to be missing from the menu until the operator happened to be looking at page two,
   * which made the menu a description of the page rather than of the population.
   */
  const statusFacets = React.useMemo(
    () => [...statusUniverse].sort((a, b) => a.localeCompare(b)),
    [statusUniverse],
  );

  /**
   * Band facet options, most severe first.
   *
   * Seeded from the server's whole-window band tally when the panel is on the dashboard
   * window, because that tally covers the WINDOW rather than the rows read; a band the
   * window contains is then offered even if no row of page one carries it. `severity_band`
   * is derived at read time after paging and is stored nowhere, so it can never be a
   * server-side filter or sort — the tally is the only whole-population view of it there
   * is, and outside that one range it answers a different question, so the menu falls
   * back to the rows read and the footer says so.
   *
   * Ordering iterates OUR ladder and keeps the names that are present. The two ladders in
   * this product are the same names in OPPOSITE order (the client's ascends, the server's
   * descends), so pairing a server-supplied key list against a client index by position
   * would invert severity silently. Membership, never position.
   */
  const bandMenuFromWindow = range === 'window' && spec.severityHistogram != null;
  const bandFacets = React.useMemo<string[]>(() => {
    const present = new Set<string>();
    if (bandMenuFromWindow && spec.severityHistogram) {
      for (const [name, count] of Object.entries(spec.severityHistogram)) {
        // The tally is zero-filled across the whole vocabulary, and a band with no case
        // in the window is not an option — offering it would promise rows that the
        // server has already said do not exist.
        if (typeof count === 'number' && count > 0) present.add(name);
      }
    } else {
      for (const b of bandUniverse) present.add(b);
    }
    // SEVERITY_BAND_ORDER is the product's ONE ladder and is ASCENDING, so reversing it
    // puts the most severe band first without ever restating the band names here.
    return [...SEVERITY_BAND_ORDER].reverse().filter((b) => present.has(b));
  }, [bandMenuFromWindow, spec.severityHistogram, bandUniverse]);

  // A facet the population can no longer satisfy is dropped rather than left selected
  // over an empty list (the Cases list's self-healing rule).
  //
  // These deliberately watch the SESSION-scoped menus, which is what makes them safe to
  // page against. Reading another page can only ADD to a union, so the menus keep the
  // identity they had, the effects do not re-run, and a selected facet survives a page
  // whose rows happen to contain none of it. Watching a PAGE-scoped menu instead meant
  // that arriving at such a page silently cleared the operator's filter — and then
  // widened the list they were reading without telling them.
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
          return createdMs(a) - createdMs(b);
        case 'risk_desc':
          return riskOf(b) - riskOf(a) || createdMs(b) - createdMs(a);
        case 'risk_asc':
          return riskOf(a) - riskOf(b) || createdMs(b) - createdMs(a);
        default:
          return createdMs(b) - createdMs(a);
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
   *
   * Both halves bind every control added here. A new control that portals out must move
   * focus with it or the panel will stop closing; a new control that consumes Escape
   * without leaving the subtree would have its Escape swallowed AND take the panel down
   * with it. The paging control below is a plain `<button>`: it neither portals nor
   * consumes the key, so it is neutral to both halves.
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

  /**
   * The sort MENU is the intersection of what this panel can express with what the
   * server said it can sort by, so a deployment whose store orders a different set of
   * fields gets the right menu with no client change. Before the first response there is
   * nothing to intersect with, so everything is offered.
   */
  const sortOptions = React.useMemo(
    () =>
      DRILLDOWN_SORTS.filter(
        (o) => sortableFields == null || sortableFields.includes(o.field),
      ),
    [sortableFields],
  );
  // A sort the server cannot honour is returned to the default rather than left showing
  // a choice that is not being applied.
  React.useEffect(() => {
    if (sortOptions.length > 0 && !sortOptions.some((o) => o.key === sort)) {
      setSort(sortOptions[0].key);
    }
  }, [sortOptions, sort]);

  // ---- What the panel can honestly say about what it read ------------------ //
  const rowsRead = rows?.length ?? 0;
  const pagesRead = read?.pages ?? 1;
  const readThrough = read?.through ?? rowsRead;
  /** Did the store PROVE that everything matching the request has now been read? */
  const complete = proven && total != null && readThrough >= total;
  const nextOffset = (page + 1) * pageSize;
  const storeExhausted = read != null && read.lastPage < read.size;
  const beyondCeiling = maxOffset != null && nextOffset > maxOffset;
  const moreToRead =
    !loading &&
    error == null &&
    read != null &&
    !storeExhausted &&
    (total == null || readThrough < total);

  /**
   * The narrowings that were evaluated over the ROWS READ rather than over the
   * population. Naming them is the difference between "these are the cases" and "these
   * are the cases I could see" — and every one of them can change the answer.
   */
  const populationResolvedBy = spec.populationResolvedBy ?? 'rows-read';
  const sortHonoured =
    appliedSort == null ||
    (appliedSort.field === sortOption.field && appliedSort.order === sortOption.order);
  const pageScoped: string[] = [];
  if (populationResolvedBy !== 'store') pageScoped.push('this tile’s own population rule');
  if (band !== ANY) pageScoped.push('the severity band');
  if (status !== ANY) pageScoped.push('the status filter');
  if (search.trim() !== '') pageScoped.push('the free-text search');
  // The store orders the WHOLE matching set, so the ordering is page-scoped only when
  // something else already narrowed the rows in the browser — the top N of a
  // browser-side subset is not the top N of that subset's population — or when the store
  // could not honour the sort at all. Naming it in the remaining case would be a false
  // caveat, which is the same failure as an absent one pointed the other way.
  if (pageScoped.length > 0 || !sortHonoured) pageScoped.push('the ordering');

  const caveats: string[] = [];
  if (pageScoped.length > 0 && rows != null) {
    caveats.push(
      `Evaluated over the ${fmtNumber(rowsRead)} rows read, not the whole population: ` +
        `${pageScoped.join(', ')}.`,
    );
  }
  if (!sortHonoured) {
    caveats.push('This deployment could not sort by the field asked for; the default order is shown.');
  }
  caveats.push(
    bandMenuFromWindow
      ? 'Severity options come from the window’s server-side band tally.'
      : 'Severity options are derived from the rows read.',
  );
  caveats.push(
    statusGroup
      ? 'Status options come from every page read here, over a lifecycle set the store selected.'
      : 'Status options come from every page read here.',
  );
  if (total != null && rows != null) {
    // Two numerals, two questions. The row counts describe what was read; `total` counts
    // what the store matched. Presenting them as one number would be the whole lie this
    // panel exists not to tell.
    caveats.push(
      `${fmtNumber(total)} counts every case the store matched for this request; the counts above describe the rows read.`,
    );
  }
  if (beyondCeiling && moreToRead) {
    caveats.push('Deeper pages are past the paging ceiling this endpoint serves; narrow the range instead.');
  }

  // ---- What the drill-through can carry ------------------------------------ //
  const contextWindowHours =
    range === 'all' ? null : range === 'window' ? spec.windowHours : RANGE_HOURS[range];
  const targetContext: DrilldownTargetContext = {
    band: band === ANY ? null : band,
    status: status === ANY ? null : status,
    windowHours: contextWindowHours,
    search: search.trim(),
    sort,
  };
  const honoured = spec.target?.honours ?? [];
  const setKeys = (Object.keys(CONTEXT_LABEL) as (keyof DrilldownTargetContext)[]).filter(
    (k) => {
      if (k === 'search') return targetContext.search !== '';
      if (k === 'sort') return sort !== DRILLDOWN_SORTS[0].key;
      if (k === 'windowHours') return targetContext.windowHours != null;
      return targetContext[k] != null;
    },
  );
  const dropped = setKeys.filter((k) => !honoured.includes(k));
  const carried = setKeys.filter((k) => honoured.includes(k));

  return (
    /* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- Escape-to-close
       is the WAI disclosure contract, and the handler has to sit on the SUBTREE ROOT:
       focus is moved into this section on open (the heading is programmatically
       focusable) and then moves freely across its search box, four Selects, the paging
       control and the drill-through, so any narrower target would leave Escape dead from
       most of the panel. A document-level listener would be worse, not better — it would
       close a NON-MODAL panel from Escape presses that belong to the rest of the page.
       The section deliberately carries no role: it is not a dialog and must not claim to
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
              {sortOptions.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
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
            'Re-reading this range…'
          ) : (
            <>
              {pagesRead <= 1
                ? `Showing ${fmtNumber(visible.length)} of ${fmtNumber(population.length)} in this page`
                : `Showing ${fmtNumber(visible.length)} of ${fmtNumber(population.length)} in the ${fmtNumber(pagesRead)} pages read`}
              {/* The tile's numeral is a server rollup over the whole window; this list
                  is one or more pages of it. Never imply they are the same measurement,
                  and never call a page after the first "the newest N" — it is not. */}
              {total != null && rows != null
                ? complete
                  ? pagesRead <= 1
                    ? ` · complete page of ${fmtNumber(total)} case${total === 1 ? '' : 's'}`
                    : ` · complete: all ${fmtNumber(total)} case${total === 1 ? '' : 's'} read`
                  : pagesRead <= 1
                    ? ` · newest ${fmtNumber(rows.length)} of ${fmtNumber(total)} read · lower bound`
                    : ` · rows 1–${fmtNumber(readThrough)} of ${fmtNumber(total)} read · lower bound`
                : ' · bounded page'}
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {moreToRead && !beyondCeiling ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              data-testid="kpi-drilldown-more"
              aria-label={`Read the next ${fmtNumber(pageSize)} ${spec.title} cases`}
              className="h-7 px-2 text-2xs"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              Read more
            </Button>
          ) : null}
          {spec.target ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => spec.target?.onSelect(targetContext)}
              data-testid="kpi-drilldown-drillthrough"
              className="h-7 px-2 text-2xs"
            >
              {spec.target.label}
            </Button>
          ) : null}
        </div>
        {caveats.length > 0 && !error && !loading ? (
          <p
            data-testid="kpi-drilldown-caveats"
            className="min-w-0 basis-full text-2xs text-muted-foreground"
          >
            {caveats.join(' ')}
          </p>
        ) : null}
        {/* Only when something the operator set will NOT survive the hand-off. A filter
            that silently disappears is worse than one that never travelled: the
            destination list then looks authoritative while being wider than it claims.
            When everything travels there is nothing to warn about, so this stays quiet. */}
        {spec.target && dropped.length > 0 ? (
          <p
            data-testid="kpi-drilldown-carryover"
            className="min-w-0 basis-full text-2xs text-muted-foreground"
          >
            {carried.length > 0
              ? `“${spec.target.label}” carries ${carried.map((k) => CONTEXT_LABEL[k]).join(', ')}. `
              : ''}
            {`It cannot carry ${dropped
              .map((k) => CONTEXT_LABEL[k])
              .join(', ')} — reapply ${dropped.length === 1 ? 'it' : 'them'} there.`}
          </p>
        ) : null}
      </div>
    </section>
    /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
  );
}

export default KpiDrilldownPanel;
