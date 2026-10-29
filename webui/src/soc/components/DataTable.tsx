/**
 * DataTable: the ONE table primitive for the console.
 *
 * a11y contract (Round-5 W0-E / DESIGN_STANDARD §6.2/§6.3):
 *  - Sortable headers are `<button>` inside `<th scope="col">`; `aria-sort` is set
 *    ONLY on the active column (omitted otherwise, never `"none"`), and the change
 *    is ALSO spoken through the shared live region (VoiceOver/TalkBack ignore
 *    `aria-sort`).
 *  - Pointer-clickable rows expose a dedicated, named action button for keyboard
 *    and assistive-technology users. The `<tr>` itself is never given an interactive
 *    role because rows can also contain checkboxes, menus, and links.
 *  - `getRowLabel` names a row the way the screen shows it ("Select CASE-000048",
 *    "Open CASE-000048"), never by an internal id only a developer would recognise.
 *  - `rowAccent` draws an OPT-IN left-edge severity band (non-color-only reading of
 *    row risk, §6.1) as an inset box-shadow (no layout shift, no extra column).
 *  - Round 14 (SPEC §4.9.2, C7): one table grammar. Compact density by default (36px
 *    header, about 38px rows); 12px medium sentence-case headers; `table-layout: fixed`
 *    whenever a column declares a `width`, with every cell (text, or a badge or chip
 *    group) kept to one line; a cut shows as an ellipsis (text) or a trailing fade (an
 *    atomic badge or chip), the full value shown on hover only when it is cut
 *    (`TruncatedText`; a rich cell names its value with the column's `text`); `kind` keeps ids (in the identifier face), times, IPs and numbers on one
 *    line with tabular figures; a right-edge fade while more columns are scrollable; an
 *    optional sticky first column; `surface="panel"` drops the table's own box so it bleeds
 *    to a `Panel padding="none"` edge with its first column on the panel inset;
 *    `emptyState` replaces the whole table (header row included) when there is nothing to
 *    list at all (never for an emptied later page, which keeps its pager).
 *  - 2.5.7 Dragging: this table has NO drag interaction. Column reorder ships via the
 *    keyboard-accessible `<ColumnsMenu>` (checklist + move controls), NOT drag, so
 *    the no-single-pointer-drag requirement is met by construction. If a future
 *    variant adds drag-to-reorder, it MUST keep a non-drag "move up/down" alternative.
 */
import * as React from 'react';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { LoadingBar } from '@/design-system/loading-bar';
import { LoadingState } from '@/design-system/loading';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/ui/table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
// The right-edge fade measurement, in its own module so a table that is not a
// `DataTable` (the Logs sheet) shares it without importing this one.
import { useOverflowRight } from '@/soc/hooks/useOverflowRight';
import { useAnnouncer } from './announcer';
import { EmptyState } from './EmptyState';
import { semanticColor } from './palette';
import { ProvenanceTag, type Provenance } from './ProvenanceTag';

export type SortDir = 'asc' | 'desc';

/**
 * Per-table column customization state (Wave 7). `order` is the ordered list of
 * column ids the user arranged; `hidden` are the column ids they hid; `widths` is
 * an optional column id → px width map. An empty/absent state renders the table's
 * built-in default columns unchanged.
 */
export interface ColumnState {
  order?: string[];
  hidden?: string[];
  widths?: Record<string, number>;
}

export interface SortState {
  /** Column id currently sorted by. */
  id: string;
  dir: SortDir;
}

/**
 * What a column holds (Round 14). `text` (default) is words: proportional figures, one
 * truncated line in a fixed-layout table. `number`, `id`, `time` and `ip` never wrap and
 * use tabular figures, so digits line up down the column and "CASE- / 000109" or a
 * timestamp never breaks across lines; `id` is also set in the identifier face (12px
 * JetBrains Mono, SPEC §3.1), so "CASE-000100" fits a 120px column whole; `number` also
 * aligns right unless `align` says otherwise.
 */
export type DataTableColumnKind = 'text' | 'number' | 'id' | 'time' | 'ip';

