/**
 * KpiDrilldownPanel — the deep-inspection MODAL behind a KPI tile.
 *
 * ## This reverses a documented decision (#109 / #111), at operator instruction
 *
 * Until now this was a NON-MODAL docked `<section>` that opened below the landing strip.
 * The case for that was written here and is worth stating accurately before it is undone,
 * because one clause of it was true and one was a mechanism error:
 *
 *   "the operator could no longer … compare it with its four neighbours" — RESOLVED, not
 *   overridden. The in-panel metric switcher (see the switcher band below) ships every
 *   tile's key, label and RENDERED numeral, taken verbatim from the same `kpis` array the
 *   strip draws, and re-points the open panel without closing it. SEQUENTIAL comparison
 *   survives intact; SIMULTANEOUS comparison does not, because behind a Radix layer the
 *   neighbouring tiles are `aria-hidden` and `pointer-events: none`. The switcher is
 *   therefore load-bearing, not chrome: deleting it would re-open this objection.
 *
 *   "tab on into the instrument band" — NOT resolved. A focus trap ends it, and that is a
 *   real cost the operator has accepted. It is mitigated only by Escape returning focus to
 *   the exact tile that opened the panel, so the keyboard journey resumes where it stopped.
 *
 *   "marks the rest of the page `inert`" — this was WRONG about the mechanism, and the
 *   specs that asserted `querySelector('[inert]')` were vacuous because of it. Radix uses
 *   `aria-hidden` (via `aria-hidden`'s `hideOthers`) and never sets the `inert` attribute.
 *
 * ## The modal contract
 *
 *   trigger  — the tile `<button>`, carrying `aria-haspopup="dialog"`. It no longer carries
 *              `aria-expanded`/`aria-controls`: those are DISCLOSURE semantics, wrong on a
 *              dialog trigger, and a portalled `aria-controls` target does not exist while
 *              the panel is closed.
 *   panel    — `<DialogContent role="dialog" aria-modal="true" aria-labelledby>` portalled
 *              to `document.body`, over a scrim, with focus trapped.
 *   describe — `aria-describedby` points at the POPULATION sentence, so opening the panel
 *              announces which population is being listed (and, for a window-exempt stock,
 *              that it is "not filtered by the window") rather than dangling.
 *   focus    — moves to the panel's `<h2 tabIndex={-1}>`, never to a filter control:
 *              a screen-reader user must hear WHAT opened before they hear how to
 *              narrow it. `onOpenAutoFocus` is prevented to make that so.
 *   escape   — Radix's own `DismissableLayer` owns Escape AND the scrim click; both route
 *              through `onOpenChange(false)` → `onClose`. The hand-rolled containment
 *              guard this file used to carry is gone with the non-modal contract that
 *              needed it.
 *   return   — the PARENT restores focus to the trigger tile synchronously in its close
 *              handler (only it holds the tile refs). The built-in Radix close (X) is
 *              suppressed with `hideClose`, because it is the one path that would drop
 *              focus on `<body>`; this panel renders its own labelled Close instead.
 *
 * ## Geometry: a page-in-page, not a growing dialog
 *
 * The height is FIXED (`h-[92dvh]`, capped at 900px), never `max-h`: identical for three
 * rows or two hundred, with the row table absorbing the difference. `max-h-[900px]` is
 * load-bearing — `h-*` and `max-h-*` are different tailwind-merge groups, so the base
 * `max-h-[85dvh]` on `DialogContent` would survive and silently clamp the panel; only the
 * pixel cap evicts it. Width mirrors the product's own page cap (`PageContainer` `wide`)
 * rather than a narrower dialog width, because a drill-down must not be narrower than the
 * dashboard it explains.
 *
 * Interior: four `shrink-0` bands (identity · switcher · toolbar · footer) around EXACTLY
 * ONE `min-h-0 flex-1 overflow-auto` scroll region. The footer is a SIBLING of that
 * scroller, never a child, so the completeness disclosure cannot clip under a fixed shell
 * on a short laptop. The old `max-h-80` on the row table is gone: that 320px constant, not
 * the dialog, was what wasted the vertical space this change is about.
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
import { ChevronDown, Download, Search, X } from 'lucide-react';

import type { Case, CasesResponse } from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
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
  /**
   * The detection source selected, or null for "all sources". No destination can honour
   * it today — the case list has no server-side source filter — so it is carried here
   * precisely so the hand-off DISCLOSES it as dropped instead of losing it in silence.
   */
  source: string | null;
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
  source: 'detection source',
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
  /**
   * The dialog element's own `id`, and the stem for the population sentence's `id`
   * (`aria-describedby`). It is no longer an `aria-controls` target: the trigger is a
   * dialog trigger, and a portalled target does not exist while the panel is closed.
   */
  panelId: string;
  /** `aria-labelledby` target — the panel's own heading. */
  headingId: string;
  /**
   * Close the panel. The PARENT restores focus to the trigger tile.
   *
   * Reached from three places, all of which must behave identically: this panel's own
   * Close button, Radix's Escape, and a scrim click. The latter two arrive through
   * `onOpenChange(false)`.
   */
  onClose: () => void;
  /**
   * The element focus must return to on close (WCAG 2.4.3) — the tile that opened this.
   *
   * A getter rather than a ref, because only the PARENT holds the tile refs and only it
   * knows which tile is current. It is read during Radix's close-autofocus, so it must be
   * evaluated then and not captured earlier.
   *
   * MEASURED, not assumed: without this, focus lands on `<body>` for BOTH close paths.
   * `DialogContent` hard-wires `onCloseAutoFocus` to
   * `event.preventDefault(); context.triggerRef.current?.focus()`, and `triggerRef` is null
   * here because the panel opens from STATE, never a `DialogTrigger` — so Radix suppresses
   * `FocusScope`'s own restore and then focuses nothing. A synchronous `.focus()` in the
   * parent's close handler does not fix it either: it runs while the trap is still mounted
   * and is bounced straight back. This is the same fix, and the same reasoning, as the
   * CaseDetail sheet (`pages/CaseDetail.tsx`), which is opened from state for the same
   * reason and already carries its own regression spec.
   */
  restoreFocusTo?: () => HTMLElement | null;
  /**
   * Every metric the strip offers, so the operator can move between populations without
   * closing and reopening the panel. Omitted → no switcher is rendered and the panel is
   * exactly the single-metric disclosure it has always been.
   *
   * The switcher's counts are the TILES' numerals, which are server rollups over the
   * dashboard's window. The table below reads pages of the case list. They answer
   * different questions and must never be presented as one measurement — hence the
   * switcher is labelled as the dashboard's own numerals, and the footer keeps stating
   * what this panel actually read.
   */
  metrics?: readonly KpiDrilldownMetric[];
  /** Select another metric. The PARENT owns which tile is expanded, so it owns this. */
  onSelectMetric?: (key: string) => void;
  className?: string;
}

