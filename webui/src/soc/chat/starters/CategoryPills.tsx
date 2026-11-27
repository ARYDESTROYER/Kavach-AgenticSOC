/**
 * CategoryPills — the start screen's last row (SPEC-chat §5.2): Investigate, Hunt,
 * Posture, Report, Learn the app and All prompts. Each pill opens the composer's prompt
 * library filtered to its library categories (`openPromptLibrary({categories})`); All
 * prompts opens it unfiltered. A pill whose categories hold no prompt this viewer may
 * run is hidden; while the tool catalogue is unavailable every pill shows (the library
 * gates its own prompts). Ghost pills, 28 px tall; one row that wraps on a wide lane and
 * scrolls sideways under a right-edge fade below 560 px. There, a pill that takes focus
 * is scrolled clear of the fade with its whole focus ring (scroll margins of the ring's
 * 4 px on the left and the 24 px fade plus the ring on the right), so the focused pill
 * is never half hidden.
 *
 * The caller's `className` (its margin from the cards) goes on an outer box, never on the
 * pill row itself: the narrow row's 4 px of ring room is padding pulled back by negative
 * margins, and a caller's `mt-3` merged onto it replaced the top one (closing re-shoot: the
 * last card sat 16 px above the pills on a phone, 12 px at desktop). In a block flow the
 * outer box's margin and the row's negative one collapse, so the gap to a pill is the
 * caller's margin at every width.
 */
import { BookOpen, Crosshair, FileText, Gauge, Library, ScanSearch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ChatContextInfo, ChatPromptCategory } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { openPromptLibrary } from '../composer/library-events';
import { visibleStarters } from '../composer/prompt-library';

export interface CategoryPill {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Library categories; empty: the whole library ("All prompts"). */
  categories: readonly ChatPromptCategory[];
}

/** §5.2, in order. */
export const CATEGORY_PILLS: readonly CategoryPill[] = [
  { id: 'investigate', label: 'Investigate', icon: ScanSearch, categories: ['triage'] },
  { id: 'hunt', label: 'Hunt', icon: Crosshair, categories: ['hunt', 'ioc'] },
  { id: 'posture', label: 'Posture', icon: Gauge, categories: ['posture'] },
  { id: 'report', label: 'Report', icon: FileText, categories: ['reporting'] },
  { id: 'learn', label: 'Learn the app', icon: BookOpen, categories: ['app_help'] },
  { id: 'all', label: 'All prompts', icon: Library, categories: [] },
];

/**
 * The pills this viewer gets: All prompts always; a category pill only when the library
 * has at least one prompt in its categories whose tools are all allowed. Without a
 * catalogue (`context` null) every pill shows.
 */
export function visiblePills(context: ChatContextInfo | null): CategoryPill[] {
  if (!context) return [...CATEGORY_PILLS];
  const allowed = visibleStarters(context);
  return CATEGORY_PILLS.filter(
    (pill) => !pill.categories.length || allowed.some((prompt) => !!prompt.category && pill.categories.includes(prompt.category)),
  );
}

export interface CategoryPillsProps {
  context: ChatContextInfo | null;
  /** The lane is under 560 px: one sideways-scrolling row instead of wrapping. */
  narrow?: boolean;
  className?: string;
}

export function CategoryPills({ context, narrow = false, className }: CategoryPillsProps) {
  const pills = visiblePills(context);
  return (
    <div className={className}>
      <div
        role="group"
        aria-label="Prompt library categories"
        data-testid="category-pills"
        className={cn(
          'flex gap-1.5',
          narrow
            ? // The 4 px padding (pulled back by the negative margins) keeps a pill's focus
              // ring inside the scroll box's clip without moving the pills off the lane edge.
              '-mx-1 -my-1 flex-nowrap overflow-x-auto overscroll-x-contain py-1 pl-1 pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none]'
            : 'flex-wrap',
        )}
      >
        {pills.map((pill) => {
          const Icon = pill.icon;
          return (
            <button
              key={pill.id}
              type="button"
              data-pill={pill.id}
              onClick={() => openPromptLibrary(pill.categories.length ? { categories: pill.categories } : {})}
              onFocus={
                narrow
                  ? (event) => {
                      // Honours the scroll margins below; a browser's own focus scroll may
                      // leave a partly clipped pill where it is.
                      const pillEl = event.currentTarget;
                      if (typeof pillEl.scrollIntoView === 'function') pillEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }
                  : undefined
              }
              className={cn(
                'inline-flex h-7 min-w-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-xs text-muted-foreground transition-colors',
                'hover:bg-hover hover:text-foreground',
                narrow && 'scroll-ml-1 scroll-mr-7',
                focusRing,
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {pill.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