export interface DataTableColumn<T> {
  /** Stable id, also used as the sort key reported to onSortChange. */
  id: string;
  /** Header label. */
  header: React.ReactNode;
  /** Cell renderer for a row. UNTRUSTED values must render plain / via CodeBlock. */
  cell: (row: T, rowIndex: number) => React.ReactNode;
  /** Enable the sortable header affordance for this column. */
  sortable?: boolean;
  /** Extra classes for the <th>. */
  headerClassName?: string;
  /** Extra classes for the <td>. */
  className?: string;
  /** Horizontal alignment of the cell + header content. */
  align?: 'left' | 'center' | 'right';
  /**
   * Width of the column (e.g. '12rem' or 120). Any declared width switches the table to
   * `table-layout: fixed`, so the width holds and long text truncates instead of widening
   * the column. Columns without a width share the remaining space.
   */
  width?: string | number;
  /**
   * The narrowest a column WITHOUT a `width` may get in a fixed-layout table (default
   * 8rem; the Cases title column uses 280px). A fixed layout shares the spare width
   * EQUALLY among the columns without a width, so the table's minimum width plans for
   * every one of them at the largest of their minimums; below that the table scrolls
   * sideways, with the right-edge fade, rather than squeeze a column under its minimum.
   */
  minWidth?: string | number;
  /**
   * The cell's value as plain text, for a cell that renders a node (a badge, a chip): in
   * a fixed-layout table it is the hover title when the cell is cut. Without it the
   * title is the cell's text content.
   */
  text?: (row: T, rowIndex: number) => string;
  /** What the column holds; see {@link DataTableColumnKind}. Default `text`. */
  kind?: DataTableColumnKind;
  /**
   * Let a text cell wrap instead of truncating to one line in a fixed-layout table (a
   * description column that is meant to be read whole). Default false.
   */
  wrap?: boolean;
  /**
   * When true (Wave 7 column customization), this column can never be hidden via
   * the "Columns" menu (e.g. the primary id column). Defaults false.
   */
  lockVisible?: boolean;
  /**
   * A short, plain-text label for the "Columns" menu checklist (used when `header`
   * is a non-string node). Falls back to a string `header`, else the column id.
   */
  menuLabel?: string;
  /**
   * Provenance of this column's values (Round-7 #9b): WHO produced them: the raw
   * `source` (SIEM-asserted), the `ai` agent (LLM), or deterministic `code`. When set,
   * a small `<ProvenanceTag variant="icon">` renders beside the header so the whole
   * column is attributed at a glance. Use for columns whose provenance is CONSTANT
   * (risk/verdict/confidence); per-row-varying provenance (severity) tags the cell
   * instead. Absent → no tag (back-compatible).
   */
  provenance?: Provenance;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable id for a row (selection + react keys). */
  getRowId: (row: T, index: number) => string;

  /** Controlled sort state. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;

  /**
   * Controlled pagination (1-based page). When omitted, the footer pager hides. The
   * pager also hides when everything fits on one page and no page-size choice would
   * change that (Round 14: "no pager for one page").
   */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /** Page-size options shown in the footer select. */
  pageSizeOptions?: number[];

  /** Row selection (controlled). When `selectable`, a checkbox column is prepended. */
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (selected: string[]) => void;
  /** Optional per-row selection gate (e.g. read-only Demo Mode overlay rows). */
  isRowSelectable?: (row: T, index: number) => boolean;
  /** Plain-text explanation exposed on a disabled row-selection control. */
  getRowSelectionDisabledReason?: (row: T, index: number) => string | undefined;

  onRowClick?: (row: T, index: number) => void;
  /** Accessible name for the dedicated row action button. */
  getRowActionLabel?: (row: T, index: number) => string;
  /**
   * The row's name as a person reads it ("CASE-000048"), for the selection checkbox's
   * accessible name ("Select CASE-000048"). Without it the checkbox names the row by
   * `getRowId`, which is often an internal id a screen reader user never sees on screen.
   */
  getRowLabel?: (row: T, index: number) => string;
  /**
   * The header checkbox's accessible name, said the way the page counts what it selects
   * ("Select all cases on this page"). It selects the rows of the current page only, so
   * the default names rows, never "all" of a longer list.
   */
  selectAllLabel?: string;
  /** What a row is, for the selection announcements ("25 cases selected"). Default: rows. */
  rowNoun?: { one: string; other: string };
  /**
   * Render the shared trailing keyboard action for a pointer-clickable row. Disable
   * only when a visible cell already contains an equivalent named button/link.
   */
  showRowAction?: boolean;

  /** Initial loading shows a centered table state; refresh keeps existing rows mounted. */
  loading?: boolean;
  /** Static row-shape hint behind the centered initial loader. */
  loadingRows?: number;
  /**
   * Empty-state content shown in one row UNDER the header (string or node): use it when
   * the table is empty because of an active filter, so the columns stay in view.
   */
  empty?: React.ReactNode;
  /**
   * The table's empty state when there is nothing to list at all (Round 14, X12): the
   * whole table, header row included, is replaced by this node (typically an
   * `<EmptyState>`), sitting on the panel or card. Takes precedence over `empty`.
   */
  emptyState?: React.ReactNode;

  /**
   * Visual density. `compact` (the default since Round 14) is the operational density:
   * 36px header, about 38px rows. `normal` keeps the roomier pre-Round-14 rows.
   */
  density?: 'normal' | 'compact';

  /**
   * `bordered` (default): the table owns one bounded hairline box on the canvas.
   * `panel`: the table sits in a `Panel padding="none"` and has no box of its own; its
   * rows bleed to the panel edge and its first and last columns sit on the panel inset
   * (16px, 20px from 1280px, 24px from 1920px), so the first column lines up with the
   * panel title.
   */
  surface?: 'bordered' | 'panel';

  /**
   * Keep the first column (after the selection checkbox) in view while the table scrolls
   * sideways. Its cells get an opaque surface fill and keep the row's hover and
   * selected tint.
   */
  stickyFirstColumn?: boolean;

  /** Extra classes on the outer wrapper. */
  className?: string;
  /** Caption / aria-label for the table (a11y). */
  ariaLabel?: string;

  /**
   * Pin the header row while the body scrolls (Round-7 #8). OFF by default
   * (back-compatible). Passes through to the `<TableHeader sticky>` primitive, which
   * parks the header under the app bar (`top-[var(--header-h)]`) with an OPAQUE
   * background so scrolled rows never bleed through it.
   */
  sticky?: boolean;

