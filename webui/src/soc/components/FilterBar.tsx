/**
 * FilterBar: the ONE filter layout for a list (Round 14, SPEC §4.9.2; ui-standard
 * "Tables, filters and lists").
 *
 * Anatomy, left to right on one wrapping row:
 *   [search] [up to three primary filters] [More filters (n)] ......... [meta] [end]
 * and, while any filter is set, a second row of removable chips with "Clear all".
 * Below 768px the row is the search and one "Filters (n)" button that opens a bottom
 * sheet holding every filter with its visible label; the chips stay under it.
 *
 * Slots:
 *  - `search`: the free-text search (`label` is its accessible name; the placeholder
 *                shortens below 768px to `compactPlaceholder`, default the label).
 *  - `filters`: the filter controls, in priority order. The first `primaryCount` (at
 *                most three) sit in the bar; the rest move behind "More filters". Each
 *                has a visible `label` (shown in the menu and the phone sheet; the
 *                control's own accessible name should contain it) and `active` when it
 *                holds a non-default value (counted on "More filters" and "Filters").
 *  - `chips`: the active filters as removable chips; `onClearAll` adds "Clear all".
 *  - `meta`: a muted trailing note (a result count); `end`: trailing controls
 *                (Columns, Refresh). `children`: any other control, after the filters.
 *
 * Surface: `variant="plain"` (default) has no rules of its own; it sits on a panel, on
 * the panel inset above the table it filters (C7: panels everywhere). `variant="band"`
 * draws the pre-Round-14 hairline band on the canvas, for a page that has not moved to
 * panels yet. `sticky` pins the bar under the top bar on the one material.
 *
 * a11y: a labelled `group` (not a `toolbar`: the controls are ordinary tab stops, and
 * a toolbar would promise a roving-focus arrow-key model this bar does not have). Each
 * chip is a button named "Remove filter: <label>". Focus is never dropped on the page
 * body: once a removed chip or "Clear all" leaves the page, focus moves to the next chip,
 * else the previous one, else the search, else the bar's first control ("More filters",
 * "Filters" or the first filter), else the bar itself. "Clear all" in the phone sheet
 * keeps focus inside the sheet, on "Done". The "More filters" popover is a dialog named
 * "More filters".
 */
import * as React from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/ui/sheet';
import { useIsMobile } from '@/soc/hooks/useMediaQuery';

/** The controls that can take focus in the bar's first row (the focus hand-off falls back to the first). */
const BAR_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The most filters the bar shows inline; the rest go behind "More filters". */
export const FILTER_BAR_MAX_PRIMARY = 3;

export interface FilterBarSearch {
  /** Current search text (controlled). */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the search field ("Search cases"). */
  label: string;
  /** Placeholder from 768px ("Search by ID, title, entity, rule or tag"). Defaults to `label`. */
  placeholder?: string;
  /** Placeholder below 768px ("Search cases"). Defaults to `label`. */
  compactPlaceholder?: string;
}

/** Where a filter control is drawn: in the bar (compact, fixed width) or in a menu or sheet (full width). */
export interface FilterBarControlContext {
  placement: 'bar' | 'menu';
}

export interface FilterBarFilter {
  /** Stable id. */
  id: string;
  /** Visible label in "More filters" and the phone sheet ("Status"). Plain text. */
  label: string;
  /** The control: a node, or a function of where it is drawn. */
  control: React.ReactNode | ((context: FilterBarControlContext) => React.ReactNode);
  /** The filter holds a non-default value (counted on "More filters" and "Filters"). */
  active?: boolean;
}

export interface FilterChip {
  /** Stable id. */
  id: string;
  /** What the chip says ("Severity: High"). Plain text, never markup. */
  label: string;
  /** Clear this filter. */
  onRemove: () => void;
}

export interface FilterBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Accessible name for the group (e.g. "Case filters"). */
  'aria-label'?: string;
  /** The free-text search. */
  search?: FilterBarSearch;
  /** The filters, in priority order; see the module comment. */
  filters?: FilterBarFilter[];
  /** How many filters sit in the bar (at most three; default three). */
  primaryCount?: number;
  /** The active filters as removable chips. */
  chips?: FilterChip[];
  /** Clear every filter (shown as "Clear all" while any filter is active). */
  onClearAll?: () => void;
  /** How many filters are active, when not every one has a chip (defaults to the chips, else the active filters). */
  activeCount?: number;
  /** Right-aligned controls (Columns, Refresh). */
  end?: React.ReactNode;
  /** Muted trailing note (a result count). */
  meta?: React.ReactNode;
  /** `plain` (default): no rules, on a panel. `band`: the hairline band on the canvas. */
  variant?: 'plain' | 'band';
  /** Pin the bar under the page header on scroll. */
  sticky?: boolean;
  /** Any other controls, after the filters. */
  children?: React.ReactNode;
}