/** One entry in the metric switcher: a tile's key, its label, and the numeral it shows. */
export interface KpiDrilldownMetric {
  key: string;
  label: string;
  /** The tile's rendered numeral, verbatim — never recomputed here. */
  value: React.ReactNode;
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

/**
 * A DURATION, on the same ladder `humanizeAge` uses for an instant but without its "ago":
 * these read as spans ("4h", "3d") rather than as points in time. Kept local because it is
 * the only span this file needs and `format.ts` deliberately exposes instants.
 */
function humanizeSpan(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 45) return 'under a minute';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

/**
 * One scalar above the table. A `null` value means NOT MEASURED — the backing field is
 * absent across every listed case — and renders as an explicit dash with the reason,
 * never as a zero. Zero and "we cannot tell" are different answers.
 */
interface DrilldownStat {
  key: string;
  label: string;
  value: string | null;
  hint: string;
}

/**
 * One CSV field: RFC-4180 quoted, embedded quotes doubled — and defused for the
 * SPREADSHEET, not merely for the grammar.
 *
 * Quoting alone protects the file's column structure; it does nothing about the program
 * that opens it. Excel and LibreOffice evaluate any cell whose first character is `=`, `+`,
 * `-` or `@` as a formula, quotes included. The fields written here are exactly the ones
 * this codebase classes as UNTRUSTED (#9) — case titles fall back to rule ids, which are
 * source-controlled — so a rule named `=HYPERLINK("http://…",…)` would render in the
 * analyst's spreadsheet as a live link instead of as the rule's name, turning an evidence
 * export into an attacker-authored cell. A leading apostrophe is the standard
 * neutralisation: spreadsheets treat the rest as literal text and do not display it.
 */
function csvField(value: unknown): string {
  const raw = String(value ?? '');
  const defused = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${defused.replace(/"/g, '""')}"`;
}

/** Filename-safe slug of a panel title. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cases';
}

/**
 * The listed rows as CSV.
 *
 * It exports exactly what the operator is looking at — the filtered, sorted rows the
 * table renders — and nothing more. It is NOT a population export: the panel reads bounded
 * pages, so a caller must present this as the rows read, which is why the row count
 * travels in the filename and the footer keeps stating the bound.
 *
 * Every field is quoted, so a case title containing a comma, a quote or a newline cannot
 * shift the column layout of the row it sits in.
 */
export function drilldownCsv(rows: readonly Case[]): string {
  const header = [
    'case_id',
    'case_number',
    'created_at',
    'title',
    'detection_source',
    'severity_band',
    'risk_score',
    'status',
    'assignee',
  ];
  const lines = [header.map(csvField).join(',')];
  for (const c of rows) {
    lines.push(
      [
        c.case_id,
        c.case_number ?? '',
        c.created_at ?? '',
        displayTitle(c),
        c.detection_source ?? '',
        c.severity_band ?? '',
        typeof c.risk_score === 'number' ? c.risk_score : '',
        c.status ?? '',
        c.assignee ?? '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
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
  restoreFocusTo,
  metrics,
  onSelectMetric,
  className,
}: KpiDrilldownPanelProps) {
  const { onOpenCase } = spec;
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  /**
   * `aria-describedby` target. Pointing it at the POPULATION sentence does two jobs at
   * once: it removes the dangling reference Radix would otherwise leave (it wires
   * `aria-describedby` before the consumer spread, so passing `undefined` is not enough),
   * and it makes the panel ANNOUNCE, on open, which population is being listed — including
   * the "not filtered by the window" caveat that a window-exempt stock carries.
   */
  const populationId = `${panelId}-population`;

  const [range, setRange] = React.useState<DrilldownRange>(spec.defaultRange);
  const [sort, setSort] = React.useState<DrilldownSort>('recent');
  const [search, setSearch] = React.useState('');
  const [band, setBand] = React.useState<string>(ANY);
  const [status, setStatus] = React.useState<string>(ANY);
  /** Detection-source facet — client-side, over the rows read (there is no server one). */
  const [source, setSource] = React.useState<string>(ANY);
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
   * Detection sources seen across every page read for this question, not just the page in
   * hand — the same session-scoped union the two facets above use, and for the same
   * reason. Deriving the menu from the CURRENT rows instead is self-defeating: a source
   * that first appears on page two can only be selected after paging there, and selecting
   * it resets paging to page one, whose rows may not contain it — so the menu shrinks and
   * the self-heal effect below silently clears the filter the operator just set.
   */
  const [sourceUniverse, setSourceUniverse] = React.useState<string[]>(NO_TOKENS);

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
  /**
   * Whether the operator has CHOSEN a range, as opposed to being handed a default.
   *
   * This distinction is what lets the metric switcher carry a range across a swap without
   * lying. Carrying an untouched default would silently put a window on a population that
   * has none — the open-case stock is all-time — and show a windowed subset under a
   * numeral that counted the whole stock. Carrying an EXPLICIT choice is the opposite: the
   * operator asked to look at a range, and dropping it on every metric change would defeat
   * the comparison the switcher exists to support.
   */
  const [rangeTouched, setRangeTouched] = React.useState(false);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    // An operator-set range survives the swap; an untouched default is replaced by the
    // incoming population's own natural horizon.
    if (!rangeTouched) setRange(spec.defaultRange);
    setSort('recent');
    // The free text survives too. It is always an explicit act, and it is the narrowing
    // an operator most often wants to hold while moving between populations.
    // The two FACETS do not: a band or status drawn from one population's rows may not
    // exist in the next, and the self-healing effects below would drop them anyway.
    setBand(ANY);
    setStatus(ANY);
    setSource(ANY);
    /**
     * Drop the PREVIOUS metric's data with its label.
     *
     * Without this the heading, the population sentence, the stat cards, the table and the
     * completeness footer all re-point to the incoming metric a full commit before its
     * rows arrive — so for one render the panel states the new population's name over the
     * old population's cases and the old population's proven totals. That is precisely the
     * disagreement every other line in this file exists to prevent, and the metric switcher
     * is what made it reachable.
     *
     * A RANGE change deliberately does NOT do this (see the question branch below): there
     * the population is the same and only its horizon moved, so the previous rows stay
     * mounted and the footer says "Re-reading this range…" rather than blanking.
     */
    setRows(null);
    setTotal(null);
    setRead(null);
    setProven(false);
    setLoading(true);
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
    setSourceUniverse(NO_TOKENS);
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
  const pagingKey = [questionKey, sort, search, band, status, source].join('\u0000');
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
      setSourceUniverse((prev) => mergeTokens(prev, fresh.map((c) => c.detection_source)));
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
      if (source !== ANY && (c.detection_source || '').trim() !== source) return false;
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
  }, [population, search, status, band, source, sort]);

  const facetsApplied =
    search.trim() !== '' || status !== ANY || band !== ANY || source !== ANY;

  /**
   * Download the LISTED rows as CSV — what the operator is looking at, filtered and
   * sorted as they left it, and nothing more. The row count is in the filename because
   * this is a page export, not a population export; the footer states the bound.
   *
   * Same Blob/anchor pattern the recovery-code download already uses. The object URL is
   * revoked immediately: the click is synchronous, so the browser has already taken the
   * data by the time this returns.
   */
  const exportCsv = React.useCallback(() => {
    if (typeof document === 'undefined' || !visible.length) return;
    // Feature-DETECTED, not assumed. `URL.createObjectURL` is absent in some environments
    // (jsdom implements no object-URL store at all), and an unguarded call there is a
    // TypeError thrown out of an onClick — which in this suite is a failed run, not a
    // degraded download. Nothing else on the page depends on this succeeding, so the
    // honest fallback is to do nothing rather than to throw.
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([drilldownCsv(visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentic-soc-${slug(spec.title)}-${visible.length}-cases.csv`;
    a.click();
    URL.revokeObjectURL?.(url);
  }, [visible, spec.title]);

  /**
   * Detection-source facet options, from the rows read.
   *
   * There is no server-side source narrowing on the case list, so unlike `status_group`
   * this cannot be pushed into the store: the menu can only offer what the pages read
   * actually contain, and selecting one narrows those same rows. That is the same
   * contract the severity and status facets already carry, and the footer already states
   * it. `detection_source` is the PRODUCT's word (detection | anomaly | rule); it is not
   * a vendor "sensor" and must never be relabelled as one.
   */
  const sourceFacets = React.useMemo(
    () => [...sourceUniverse].sort((a, b) => a.localeCompare(b)),
    [sourceUniverse],
  );
  React.useEffect(() => {
    if (source !== ANY && !sourceFacets.includes(source)) setSource(ANY);
  }, [source, sourceFacets]);

  /**
   * The four scalars above the table.
   *
   * Every one is computed over `visible` — the EXACT rows the table lists — so a card can
   * never disagree with the list beneath it. They are deliberately NOT taken from the
   * posture rollup that feeds the tile numerals: that rollup answers over the whole
   * window while this panel reads pages, and putting the two side by side under one
   * heading would imply an agreement that does not exist. The block says which it is.
   *
   * A card whose backing field is absent across every row is reported as NOT MEASURED
   * rather than as zero. "No case here has been acknowledged" and "zero acknowledged" are
   * different claims, and the lifecycle anchors are optional on the backend and default
   * to null, so the unpopulated deployment is the ordinary case rather than an error.
   */
  const statCards = React.useMemo<DrilldownStat[]>(() => {
    const n = visible.length;
    if (!n) return [];
    const unassigned = visible.filter((c) => !(c.assignee || '').trim()).length;
    const acked = visible.filter((c) => Boolean(c.acknowledged_at)).length;
    /**
     * Whether this deployment RECORDS acknowledgement at all, which is a different
     * question from whether anything has been acknowledged. The key is present-and-null on
     * every case once the backend serializes it, and absent entirely on one that does not,
     * so presence of the KEY is the test — not truthiness of the value. Getting this
     * backwards is what made a real zero indistinguishable from an unimplemented field.
     */
    const ackRecorded = visible.some((c) => c.acknowledged_at !== undefined);
    const ages = visible
      .map((c) => createdMs(c))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b);
    const now = Date.now();
    const median =
      ages.length > 0 ? now - ages[Math.floor((ages.length - 1) / 2)] : null;
    const oldest = ages.length > 0 ? now - ages[0] : null;
    return [
      {
        key: 'unassigned',
        label: 'Unassigned',
        value: fmtNumber(unassigned),
        hint: `of ${fmtNumber(n)} listed`,
      },
      {
        key: 'acknowledged',
        label: 'Acknowledged',
        // A measured ZERO is a real answer and reads as "0 of 40 listed". Only a
        // deployment that records no acknowledgement instants at all reads as not-measured.
        value: ackRecorded ? fmtNumber(acked) : null,
        hint: ackRecorded
          ? `of ${fmtNumber(n)} listed`
          : 'this deployment records no acknowledgement instant',
      },
      {
        key: 'median-age',
        label: 'Median age',
        value: median == null ? null : humanizeSpan(median),
        hint: median == null ? 'no listed case carries a creation instant' : 'since created',
      },
      {
        key: 'oldest',
        label: 'Oldest',
        value: oldest == null ? null : humanizeSpan(oldest),
        hint: oldest == null ? 'no listed case carries a creation instant' : 'since created',
      },
    ];
  }, [visible]);