  // ---- Column customization (Wave 7; optional + back-compatible) --------- //
  /**
   * Controlled per-table column state (show/hide/reorder). When provided, the table
   * applies `hidden` (drops those columns) and `order` (reorders them). Columns with
   * `lockVisible` can never be hidden. Omitting this keeps the table's built-in
   * default column order/visibility, unchanged. The user-facing control lives in the
   * sibling `<ColumnsMenu>` (mounted in the page toolbar) which the page wires to
   * PrefsContext + feeds back here.
   */
  columnState?: ColumnState;

  /**
   * Left-edge severity band (Round-5 W0-E / §6.1 non-color signaling). OFF by
   * default (back-compatible). When provided, each dense row gets a 3px colored bar
   * on its leading edge derived from a per-row SEVERITY label/score, so the risk of
   * a row is legible at a glance at high row counts WITHOUT relying on a tiny colored
   * word in a cell. Return a severity label ('critical'/'high'/'medium'/'low'/'info')
   * or a 0-100 score (resolved via the ONE palette authority), or null/undefined for
   * no band on that row. The band is decorative (`aria-hidden`); the cell content
   * still carries the accessible value.
   */
  rowAccent?: (row: T, index: number) => string | number | null | undefined;
}

const alignClass = (align?: 'left' | 'center' | 'right') =>
  align === 'right'
    ? 'text-right'
    : align === 'center'
      ? 'text-center'
      : 'text-left';

/** A column's effective alignment: `number` columns align right unless told otherwise. */
const columnAlign = <T,>(col: DataTableColumn<T>) =>
  col.align ?? (col.kind === 'number' ? 'right' : undefined);

/** `number`, `id`, `time` and `ip` cells: one line, tabular figures; ids in the identifier face. */
const kindClass = (kind?: DataTableColumnKind) =>
  kind === 'id'
    ? 'whitespace-nowrap tabular-nums font-mono text-xs'
    : kind && kind !== 'text'
      ? 'whitespace-nowrap tabular-nums'
      : undefined;

/** A CSS length for a width/minWidth hint (numbers are pixels). */
const cssLength = (value: string | number) => (typeof value === 'number' ? `${value}px` : value);

/** The panel inset on the table's leading and trailing edge (`surface="panel"`). */
const PANEL_EDGE_START = 'pl-4 xl:pl-5 3xl:pl-6';
const PANEL_EDGE_END = 'pr-4 xl:pr-5 3xl:pr-6';

/**
 * Sticky-column body cells need an opaque fill (rows scroll underneath them), so they
 * repaint the row's hover and selected tint themselves as an inset wash over that fill:
 * the same `muted/40` and `accent/60` steps `TableRow` uses, on whichever surface the
 * table sits. The leading sticky cell also carries the row's severity band (`rowAccent`)
 * as a `--row-accent` colour composed into the same shadow, above the wash, so the band,
 * the hover and the selection all show together (an inline box-shadow would beat the
 * hover and selected classes).
 */
const STICKY_CELL =
  'sticky z-[1] bg-card ' +
  'shadow-[inset_3px_0_0_0_var(--row-accent,transparent)] ' +
  '[tr:hover>&]:shadow-[inset_3px_0_0_0_var(--row-accent,transparent),inset_0_0_0_100vmax_hsl(var(--muted)/0.4)] ' +
  '[tr[data-state=selected]>&]:shadow-[inset_3px_0_0_0_var(--row-accent,transparent),inset_0_0_0_100vmax_hsl(var(--accent)/0.6)]';

/** Sticky header cells: the opaque fill only (the header row has no hover or selected tint). */
const STICKY_HEAD = 'sticky z-[1] bg-card';

/** The selection announcements' noun when a table does not name its rows. */
const DEFAULT_ROW_NOUN = { one: 'row', other: 'rows' } as const;

function SortIcon({ active, dir }: { active: boolean; dir?: SortDir }) {
  if (!active)
    return (
      <ChevronsUpDown
        className="ml-1.5 inline-block size-3 text-muted-foreground/40 transition-colors"
        aria-hidden
      />
    );
  return dir === 'asc' ? (
    <ChevronUp className="ml-1.5 inline-block size-3 text-foreground" aria-hidden />
  ) : (
    <ChevronDown className="ml-1.5 inline-block size-3 text-foreground" aria-hidden />
  );
}

export interface TruncatedTextProps extends React.HTMLAttributes<HTMLElement> {
  /** The text. A string or number child is also the hover title when it is cut. */
  children?: React.ReactNode;
  /** The full value for the hover title, when the child is not plain text (else its text content). */
  fullText?: string;
  /**
   * Rich content (a badge, a chip group, a link): a `div` that clips only sideways, so
   * a focus ring above or below still shows. Inline text that does not fit ends in an
   * ellipsis; an atomic piece (a badge, a chip, an icon) that cannot take one is cut at
   * the column edge with its trailing 1.5rem faded (`data-cut="fade"`), so a cut always
   * shows. Default: one line of plain text in a `span`.
   */
  rich?: boolean;
}

