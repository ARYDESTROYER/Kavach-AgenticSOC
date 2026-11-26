/**
 * SavedViewsBar — switch between, save, and manage saved list views (Wave 7).
 *
 * Used on a list surface (e.g. Cases). It surfaces the user's PERSONAL views plus
 * the ORG-shared views (the cascade marks the latter `shared`), lets the user save
 * the CURRENT filter/sort/columns as a named view, switch the active view (applying
 * its stored config back onto the page), clone an org/shared view into the personal
 * set, and delete a personal one.
 *
 * The bar is intentionally thin: the PAGE owns the filter/sort state. The bar reads
 * a view's stored config via `applyView` and calls the page's `onApply(view)`; it
 * captures the current config to save via the page's `getCurrent()`.
 *
 * SECURITY (#9): a saved-view name + filter values are user DATA → rendered as plain
 * text only.
 */
import * as React from 'react';
import { Bookmark, BookmarkPlus, ChevronDown, Copy, Trash2, Users, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SavedView } from '@/lib/types';
import { usePrefs } from '@/soc/prefs';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/ui/dropdown-menu';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/ui/popover';
import { toast } from 'sonner';

export interface SavedViewsBarProps {
  /** The surface these views belong to (e.g. 'cases'). Filters the list. */
  scope: string;
  /** The active view id (controlled by the page), or null when none applied. */
  activeViewId: string | null;
  /** Apply a view's stored config back onto the page. null clears to defaults. */
  onApply: (view: SavedView | null) => void;
  /** Capture the page's CURRENT config to persist when saving a new view. */
  getCurrent: () => { filters: Record<string, unknown>; sort: string; columns?: string[] | null };
  className?: string;
}

export const SavedViewsBar: React.FC<SavedViewsBarProps> = ({
  scope,
  activeViewId,
  onApply,
  getCurrent,
  className,
}) => {
  const { savedViews, saveView, cloneView, deleteView, applyView } = usePrefs();
  const views = React.useMemo(
    () => savedViews.filter((v) => (v.scope || 'cases') === scope),
    [savedViews, scope],
  );

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const active = activeViewId ? views.find((v) => v.id === activeViewId) ?? null : null;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const cur = getCurrent();
    const created = await saveView(trimmed, {
      scope,
      filters: cur.filters,
      sort: cur.sort,
      columns: cur.columns ?? null,
    });
    setBusy(false);
    if (created) {
      setName('');
      setSaveOpen(false);
      toast.success(`Saved view “${created.name}”`);
      onApply(created);
    } else {
      toast.error('Could not save view');
    }
  };

  const handleClone = async (v: SavedView) => {
    const created = await cloneView(v.id);
    if (created) {
      toast.success(`Cloned “${v.name}” to your views`);
      onApply(created);
    } else {
      toast.error('Could not clone view');
    }
  };

  const handleDelete = async (v: SavedView) => {
    const ok = await deleteView(v.id);
    if (ok) {
      toast.success(`Deleted “${v.name}”`);
      if (activeViewId === v.id) onApply(null);
    } else {
      toast.error('Could not delete view');
    }
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* View switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Saved views">
            <Bookmark className="mr-1.5 size-4" aria-hidden />
            <span className="max-w-[12rem] truncate">{active ? active.name : 'All cases'}</span>
            <ChevronDown className="ml-1.5 size-4 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Views</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onApply(null)}>
            <span className="flex-1">All cases (default)</span>
            {!active ? <Check className="size-4" aria-hidden /> : null}
          </DropdownMenuItem>
          {views.length ? <DropdownMenuSeparator /> : null}
          {views.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={() => onApply(applyView(v.id) ?? v)}
              className="gap-2"
            >
              <span className="flex-1 truncate">{v.name}</span>
              {v.shared ? (
                <Users className="size-3.5 text-muted-foreground" aria-label="Shared" />
              ) : null}
              {activeViewId === v.id ? <Check className="size-4" aria-hidden /> : null}
            </DropdownMenuItem>
          ))}
          {views.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Manage
              </DropdownMenuLabel>
              {/* Clone/Delete are real DropdownMenuItems (not raw <button>s) so they
                  join Radix's arrow-key roving focus — a keyboard user reaches them the
                  same way as the switch items above. onSelect preventDefault keeps the
                  menu open after the action. */}
              {views.map((v) => (
                <React.Fragment key={`mng-${v.id}`}>
                  <DropdownMenuItem
                    className="gap-2"
                    aria-label={`Clone ${v.name}`}
                    onSelect={(e) => {
                      e.preventDefault();
                      void handleClone(v);
                    }}
                  >
                    <Copy className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">Clone “{v.name}”</span>
                  </DropdownMenuItem>
                  {!v.shared ? (
                    <DropdownMenuItem
                      className="gap-2 text-critical focus:text-critical"
                      aria-label={`Delete ${v.name}`}
                      onSelect={(e) => {
                        e.preventDefault();
                        void handleDelete(v);
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      <span className="flex-1 truncate">Delete “{v.name}”</span>
                    </DropdownMenuItem>
                  ) : null}
                </React.Fragment>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save current as a view */}
      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <BookmarkPlus className="mr-1.5 size-4" aria-hidden />
            Save view
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Save view" className="w-64" align="start">
          <div className="space-y-2">
            <label htmlFor="saved-view-name" className="block text-xs font-medium text-muted-foreground">
              Name this view
            </label>
            <Input
              id="saved-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave();
              }}
              placeholder="e.g. My open criticals"
              aria-label="View name"
              /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Saves the current filters, sort and columns.
            </p>
            <Button size="sm" className="w-full" disabled={!name.trim() || busy} onClick={() => void handleSave()}>
              Save view
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default SavedViewsBar;