  /**
   * Escape and the scrim click are Radix's, not ours.
   *
   * The panel used to carry a hand-rolled Escape handler with a CONTAINMENT guard, because
   * a non-modal disclosure had to tell its own Escape apart from a Radix Select's (which
   * portals out of the subtree) and from a neighbouring hover card's (which marked the key
   * `defaultPrevented` from a document-level capture listener). None of that survives the
   * modal contract: `DismissableLayer` owns dismissal, layers unwind newest-first, and the
   * neighbouring hover cards cannot open at all behind the scrim. Both paths arrive here as
   * `onOpenChange(false)`.
   */
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  /**
   * Focus the HEADING, never a filter control: a screen-reader user must hear WHAT opened
   * before they hear how to narrow it. This covers the OPEN; the `spec.key` effect above
   * covers a metric SWITCH, where the dialog does not remount and this never fires.
   */
  const onOpenAutoFocus = React.useCallback((event: Event) => {
    event.preventDefault();
    headingRef.current?.focus();
  }, []);

  /**
   * Focus RETURN on close. `composeEventHandlers` runs this BEFORE Radix's own handler and
   * skips Radix's once this one has prevented the default — so claiming the default is
   * exactly what stops focus being dropped on `<body>`.
   */
  const onCloseAutoFocus = React.useCallback(
    (event: Event) => {
      const opener = restoreFocusTo?.() ?? null;
      // Only claim the default when there is somewhere real to send focus. An opener that
      // has since unmounted is left to Radix rather than focused blind.
      if (opener && opener.isConnected) {
        event.preventDefault();
        opener.focus();
      }
    },
    [restoreFocusTo],
  );