function renderControl(filter: FilterBarFilter, placement: FilterBarControlContext['placement']) {
  return typeof filter.control === 'function' ? filter.control({ placement }) : filter.control;
}

/** One labelled filter in a menu or the phone sheet: a group named by its visible label. */
function MenuFilter({ filter }: { filter: FilterBarFilter }) {
  const labelId = `${React.useId()}-label`;
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-1.5" data-filter-id={filter.id}>
      <p id={labelId} className="text-xs font-medium text-muted-foreground">
        {filter.label}
      </p>
      {renderControl(filter, 'menu')}
    </div>
  );
}

/** The small count beside "More filters" and "Filters", with its meaning for screen readers. */
function ActiveCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-sm bg-accent px-1.5 text-xs font-medium tabular-nums text-accent-foreground">
      {count.toLocaleString()}
      <span className="sr-only"> active</span>
    </span>
  );
}

export const FilterBar = React.forwardRef<HTMLDivElement, FilterBarProps>(
  (
    {
      search,
      filters,
      primaryCount = FILTER_BAR_MAX_PRIMARY,
      chips,
      onClearAll,
      activeCount: activeCountProp,
      end,
      meta,
      variant = 'plain',
      sticky,
      className,
      children,
      ...rest
    },
    ref,
  ) => {
    // Sticky = floating chrome: the ONE Console material. Its hard rules give way to the
    // scroll-edge fade, shown only while content is scrolled under the pinned bar; a
    // real bottom rule returns under increased contrast (the material's own fallback).
    const edgeRef = useScrollEdgeRef(ref, Boolean(sticky));
    const compact = useIsMobile();
    const [sheetOpen, setSheetOpen] = React.useState(false);

    const all = filters ?? [];
    const inlineCount = Math.max(0, Math.min(FILTER_BAR_MAX_PRIMARY, primaryCount));
    const primary = all.slice(0, inlineCount);
    const more = all.slice(inlineCount);
    const moreActive = more.filter((f) => f.active).length;
    const chipList = chips ?? [];
    const activeCount = activeCountProp ?? (chipList.length || all.filter((f) => f.active).length);

    // Focus never drops onto the page body when a chip, every chip or "Clear all" goes
    // away. The control that was used is remembered with where focus should go; after
    // each commit, once that control has left the page and focus fell to the body, focus
    // moves on. While it is still there (the page has not applied the change yet) the
    // hand-off waits; if focus moved on by itself, the hand-off is dropped.
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const setRootRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        edgeRef(node);
      },
      [edgeRef],
    );
    const rowRef = React.useRef<HTMLDivElement>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const doneRef = React.useRef<HTMLButtonElement>(null);
    const chipRefs = React.useRef(new Map<string, HTMLButtonElement>());
    const pendingFocus = React.useRef<{ target: number | 'bar' | 'sheet'; origin: HTMLElement | null } | null>(null);
    React.useLayoutEffect(() => {
      const pending = pendingFocus.current;
      if (!pending) return;
      const active = document.activeElement;
      if (pending.origin?.isConnected) {
        if (active !== pending.origin) pendingFocus.current = null;
        return;
      }
      pendingFocus.current = null;
      if (active && active !== document.body) return;
      const tryFocus = (el: HTMLElement | null | undefined) => {
        if (!el || !el.isConnected) return false;
        el.focus();
        return document.activeElement === el;
      };
      if (typeof pending.target === 'number' && chipList.length > 0) {
        const chip = chipList[Math.min(pending.target, chipList.length - 1)];
        if (tryFocus(chip ? chipRefs.current.get(chip.id) : undefined)) return;
      }
      if (pending.target === 'sheet' && tryFocus(doneRef.current)) return;
      if (tryFocus(searchRef.current)) return;
      if (tryFocus(rowRef.current?.querySelector<HTMLElement>(BAR_FOCUSABLE))) return;
      tryFocus(rootRef.current);
    });

    const removeChip = (index: number, origin: HTMLElement) => {
      pendingFocus.current = { target: index, origin };
      chipList[index]?.onRemove();
    };
    const clearAll = (origin: HTMLElement, inSheet: boolean) => {
      pendingFocus.current = { target: inSheet ? 'sheet' : 'bar', origin };
      onClearAll?.();
    };

    const searchField = search ? (
      <div className="relative min-w-[12rem] max-w-md flex-1" data-filter-search="">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          type="search"
          value={search.value}
          onChange={(event) => search.onChange(event.target.value)}
          placeholder={compact ? search.compactPlaceholder ?? search.label : search.placeholder ?? search.label}
          aria-label={search.label}
          className="h-8 pl-9"
        />
      </div>
    ) : null;

    const showClearAll = Boolean(onClearAll) && (chipList.length > 0 || activeCount > 0);

    return (
      <div
        ref={setRootRef}
        role="group"
        // Focusable only as the last place a focus hand-off can land (never a tab stop).
        tabIndex={-1}
        aria-label={rest['aria-label'] ?? 'Filters'}
        data-filter-bar={variant}
        className={cn(
          '@container flex flex-col gap-2 bg-transparent',
          variant === 'band' ? 'border-y border-border/80 py-2' : 'py-0',
          sticky && cn('sticky top-[var(--header-h)] z-20 border-y-0 py-2', materialBar),
          className,
        )}
        {...rest}
      >
        <div ref={rowRef} className="flex flex-wrap items-center gap-2" data-filter-row="">
          {searchField}

          {compact ? (
            all.length > 0 ? (
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                {/* The trigger names the sheet it opens (aria-haspopup, aria-expanded and
                    aria-controls come from the Radix trigger). */}
                <SheetTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5">
                    <SlidersHorizontal aria-hidden />
                    Filters
                    <ActiveCount count={activeCount} />
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" size="lg" className="gap-0 p-0">
                  <SheetHeader className="px-4 py-4 pr-14">
                    <SheetTitle className="text-md">Filters</SheetTitle>
                    <SheetDescription className="sr-only">
                      Choose what the list shows. Changes apply as you make them.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {all.map((filter) => (
                      <MenuFilter key={filter.id} filter={filter} />
                    ))}
                  </div>
                  <SheetFooter className="flex-row justify-end gap-2 px-4 py-3">
                    {showClearAll ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => clearAll(event.currentTarget, true)}
                      >
                        Clear all
                      </Button>
                    ) : null}
                    <SheetClose asChild>
                      <Button ref={doneRef} type="button" size="sm">
                        Done
                      </Button>
                    </SheetClose>
                  </SheetFooter>
                </SheetContent>
              </Sheet>
            ) : null
          ) : (
            <>
              {primary.map((filter) => (
                <React.Fragment key={filter.id}>{renderControl(filter, 'bar')}</React.Fragment>
              ))}
              {more.length > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5">
                      <SlidersHorizontal aria-hidden />
                      More filters
                      <ActiveCount count={moreActive} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent aria-label="More filters" align="start" className="w-72 space-y-3">
                    {more.map((filter) => (
                      <MenuFilter key={filter.id} filter={filter} />
                    ))}
                  </PopoverContent>
                </Popover>
              ) : null}
            </>
          )}

          {children}

          {end || meta ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {meta ? <span className="text-xs tabular-nums text-muted-foreground">{meta}</span> : null}
              {end}
            </div>
          ) : null}
        </div>

        {chipList.length > 0 || (showClearAll && !compact) ? (
          <div className="flex flex-wrap items-center gap-2" data-filter-chips="">
            {chipList.length > 0 ? (
              <ul className="flex flex-wrap items-center gap-2" aria-label="Active filters">
                {chipList.map((chip, index) => (
                  <li key={chip.id}>
                    <button
                      ref={(el) => {
                        if (el) chipRefs.current.set(chip.id, el);
                        else chipRefs.current.delete(chip.id);
                      }}
                      type="button"
                      onClick={(event) => removeChip(index, event.currentTarget)}
                      aria-label={`Remove filter: ${chip.label}`}
                      className={cn(
                        'inline-flex h-7 max-w-[20rem] items-center gap-1 rounded-sm border border-border bg-muted px-2 text-xs text-foreground transition-colors',
                        'hover:border-border-strong hover:bg-hover',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      )}
                    >
                      <span className="truncate">{chip.label}</span>
                      <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {showClearAll ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={(event) => clearAll(event.currentTarget, false)}
              >
                Clear all
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
);
FilterBar.displayName = 'FilterBar';

/**
 * FilterBarGroup: an optional labelled cluster inside the bar (e.g. group the
 * three variable dropdowns). The label is a small muted caption for scanability;
 * it is `aria-hidden` since each control already carries its own name.
 */
export function FilterBarGroup({
  label,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { label?: React.ReactNode }) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} {...rest}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground" aria-hidden="true">
          {label}
        </span>
      ) : null}
      {children}
    </div>
  );
}
FilterBarGroup.displayName = 'FilterBarGroup';