/**
 * How a cut rich wrapper shows that it is cut, or `null` when everything fits.
 * `ellipsis`: only inline text overflows, and the wrapper's own `text-overflow` draws
 * the ellipsis. `fade`: an atomic piece (an inline-flex badge, an icon) or a block child
 * runs past the wrapper's content edge; the browser cannot ellipsise it, so the wrapper
 * fades its trailing edge instead. Reads layout only (no writes), so a batch of wrappers
 * is measured in one pass.
 */
export function richCutSignal(el: HTMLElement): 'fade' | 'ellipsis' | null {
  if (el.scrollWidth <= el.clientWidth + 0.5) return null;
  const style = getComputedStyle(el);
  const end =
    el.getBoundingClientRect().right -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderRightWidth) || 0);
  const queue: Element[] = Array.from(el.children);
  while (queue.length) {
    const node = queue.shift() as Element;
    const css = getComputedStyle(node);
    if (css.display === 'none') continue;
    if (css.display === 'inline' || css.display === 'contents') {
      // Inline boxes share the wrapper's line, so its ellipsis covers their text.
      queue.push(...Array.from(node.children));
      continue;
    }
    if (node.getBoundingClientRect().right > end + 0.5) return 'fade';
    const ellipsisOwn = css.textOverflow === 'ellipsis' && css.overflowX !== 'visible';
    if (!ellipsisOwn && node.scrollWidth > node.clientWidth + 0.5) return 'fade';
  }
  return 'ellipsis';
}

/*
 * Rich wrappers are measured in one batched pass per frame (every read, then every
 * write), when they mount or re-render (new content) and when their column changes
 * width or a web font finishes loading. The attribute is written directly, so a
 * measurement never re-renders the table.
 */
const cutPending = new Set<HTMLElement>();
const cutMounted = new Set<HTMLElement>();
let cutFrame: number | null = null;
let cutResize: ResizeObserver | null | undefined;

function flushCutSignals() {
  cutFrame = null;
  const els = Array.from(cutPending).filter((el) => el.isConnected);
  cutPending.clear();
  const signals = els.map(richCutSignal);
  els.forEach((el, i) => writeCutSignal(el, signals[i]));
}

function writeCutSignal(el: HTMLElement, signal: 'fade' | 'ellipsis' | null) {
  if (signal) {
    if (el.getAttribute('data-cut') !== signal) el.setAttribute('data-cut', signal);
  } else if (el.hasAttribute('data-cut')) {
    el.removeAttribute('data-cut');
  }
}

function scheduleCutSignal(el: HTMLElement) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  cutPending.add(el);
  if (cutFrame === null) cutFrame = window.requestAnimationFrame(flushCutSignals);
}

function cutObserver(): ResizeObserver | null {
  if (cutResize === undefined) {
    cutResize =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            for (const entry of entries) scheduleCutSignal(entry.target as HTMLElement);
          })
        : null;
    // A web font that lands after the first measurement changes every text width.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', () => cutMounted.forEach(scheduleCutSignal));
  }
  return cutResize;
}

/** The trailing fade of a cut rich wrapper whose atomic content cannot take an ellipsis. */
const RICH_CUT_FADE =
  'data-[cut=fade]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]';

/**
 * One line, cut with an ellipsis when it does not fit its cell (Round 14, F6). The full
 * value is the native hover title ONLY while the content is actually cut, so an
 * untruncated cell never shows a stray tooltip; the full content stays in the DOM, so a
 * screen reader always reads all of it. Use it inside custom cells; `DataTable` applies
 * it to every cell of a fixed-layout table on its own (except `wrap` columns).
 */