  const rangeOptions: DrilldownRange[] = ['window', '1h', '24h', '7d', '30d', 'all'];
  const windowOptionLabel = `Dashboard window (${spec.windowHours}h)`;
  /** The range currently in force, named the way its own menu names it. */
  const activeRangeLabel = range === 'window' ? windowOptionLabel : RANGE_LABEL[range];
  /**
   * True when this panel's own range applies a bound the TILE's population does not carry,
   * so the population sentence above the list would otherwise describe something wider
   * than the rows shown. `all` never narrows; otherwise a `from` bound really is sent.
   */
  const rangeNarrows = range !== 'all' && spec.defaultRange === 'all';

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
  // The detection source belongs here for the same reason the two facets above do — it is
  // applied in the BROWSER over the rows read, because the case list offers no server-side
  // source narrowing to push it into. A narrowing that changes the list but not this
  // sentence is exactly the silent kind this disclosure exists to prevent.
  if (source !== ANY) pageScoped.push('the detection source');
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
    source: source === ANY ? null : source,
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        // Radix wires `role="dialog"`, `aria-labelledby` and `aria-describedby` BEFORE the
        // consumer spread, but it never sets `aria-modal` (it hides the rest of the page
        // with `aria-hidden` instead). The contract asks for the flag, so it is stated here.
        aria-modal="true"
        aria-labelledby={headingId}
        // Never `undefined`: Radix's own default would then dangle. Pointing it at the
        // population sentence also makes the open ANNOUNCE which population is listed.
        aria-describedby={populationId}
        id={panelId}
        data-testid="kpi-drilldown"
        data-kpi={spec.key}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        // The built-in top-right X is suppressed for TWO reasons: it is absolutely
        // positioned into this header's own control row, and it is the one close path that
        // drops focus on `<body>` (this panel opens from STATE, never a `DialogTrigger`, so
        // Radix's default `onCloseAutoFocus` has a null trigger to restore to). The panel's
        // own labelled Close calls `onClose` directly, and the PARENT restores focus.
        hideClose
        className={cn(
          // A page-in-page: the height is FIXED so the shell is identical for three rows or
          // two hundred, and the row table absorbs the difference. `max-h-[900px]` is
          // LOAD-BEARING — `h-*` and `max-h-*` are different tailwind-merge groups, so the
          // base `max-h-[85dvh]` survives a bare `h-[92dvh]` and silently clamps the panel.
          // Dynamic viewport units only — mobile URL bars make the static ones wrong, and
          // `viewport-units.test.ts` lints this file for them. The width is
          // `w-[calc(100%-2rem)]` rather than a viewport-width unit, which would
          // double-count the scrollbar Radix's react-remove-scroll has already removed.
          'flex h-[92dvh] max-h-[900px] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0',
          // The width cap MIRRORS the product's own page cap (PageContainer `wide`). A
          // drill-down must never be narrower than the dashboard it explains.
          'max-w-[1760px] 2xl:max-w-[1920px]',
          className,
        )}
      >
        {/* ---- BAND 1a — IDENTITY (shrink-0) ------------------------------------- */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
          {/* Where the operator is. Plain text, product vocabulary only. */}
          <p
            data-testid="kpi-drilldown-breadcrumb"
            className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-2xs text-muted-foreground"
          >
            <span className="truncate">Cyber Defence Center</span>
            <span aria-hidden>/</span>
            <span className="truncate text-foreground">{spec.title}</span>
            <span aria-hidden>/</span>
            <span className="truncate">Deep inspection</span>
          </p>
          {/* The dialog's accessible NAME, rendered `asChild` so it stays an <h2> — a
              heading-jump user must still find it, and Radix's default <h2>-styled div
              would not be one. `tabIndex={-1}` so `onOpenAutoFocus` can move focus here. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle asChild>
              <h2
                ref={headingRef}
                id={headingId}
                tabIndex={-1}
                data-testid="kpi-drilldown-heading"
                className="-mx-1 rounded-sm px-1 text-xs font-semibold uppercase tracking-widest text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {spec.title} · details
              </h2>
            </DialogTitle>
            {/* Completeness, from the SAME three-valued `window_total_exact` read the footer
                states at length — never a "LIVE" badge, which would claim a freshness this
                panel does not measure. Withheld entirely until a page has been read, because
                before that `complete` is false for want of evidence, not for want of rows. */}
            {rows != null && !error && !loading ? (
              <Badge
                variant={complete ? 'success' : 'secondary'}
                data-testid="kpi-drilldown-completeness"
                className="px-1.5 py-0 text-2xs"
              >
                {complete ? 'Complete page' : 'Bounded page · lower bound'}
              </Badge>
            ) : null}
          </div>
          {/* The population sentence describes the TILE's population, which is not always
              the population this panel is listing. A window-exempt stock says in so many
              words that it is "not filtered by the window" — and stays true only until the
              operator picks a range, which really is pushed down as a `from` bound. Left
              alone the sentence then contradicts the list directly underneath it, which is
              worse than saying nothing: it is the surface an operator reads to decide what
              the rows in front of them ARE. So the narrowing is stated beside it whenever
              one is in force.

              It is also the dialog's `aria-describedby` target, so it is announced on open.
              It must therefore stay a RENDERED, visible text node — never `sr-only`, never
              hover-only: a sighted operator needs it as much as a screen-reader one. */}
          <p
            id={populationId}
            data-testid="kpi-drilldown-population"
            className="mt-0.5 text-2xs text-muted-foreground"
          >
            {spec.population}
            {rangeNarrows ? (
              <>
                {' '}
                <span className="text-foreground">
                  Narrowed here to {activeRangeLabel} — the list below is a slice of that
                  population, not the whole of it.
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Exports the LISTED rows, which is why the label says so rather than
              "Export report" — the panel reads bounded pages and must not offer what
              looks like a population export. Hidden with nothing to export. */}
          {visible.length ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={exportCsv}
              data-testid="kpi-drilldown-export"
              aria-label={`Download the ${fmtNumber(visible.length)} listed ${spec.title} cases as CSV`}
              className="h-7 px-2 text-2xs"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export listed
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="kpi-drilldown-close"
            className="h-7 px-2 text-2xs"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Close
          </Button>
        </div>
      </div>

        {/* ---- BAND 1b — METRIC SWITCHER (shrink-0) -------------------------------
            This band is LOAD-BEARING, not chrome. Behind a modal scrim the four
            neighbouring tiles are `aria-hidden` and unclickable, so this is the only
            remaining way to compare populations — which is exactly the objection the
            non-modal contract raised. It gets its OWN row rather than sitting inline in
            the header, and it is NEVER breakpoint-gated: hiding it below `xl` would delete
            that justification on a 13" laptop. Our labels are long ("False Positive Rate",
            "Resolved / Closed"), so inline placement would also wrap and grow the header.

            Deliberately NOT a Radix Tabs: the panels these would control are the strip's
            own tiles, which live outside this dialog, so a tablist here would claim an
            ownership it does not have. This is a labelled group of buttons, each carrying
            `aria-pressed` for the one that is current.

            The numerals are the TILES' numerals, restated verbatim — server rollups over
            the dashboard's window. The table below reads pages of the case list. The group
            label says which these are, and the footer keeps saying what the table read, so
            the two are never presented as one measurement. */}
        {metrics && metrics.length > 1 && onSelectMetric ? (
          <div
            role="group"
            aria-label="Switch metric — values are the dashboard's own numerals"
            data-testid="kpi-drilldown-metrics"
            className="flex min-w-0 shrink-0 flex-wrap gap-1 border-b border-border/60 px-5 py-2"
          >
          {/* Visible, not only in the group's aria-label: a sighted operator otherwise sees
              five bare numerals with nothing saying they are whole-window rollups rather
              than counts of the rows in the table below. */}
          <p className="w-full text-2xs text-muted-foreground">
            Switch metric — these numerals are the dashboard&rsquo;s own window rollups, not
            counts of the rows listed below.
          </p>
          {metrics.map((m) => {
            const current = m.key === spec.key;
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={current}
                data-testid={`kpi-drilldown-metric-${m.key}`}
                onClick={() => {
                  if (current) return;
                  onSelectMetric(m.key);
                }}
                className={cn(
                  'inline-flex min-w-0 items-center gap-1.5 rounded-[4px] border px-2 py-1 text-2xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  current
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                <span className="truncate">{m.label}</span>
                <span className="shrink-0 font-mono tabular-nums text-foreground">{m.value}</span>
              </button>
            );
          })}
        </div>
      ) : null}

        {/* ---- BAND 2 — TOOLBAR (shrink-0) ----------------------------------------
            Every narrowing the operator can apply, lifted out of the body so the scroll
            region below is nothing but evidence. It WRAPS and never scrolls: a toolbar with
            its own scrollbar hides controls, and hidden controls are the ones that get
            re-applied by accident.

            These are NOT all server-side, and the panel never pretends otherwise. Only the
            time range and the status group are pushed down to the store; severity, detection
            source and the free-text search are evaluated in the BROWSER over the rows read.
            The footer NAMES each browser-side narrowing that is in force (see `pageScoped`),
            so a narrowing can never change the list without changing the sentence under it. */}
        <div
          role="group"
          aria-label={`${spec.title} detail filters`}
          data-testid="kpi-drilldown-controls"
          className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-muted/20 px-5 py-2.5 text-xs"
        >
          <div className="relative min-w-0 flex-1 basis-56">
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
              className="h-8 w-auto min-w-36 rounded-[4px] text-xs"
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
              className="h-8 w-auto min-w-36 rounded-[4px] text-xs"
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

          {/* Detection source. Offered only when the rows read actually carry one, because
              unlike `status_group` there is no server-side source narrowing to push this
              into — the menu can only describe the pages that were read, and an empty menu
              would invite a filter that could never match. */}
          {sourceFacets.length ? (
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger
                className="h-8 w-auto min-w-36 rounded-[4px] text-xs"
                aria-label={`Filter ${spec.title} cases by detection source`}
                data-testid="kpi-drilldown-source"
              >
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All sources</SelectItem>
                {sourceFacets.map((s) => (
                  <SelectItem key={s} value={s}>
                    {humanizeToken(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <div className="flex min-w-0 items-center gap-2.5">
            <Select value={sort} onValueChange={(v) => setSort(v as DrilldownSort)}>
              <SelectTrigger
                className="h-8 w-auto min-w-36 rounded-[4px] text-xs"
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

            <Select
              value={range}
              onValueChange={(v) => {
                // Mark the range as the OPERATOR's, so a metric switch carries it forward
                // instead of resetting to the next population's default.
                setRangeTouched(true);
                setRange(v as DrilldownRange);
              }}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-36 rounded-[4px] text-xs"
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

      {/* ---- BAND 3 — THE ONE SCROLL REGION (min-h-0 flex-1) --------------------
          Exactly one scroller, and `min-h-0` is what makes it real: without it a flex item
          refuses to shrink below its content and the fixed shell would overflow instead of
          scrolling, taking the footer disclosure off-screen with it.

          The old `max-h-80` on the row table is gone. That 320px constant, not the dialog,
          was what wasted the vertical space this change is about — and because the sticky
          `<thead>` pins to its nearest scrollport, moving the scroll here is also what makes
          the header pin to the box the operator is actually looking at.

          `tabIndex={0}` + an accessible name is what makes the scroller reachable at all by
          keyboard: the row table is wider than the panel at narrow widths and high zoom, and
          every focusable cell lives in the FIRST column, so without a focusable scroll port a
          keyboard-only operator could never reach Source, Severity, Status or Owner. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- a SCROLLABLE region is the
          documented exception: WCAG 2.1.1 requires a container that scrolls to be
          keyboard-operable, and giving it an accessible name is exactly how that is done. The
          rule cannot see that `overflow-auto` plus wider content makes this element operable. */}
      <div
        data-testid="kpi-drilldown-scroll"
        tabIndex={0}
        role="group"
        aria-label={`${spec.title} cases — scrollable evidence`}
        className="min-h-0 min-w-0 flex-1 overflow-auto px-5 pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
      {spec.trend ? (
        <div
          data-testid="kpi-drilldown-trend"
          className="sticky left-0 mb-3 mt-3 rounded-md border border-border/70 bg-background/40 p-3"
        >
          <MetricTrendBody {...spec.trend} />
        </div>
      ) : null}

      {/* The four scalars, all computed over the rows the table lists — so a card can
          never disagree with the list under it. The heading says whose numbers these are,
          because the tile numerals above them answer over the whole window instead. */}
      {statCards.length ? (
        <div className="sticky left-0 mb-3 mt-3">
          <p className="mb-1.5 text-2xs text-muted-foreground">
            Over the {fmtNumber(visible.length)} case{visible.length === 1 ? '' : 's'} listed
            below, not the whole window.
          </p>
          <dl
            data-testid="kpi-drilldown-stats"
            className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {statCards.map((s) => (
              <div
                key={s.key}
                data-testid={`kpi-drilldown-stat-${s.key}`}
                className="min-w-0 rounded-md border border-border/70 bg-background/40 px-2.5 py-2"
              >
                <dt className="truncate text-2xs uppercase tracking-widest text-muted-foreground">
                  {s.label}
                </dt>
                {/* The hint lives INSIDE the <dd>: a <div> in a <dl> may contain only
                    <dt>/<dd>, so a sibling <p> here is a definition-list violation. */}
                <dd className="mt-0.5 min-w-0">
                  <span
                    className={cn(
                      'block font-mono text-sm font-semibold tabular-nums',
                      s.value == null ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {s.value ?? DASH}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-2xs font-normal text-muted-foreground"
                    title={s.hint}
                  >
                    {s.hint}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

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
          /* A real table, because these rows carry independent per-column facts that an
             operator scans down rather than reads across. Its own horizontal scroller:
             the shell's <main> is `overflow-x-hidden`, so a wide table inside it would be
             CLIPPED rather than scrollable. Every column below is backed by a field the
             Case really carries — no column is invented, and any the population does not
             carry renders an explicit dash. */
          /* This wrapper deliberately carries NO overflow of its own. The one scroll port
             is the band above it, so the sticky `<thead>` pins to the box the operator sees;
             a second scroller here would re-introduce the nested-scroller problem and pin the
             header to a box that never moves. */
          <div
            data-testid="kpi-drilldown-rows"
            className="min-w-0 rounded-md border border-border/70"
          >
            <table className="w-full min-w-[44rem] border-collapse text-left">
              <caption className="sr-only">
                {spec.title} — the cases read for the current filters
              </caption>
              {/* Sticky against the ONE scroll port above. The opaque fill lives on the CELLS:
                  a background on `<thead>` is not reliably painted, and rows scrolling
                  behind a transparent header read straight through its labels. */}
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-border/70 text-2xs uppercase tracking-widest text-muted-foreground">
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Case</th>
                  {/* CREATED, not "detected". `Case.detected_at` is declared on the wire
                      but no backend path assigns it, so a "Detected" column could only ever
                      show the creation instant under a label that claims a sensor time the
                      product does not have. Naming the field we actually read is the whole
                      fix. */}
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Created</th>
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Title / rule</th>
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Source</th>
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Severity</th>
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Status</th>
                  <th scope="col" className="bg-card px-2 py-1.5 font-semibold">Owner</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const id = displayId(c);
                  const title = displayTitle(c);
                  const owner = (c.assignee || '').trim();
                  const detectionSource = (c.detection_source || '').trim();
                  return (
                    <tr
                      key={c.case_id}
                      data-testid="kpi-drilldown-row"
                      className="border-b border-border/60 last:border-b-0 hover:bg-muted/30"
                    >
                      <td className="px-2 py-1.5 align-top font-mono text-xs">
                        {onOpenCase ? (
                          <button
                            type="button"
                            onClick={() => onOpenCase(c.case_id)}
                            // WCAG 2.5.3 (Label in Name): this button's visible label is
                            // the case IDENTIFIER, so the accessible name has to contain
                            // it — speech input targets what a user can see. The id trails
                            // the title so the name still READS as a sentence.
                            aria-label={`Open case ${title} (${id})`}
                            className="max-w-28 truncate rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={id}
                          >
                            {id}
                          </button>
                        ) : (
                          <span className="block max-w-28 truncate text-foreground" title={id}>
                            {id}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 align-top font-mono text-2xs text-muted-foreground">
                        {humanizeAge(c.created_at)}
                      </td>
                      <td className="px-2 py-1.5 align-top text-xs">
                        <span className="block max-w-72 truncate text-foreground" title={title}>
                          {title}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 align-top text-2xs text-muted-foreground">
                        {detectionSource ? humanizeToken(detectionSource) : DASH}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <SeverityBadge
                          severity={c.severity_band ?? c.risk_score ?? null}
                          className="rounded-sm px-1.5 py-0.5 text-2xs"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <StatusBadge
                          status={c.status}
                          className="rounded-sm px-1.5 py-0.5 text-2xs"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top text-2xs text-muted-foreground">
                        <span className="block max-w-28 truncate" title={owner || undefined}>
                          {owner || 'Unassigned'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

        {/* ---- FOOTER — PINNED (shrink-0) -----------------------------------------
            A SIBLING of the scroller, never a child of it. In normal flow this could not clip;
            under a fixed shell on a 700px-tall laptop it would, and the thing that would clip is
            the completeness disclosure — the one sentence that separates a drill-down from a
            lie. It states what was read, whether the store PROVED that page complete, which
            narrowings were applied to the rows rather than to the population, and offers the
            full list. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-5 py-2.5">
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
                    and never call a page after the first "the newest N" — it is not.
                    Page ONE is not "the newest" either unless the newest-first sort is the
                    one in force: under "Oldest first" it is the oldest rows, and under
                    either risk sort it is neither. The store really applies all four, so
                    the neutral "first N in this order" is the only phrasing true of all of
                    them — and the order itself is named by the Sort control beside it. */}
                {total != null && rows != null
                  ? complete
                    ? pagesRead <= 1
                      ? ` · complete page of ${fmtNumber(total)} case${total === 1 ? '' : 's'}`
                      : ` · complete: all ${fmtNumber(total)} case${total === 1 ? '' : 's'} read`
                    : pagesRead <= 1
                      ? ` · first ${fmtNumber(rows.length)} of ${fmtNumber(total)} in this order · lower bound`
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
                // CLOSE, then hand off. Today the hand-off navigates away and unmounts the
                // page this panel lives on, so the modal would disappear either way — but
                // that is the DESTINATION's behaviour, not this panel's, and a modal left
                // open over a page the operator has just left is never right. Closing first
                // also returns focus to the tile before the route changes, so the operator
                // is not dropped on `<body>` at the far end.
                onClick={() => {
                  onClose();
                  spec.target?.onSelect(targetContext);
                }}
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
      </DialogContent>
    </Dialog>
  );
}

export default KpiDrilldownPanel;
