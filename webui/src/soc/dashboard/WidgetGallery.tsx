/**
 * `WidgetGallery`: the "Add widget" curated gallery (Round 5 / G7, CD4 step 3).
 *
 * A Radix `Sheet` listing the widget registry as a browsable, category-filtered,
 * RBAC-filtered set of cards (icon + one-line description). Adding a widget is a
 * CURATED gallery pick, never a blank canvas (the single most important MVP rule from
 * RESEARCH_CUSTOM_DASHBOARDS §5.6). Selecting a card appends a fresh widget instance
 * (registry `defaultSize`, RGL auto-packs it) and closes the sheet.
 *
 * SECURITY: registry descriptions/titles are CODE-defined (trusted); a widget the user
 * lacks the `requires` grant for is hidden here AND dropped by reconcile-on-load AND
 * rejected by the server allowlist on PUT (defense-in-depth, #9). A layout is advisory
 * (#3).
 */
import * as React from 'react';
import { LayoutGrid } from 'lucide-react';

import { cn } from '@/lib/cn';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/ui/sheet';
import { Button } from '@/ui/button';

import type { DashboardWidget } from '@/lib/types';
import {
  WIDGET_TYPES,
  getWidgetDef,
  canUseWidget,
  ALLOW_ALL,
  type PermissionCheck,
  type WidgetDef,
  type WidgetType,
} from './registry';
import { freshId } from './layout-utils';
import type { EditArrangement } from './WidgetGrid';

/** The gallery category filter chips (in display order). */
const CATEGORIES: { id: WidgetDef['category'] | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'kpi', label: 'KPIs' },
  { id: 'chart', label: 'Charts' },
  { id: 'table', label: 'Tables' },
  { id: 'coverage', label: 'Coverage' },
];

export interface WidgetGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Permission check (defaults permit-all so no-auth/tests are transparent). */
  can?: PermissionCheck;
  /** Called with a fresh widget instance when a gallery entry is picked. */
  onAdd: (widget: DashboardWidget) => void;
  /**
   * As the gallery closes, before the focus returns to its opener: `preventDefault()` and
   * focus another control (the builder's one-column list hands it to the new widget).
   */
  onCloseAutoFocus?: (event: Event) => void;
  /**
   * How the board is being edited: the 12-column grid (drag and resize) or, on a narrow
   * board, the one-column list (a new widget goes last and moves with Move up and Move
   * down). The description says which. Default the grid.
   */
  arrangement?: EditArrangement;
}

/** Build a fresh widget instance for a picked type (registry default size + geometry). */
export function makeWidget(type: WidgetType): DashboardWidget {
  const def = getWidgetDef(type)!;
  return {
    i: freshId('w-'),
    type,
    x: 0,
    y: 0,
    w: def.defaultSize.w,
    h: def.defaultSize.h,
    minW: def.defaultSize.minW,
    minH: def.defaultSize.minH,
    static: false,
    options: {},
    // The persisted/backend widget shape keys on `i` (RGL) + `options`; the FE type
    // scaffold declares `id`/`config`. Cast through `unknown` to the loose type: the
    // builder + layout-utils read either key (see `widgetId`/`widgetOptions`).
  } as unknown as DashboardWidget;
}

export function WidgetGallery({
  open,
  onOpenChange,
  can = ALLOW_ALL,
  onAdd,
  onCloseAutoFocus,
  arrangement = 'grid',
}: WidgetGalleryProps) {
  const [category, setCategory] = React.useState<WidgetDef['category'] | 'all'>('all');

  // RBAC-filtered, category-filtered registry entries (stable registry order).
  const entries = React.useMemo<WidgetDef[]>(() => {
    return WIDGET_TYPES.map((t) => getWidgetDef(t))
      .filter((d): d is WidgetDef => Boolean(d))
      .filter((d) => canUseWidget(d, can))
      .filter((d) => category === 'all' || d.category === category);
  }, [can, category]);

  const add = (def: WidgetDef) => {
    onAdd(makeWidget(def.type));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col"
        aria-label="Add a widget"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-primary" aria-hidden />
            Add a widget
          </SheetTitle>
          <SheetDescription>
            {arrangement === 'list'
              ? 'Pick a widget to add to this dashboard. It goes at the end; move it with Move up and Move down.'
              : 'Pick a widget to add to this dashboard. Drag or resize it after it lands.'}
          </SheetDescription>
        </SheetHeader>

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5 px-6" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={category === c.id}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                category === c.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* The gallery grid */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Available widgets">
            {entries.map((def) => {
              const Icon = def.icon;
              return (
                <li key={def.type}>
                  <div className="flex h-full flex-col gap-2 rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start gap-2.5">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
                        <Icon className="h-4 w-4 text-primary" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        {/* Registry title/description are CODE-defined (trusted) plain text. */}
                        <p className="truncate text-sm font-semibold text-foreground">{def.title}</p>
                        <p className="text-xs text-muted-foreground">{def.description}</p>
                      </div>
                    </div>
                    <div className="mt-auto flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => add(def)}
                        aria-label={`Add ${def.title}`}
                      >
                        Add
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No widgets available in this category.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default WidgetGallery;