export function TruncatedText({ children, fullText, rich = false, className, onPointerEnter, ...rest }: TruncatedTextProps) {
  const ref = React.useRef<HTMLElement | null>(null);
  const plainChild = typeof children === 'string' || typeof children === 'number' ? String(children) : undefined;
  // A rich wrapper re-measures after every render (its content may have changed) ...
  React.useLayoutEffect(() => {
    if (rich && ref.current) scheduleCutSignal(ref.current);
  });
  // ... and whenever its column changes width.
  React.useEffect(() => {
    const el = ref.current;
    if (!rich || !el) return undefined;
    const observer = cutObserver();
    cutMounted.add(el);
    observer?.observe(el);
    return () => {
      cutMounted.delete(el);
      cutPending.delete(el);
      observer?.unobserve(el);
    };
  }, [rich]);
  const sync = (event: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    const full = fullText ?? plainChild ?? (el?.textContent?.trim() || undefined);
    if (el && full) {
      if (el.scrollWidth > el.clientWidth + 0.5) el.setAttribute('title', full);
      else el.removeAttribute('title');
    }
    if (el && rich) writeCutSignal(el, richCutSignal(el));
    onPointerEnter?.(event);
  };
  if (rich) {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        // The box reaches 4px into the cell's padding on every side (and gives it back as
        // padding, so nothing moves): a focus ring (2px ring, 2px offset) on a control in
        // the cell is drawn whole, inside both the sideways clip and the fade's mask.
        className={cn(
          'block min-w-0 -mx-1 -my-1 px-1 py-1 overflow-x-clip text-ellipsis whitespace-nowrap',
          RICH_CUT_FADE,
          className,
        )}
        data-truncated-text="rich"
        onPointerEnter={sync}
        {...rest}
      >
        {children}
      </div>
    );
  }
  return (
    <span
      ref={ref as React.Ref<HTMLSpanElement>}
      className={cn('block min-w-0 truncate', className)}
      data-truncated-text=""
      onPointerEnter={sync}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * Resolve the DISPLAYED columns from the full column set + the user's column state:
 * hidden ids dropped, then ordered by `order` (any column missing from `order`
 * keeps its original relative position AFTER the ordered ones). Locked columns are
 * never dropped even if `hidden` lists them.
 */
function resolveColumns<T>(
  columns: DataTableColumn<T>[],
  state?: ColumnState,
): DataTableColumn<T>[] {
  if (!state) return columns;
  const hidden = new Set(state.hidden ?? []);
  const order = state.order ?? [];
  const visible = columns.filter((c) => c.lockVisible || !hidden.has(c.id));
  if (!order.length) return visible;
  const byId = new Map(visible.map((c) => [c.id, c] as const));
  const out: DataTableColumn<T>[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      out.push(c);
      byId.delete(id);
    }
  }
  // Any visible columns not named in `order` keep their original order, appended.
  for (const c of visible) if (byId.has(c.id)) out.push(c);
  return out;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  selectable = false,
  selected,
  onSelectedChange,
  isRowSelectable,
  getRowSelectionDisabledReason,
  onRowClick,
  getRowActionLabel,
  getRowLabel,
  selectAllLabel,
  rowNoun = DEFAULT_ROW_NOUN,
  showRowAction = true,
  loading = false,
  loadingRows = 8,
  empty,
  emptyState,
  density = 'compact',
  surface = 'bordered',
  stickyFirstColumn = false,
  className,
  ariaLabel,
  sticky = false,
  columnState,
  rowAccent,
}: DataTableProps<T>) {
  // Shared app-level live announcer (§6.3 / E3); a no-op when no provider is mounted.
  const announce = useAnnouncer();
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);

  // Resolve the displayed columns from the user's stored column state (Wave 7).
  const displayColumns = React.useMemo(
    () => resolveColumns(columns, columnState),
    [columns, columnState],
  );

  const selectedSet = React.useMemo(
    () => new Set(selected ?? []),
    [selected],
  );

  const rowIds = React.useMemo(
    () => rows.map((r, i) => getRowId(r, i)),
    [rows, getRowId],
  );

  const selectableRowIds = React.useMemo(
    () =>
      rows
        .map((row, index) => ({ id: rowIds[index], row, index }))
        .filter(({ row, index }) => isRowSelectable?.(row, index) ?? true)
        .map(({ id }) => id),
    [rows, rowIds, isRowSelectable],
  );

  const allSelected =
    selectable &&
    selectableRowIds.length > 0 &&
    selectableRowIds.every((id) => selectedSet.has(id));
  const someSelected =
    selectable && selectableRowIds.some((id) => selectedSet.has(id)) && !allSelected;

  const onPanel = surface === 'panel';
  // A declared width anywhere switches the table to fixed layout, so widths hold.
  const fixedLayout = displayColumns.some((c) => c.width != null);

  // Roomy horizontal padding (below 16px columns visually merge), operational vertical
  // rhythm in compact density, the pre-Round-14 rows in normal density.
  const cellPad = density === 'compact' ? 'px-4 py-2' : 'px-4 py-3';

  // A fixed-layout table never squeezes a flexible column below its minimum. The browser
  // gives the fixed columns their widths and splits what is left EQUALLY among the
  // columns without one, so the table's minimum is the fixed widths plus, for the N
  // flexible columns, N times the largest of their minimums; below that it scrolls
  // sideways (with the right-edge fade).
  const tableMinWidth = React.useMemo(() => {
    if (!fixedLayout) return undefined;
    const parts: string[] = [];
    if (selectable) parts.push(onPanel ? '3rem' : '2.5rem'); // the widest checkbox column
    const flexMins: string[] = [];
    for (const col of displayColumns) {
      if (col.width != null) {
        const w = cssLength(col.width);
        if (!w.trim().endsWith('%')) parts.push(w);
      } else {
        flexMins.push(cssLength(col.minWidth ?? '8rem'));
      }
    }
    const distinct = Array.from(new Set(flexMins));
    if (flexMins.length === 1) parts.push(flexMins[0]);
    else if (distinct.length === 1) parts.push(`${flexMins.length} * ${distinct[0]}`);
    else if (flexMins.length > 1) parts.push(`${flexMins.length} * max(${distinct.join(', ')})`);
    if (onRowClick && showRowAction) parts.push('3rem');
    return parts.length ? `calc(${parts.join(' + ')})` : undefined;
  }, [fixedLayout, selectable, onPanel, displayColumns, onRowClick, showRowAction]);

  // A short plain-text name for a column, for the live announcement (§6.3). Prefer
  // an explicit `menuLabel`, then a string `header`, else the column id.
  const columnName = (col: DataTableColumn<T>): string =>
    col.menuLabel ?? (typeof col.header === 'string' ? col.header : col.id);

  const handleHeaderSort = (col: DataTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    const isActive = sort?.id === col.id;
    const nextDir: SortDir =
      isActive && sort?.dir === 'asc' ? 'desc' : 'asc';
    onSortChange({ id: col.id, dir: nextDir });
    // aria-sort is silently ignored by VoiceOver / TalkBack, so speak the change
    // through the shared live region too (§6.3).
    announce(
      `Sorted by ${columnName(col)}, ${nextDir === 'asc' ? 'ascending' : 'descending'}`,
    );
  };

  const toggleAll = () => {
    if (!onSelectedChange) return;
    if (allSelected) {
      onSelectedChange((selected ?? []).filter((id) => !selectableRowIds.includes(id)));
      announce(`All ${rowNoun.other} deselected`);
    } else {
      const merged = new Set(selected ?? []);
      selectableRowIds.forEach((id) => merged.add(id));
      onSelectedChange(Array.from(merged));
      announce(
        `${selectableRowIds.length} ${selectableRowIds.length === 1 ? rowNoun.one : rowNoun.other} selected`,
      );
    }
  };

  const toggleRow = (id: string, row: T, index: number) => {
    if (!onSelectedChange) return;
    if (isRowSelectable && !isRowSelectable(row, index)) return;
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(Array.from(next));
  };

  const hasRowAction = Boolean(onRowClick && showRowAction);
  const colCount =
    displayColumns.length + (selectable ? 1 : 0) + (hasRowAction ? 1 : 0);

  // Pagination math.
  const effTotal = total ?? rows.length;
  const pageCount =
    pageSize && pageSize > 0 ? Math.max(1, Math.ceil(effTotal / pageSize)) : 1;
  const curPage = page ?? 1;
  const canPrev = curPage > 1;
  const canNext = curPage < pageCount;
  const smallestPageSize = pageSizeOptions.length ? Math.min(...pageSizeOptions) : pageSize ?? 0;
  // One page and no page-size choice that would change it: the pager says nothing.
  const pagerHasWork =
    pageCount > 1 || curPage > 1 || (onPageSizeChange != null && effTotal > smallestPageSize);
  const showPager =
    page != null &&
    pageSize != null &&
    (onPageChange != null || total != null) &&
    (pagerHasWork || (selectable && (selected?.length ?? 0) > 0));
  const initialLoading = loading && rows.length === 0;
  const refreshing = loading && rows.length > 0;
  const loadingLabel = ariaLabel ? `Loading ${ariaLabel}` : 'Loading table';
  // "Nothing to list at all": an emptied later page (rows closed by bulk work, a stale
  // page in the link) still has records, so it keeps its header, the `empty` row and
  // the pager to go back.
  const showEmptyState =
    !loading && rows.length === 0 && emptyState != null && effTotal === 0 && curPage <= 1;

  const fadeRight = useOverflowRight(scrollEl, [rows, displayColumns, showEmptyState]);

  // The leading/trailing cell of every row: the panel inset when the table bleeds to a
  // panel edge, so the first column lines up with the panel title.
  const firstDataIndex = 0;
  const lastDataIndex = displayColumns.length - 1;
  const edgeStart = (isFirstCell: boolean) => (onPanel && isFirstCell ? PANEL_EDGE_START : undefined);
  const edgeEnd = (isLastCell: boolean) => (onPanel && isLastCell ? PANEL_EDGE_END : undefined);
  // The checkbox column, when present, is the leading cell; the row action the trailing one.
  const firstIsData = !selectable;
  const lastIsData = !hasRowAction;
  // The checkbox column: its leading inset, the 16px box and 8px to the next column.
  const selectWidth = onPanel ? 'w-10 xl:w-11 3xl:w-12' : 'w-10';
  const stickyDataLeft = selectable ? (onPanel ? 'left-10 xl:left-11 3xl:left-12' : 'left-10') : 'left-0';

  const container = cn(
    'relative',
    onPanel
      ? // On a panel the table is part of the module: no box, no radius, no own fill.
        'bg-transparent'
      : // A bounded data surface, not a detached card: the hairline owns the edge.
        'overflow-hidden rounded-md border border-border/80 bg-card',
    className,
  );

  if (showEmptyState) {
    return (
      <div className={container} data-surface={surface} data-table-empty="">
        {emptyState}
      </div>
    );
  }

  return (
    <div className={container} aria-busy={loading} data-surface={surface}>
      <LoadingBar
        active={refreshing}
        size="sm"
        label={loadingLabel}
        data-testid="data-table-loading-indicator"
        className="absolute inset-x-0 top-0 z-20 rounded-none bg-transparent"
      />
      <div className="relative">
        <div ref={setScrollEl} className="relative w-full overflow-auto" data-table-scroll="">
          <Table
            unwrapped
            aria-label={ariaLabel}
            layout={fixedLayout ? 'fixed' : 'auto'}
            style={tableMinWidth ? { minWidth: tableMinWidth } : undefined}
          >
            <TableHeader sticky={sticky}>
              <TableRow className="hover:bg-transparent">
                {selectable && (
                  <TableHead
                    density={density}
                    className={cn(selectWidth, 'px-4', edgeStart(true), stickyFirstColumn && cn(STICKY_HEAD, 'left-0'))}
                  >
                    <Checkbox
                      checked={
                        allSelected ? true : someSelected ? 'indeterminate' : false
                      }
                      onCheckedChange={toggleAll}
                      aria-label={
                        selectAllLabel ?? (isRowSelectable ? 'Select all available rows' : 'Select all rows')
                      }
                      disabled={initialLoading || selectableRowIds.length === 0}
                    />
                  </TableHead>
                )}
                {displayColumns.map((col, colIndex) => {
                  const isActive = sort?.id === col.id;
                  const align = columnAlign(col);
                  const stickyCell = stickyFirstColumn && colIndex === firstDataIndex;
                  return (
                    <TableHead
                      key={col.id}
                      scope="col"
                      density={density}
                      style={col.width ? { width: cssLength(col.width) } : undefined}
                      className={cn(
                        // Header typography (12px medium, sentence case, muted) comes
                        // from the TableHead primitive; keep labels on one line.
                        'whitespace-nowrap',
                        alignClass(align),
                        edgeStart(firstIsData && colIndex === firstDataIndex),
                        edgeEnd(lastIsData && colIndex === lastDataIndex),
                        stickyCell && cn(STICKY_HEAD, stickyDataLeft),
                        col.headerClassName,
                      )}
                      // §6.3: reflect the sort ONLY on the actively-sorted sortable
                      // column; OMIT aria-sort otherwise (never emit "none", which some
                      // SRs announce as a spurious "not sorted" on every column).
                      aria-sort={
                        col.sortable && isActive
                          ? sort?.dir === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                    >
                      {col.sortable ? (
                        <button
                          type="button"
                          onClick={() => handleHeaderSort(col)}
                          className={cn(
                            'group -mx-1 inline-flex items-center rounded-sm px-1 py-0.5 ' +
                              'font-medium text-muted-foreground',
                            'transition-colors hover:text-foreground',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
                            isActive && 'text-foreground',
                          )}
                        >
                          <span>{col.header}</span>
                          {col.provenance && (
                            <ProvenanceTag
                              kind={col.provenance}
                              variant="icon"
                              className="ml-1"
                            />
                          )}
                          <SortIcon active={isActive} dir={sort?.dir} />
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <span>{col.header}</span>
                          {col.provenance && (
                            <ProvenanceTag kind={col.provenance} variant="icon" />
                          )}
                        </span>
                      )}
                    </TableHead>
                  );
                })}
                {hasRowAction ? (
                  <TableHead
                    scope="col"
                    density={density}
                    className={cn('w-12 px-2 text-right', edgeEnd(true))}
                  >
                    <span className="sr-only">Row actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>

            <TableBody>
              {initialLoading ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="p-0">
                    <LoadingState
                      data-testid="data-table-initial-loading"
                      label={loadingLabel}
                      description="Preparing the latest records."
                      layout="table"
                      shape="rows"
                      shapeRows={loadingRows}
                    />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="h-48 p-0">
                    {empty ?? <EmptyState title="No results" compact />}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, rowIndex) => {
                  const id = rowIds[rowIndex];
                  const isSelected = selectedSet.has(id);
                  const rowSelectable = isRowSelectable?.(row, rowIndex) ?? true;
                  // The row as a person reads it: its label when the table has one (a case
                  // number), else "row <id>".
                  const rowLabel = getRowLabel?.(row, rowIndex)?.trim();
                  const rowName = rowLabel || `row ${id}`;
                  // A caller's reason does not name the row, so its checkbox name adds the
                  // label ("Sample data cannot be changed: CASE-000048"); the default reason
                  // already names it ("Selection unavailable for CASE-000048"), once.
                  const customDisabledReason = rowSelectable
                    ? undefined
                    : getRowSelectionDisabledReason?.(row, rowIndex);
                  const selectionDisabledReason = rowSelectable
                    ? undefined
                    : customDisabledReason ?? `Selection unavailable for ${rowName}`;
                  const selectionName = rowSelectable
                    ? `Select ${rowName}`
                    : customDisabledReason
                      ? `${customDisabledReason}: ${rowLabel || id}`
                      : `Selection unavailable for ${rowName}`;
                  const clickable = !!onRowClick;
                  // Left-edge severity band (§6.1), opt-in via `rowAccent`. Drawn as an
                  // inset box-shadow so it needs no extra column and never shifts layout.
                  // Decorative: the cell content carries the accessible severity value.
                  // Under a sticky leading cell (opaque, it would hide the row's band) the
                  // band moves onto that cell.
                  const accent = rowAccent?.(row, rowIndex);
                  const accentColor =
                    accent !== null && accent !== undefined && accent !== ''
                      ? semanticColor(String(accent))
                      : undefined;
                  const accentShadow = accentColor ? `inset 3px 0 0 0 ${accentColor}` : undefined;
                  const accentOnRow = accentShadow && !stickyFirstColumn;
                  // On a sticky leading cell the band is a colour the cell's own shadow
                  // classes compose (STICKY_CELL), never an inline box-shadow.
                  const stickyAccent =
                    stickyFirstColumn && accentColor
                      ? ({ '--row-accent': accentColor } as React.CSSProperties)
                      : undefined;
                  return (
                    <TableRow
                      key={id}
                      data-state={isSelected ? 'selected' : undefined}
                      className={cn(
                        clickable && 'cursor-pointer',
                      )}
                      style={accentOnRow ? { boxShadow: accentShadow } : undefined}
                      onClick={
                        clickable
                          ? (event) => {
                              const target = event.target;
                              if (
                                target instanceof Element &&
                                target.closest(
                                  'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="menuitem"]',
                                )
                              ) {
                                return;
                              }
                              onRowClick?.(row, rowIndex);
                            }
                          : undefined
                      }
                    >
                      {selectable && (
                        <TableCell
                          className={cn(
                            cellPad,
                            edgeStart(true),
                            stickyFirstColumn && cn(STICKY_CELL, 'left-0'),
                          )}
                          style={stickyAccent}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="inline-flex" title={selectionDisabledReason}>
                            <Checkbox
                              checked={isSelected}
                              disabled={!rowSelectable}
                              onCheckedChange={() => toggleRow(id, row, rowIndex)}
                              aria-label={selectionName}
                            />
                          </span>
                        </TableCell>
                      )}
                      {displayColumns.map((col, colIndex) => {
                        const content = col.cell(row, rowIndex);
                        const plain = typeof content === 'string' || typeof content === 'number';
                        // A fixed column keeps every cell to one line: plain text truncates
                        // itself; rich content (a badge, a chip group) is clipped sideways
                        // only, never over its neighbour: inline text behind an ellipsis, an
                        // atomic badge or chip behind a trailing fade, with every focus ring
                        // drawn whole. Both carry the full value as the hover title while
                        // cut. `wrap` opts out.
                        const truncate = fixedLayout && !col.wrap;
                        const fullText = truncate ? col.text?.(row, rowIndex) : undefined;
                        const stickyCell = stickyFirstColumn && colIndex === firstDataIndex;
                        const leadingAccent = stickyCell && !selectable ? stickyAccent : undefined;
                        return (
                          <TableCell
                            key={col.id}
                            style={
                              col.width || leadingAccent
                                ? {
                                    ...(col.width ? { width: cssLength(col.width) } : {}),
                                    ...leadingAccent,
                                  }
                                : undefined
                            }
                            className={cn(
                              cellPad,
                              alignClass(columnAlign(col)),
                              kindClass(col.kind),
                              edgeStart(firstIsData && colIndex === firstDataIndex),
                              edgeEnd(lastIsData && colIndex === lastDataIndex),
                              stickyCell && cn(STICKY_CELL, stickyDataLeft),
                              col.className,
                            )}
                          >
                            {truncate ? (
                              <TruncatedText rich={!plain} fullText={fullText}>
                                {content}
                              </TruncatedText>
                            ) : (
                              content
                            )}
                          </TableCell>
                        );
                      })}
                      {hasRowAction ? (
                        <TableCell className={cn('w-12 px-2 py-1 text-right', edgeEnd(true))}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 scroll-mt-[var(--header-h)] rounded-sm text-muted-foreground hover:text-foreground"
                            aria-label={
                              getRowActionLabel?.(row, rowIndex) ?? `Open ${rowName}`
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              onRowClick?.(row, rowIndex);
                            }}
                          >
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {/* The right-edge fade: more columns are scrollable to the right. Decorative (the
            scroll region itself is reachable by keyboard through its cells). */}
        {fadeRight ? (
          <div
            aria-hidden="true"
            data-testid="data-table-fade-right"
            className="pointer-events-none absolute inset-y-0 right-0 z-[11] w-10 bg-gradient-to-l from-card to-transparent"
          />
        ) : null}
      </div>

      {showPager && (
        <div
          className={cn(
            'flex flex-col gap-3 border-t text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
            onPanel
              ? cn('border-border/70 bg-transparent py-3', PANEL_EDGE_START, PANEL_EDGE_END)
              : 'border-border bg-surface/40 px-4 py-3',
          )}
        >
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              {effTotal.toLocaleString()} row{effTotal === 1 ? '' : 's'}
            </span>
            {selectable && (selected?.length ?? 0) > 0 && (
              <span className="font-medium tabular-nums text-foreground">
                {selected!.length.toLocaleString()} selected
              </span>
            )}
          </div>

          {pagerHasWork ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:w-auto sm:flex-nowrap sm:justify-start sm:gap-5">
              {onPageSizeChange && pageSize != null && (
                <div className="flex items-center gap-2">
                  <span className="hidden sm:inline">Rows per page</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => onPageSizeChange(Number(v))}
                  >
                    <SelectTrigger className="h-7 w-[4.5rem] text-xs" aria-label="Rows per page">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {pageSizeOptions.map((opt) => (
                        <SelectItem key={opt} value={String(opt)}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <span className="whitespace-nowrap tabular-nums">
                Page {curPage.toLocaleString()} of {pageCount.toLocaleString()}
              </span>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  onClick={() => onPageChange?.(1)}
                  disabled={!canPrev}
                  aria-label="First page"
                >
                  <ChevronsLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  onClick={() => onPageChange?.(curPage - 1)}
                  disabled={!canPrev}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  onClick={() => onPageChange?.(curPage + 1)}
                  disabled={!canNext}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  onClick={() => onPageChange?.(pageCount)}
                  disabled={!canNext}
                  aria-label="Last page"
                >
                  <ChevronsRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default DataTable;
