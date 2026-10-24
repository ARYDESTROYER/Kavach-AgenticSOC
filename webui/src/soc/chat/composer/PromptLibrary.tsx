/**
 * PromptLibrary — the prompt library dialog (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8;
 * replaces "Manage saved prompts"; Round 13 SPEC-chat T30, T35, §5.2).
 *
 * One searchable list in two clearly separated groups:
 *
 *   - **Your prompts**: the analyst's saved prompts and promptbooks, favourites first. A
 *     star toggles the favourite; ⋯ edits or deletes (delete asks first, inline).
 *   - **Starter prompts**: read-only templates shipped with the console, per category,
 *     shown only when every tool they need is allowed. Their ⋯ holds "Save a copy",
 *     which makes an editable prompt of one.
 *
 * Filter chips (All, Favourites and the six categories) and a search field narrow both
 * groups. The row itself is **Use** (Run for a promptbook): it hands the prompt to the
 * composer, which asks for its `{placeholders}` first (or runs a promptbook step by
 * step); a prompt with nothing to ask goes straight into the composer, never sent on
 * selection. Each row names its category and the values it asks for; a promptbook row
 * reads "{k} steps" and expands to show every step. The list fades at its bottom edge
 * while more rows are below.
 *
 * Round 13: `categories` opens the library filtered to a start-screen pill's library
 * categories (Hunt covers Hunt and IOC); any chip returns to the usual filters.
 *
 * Prompt text is the analyst's own words or the console's starter copy: it renders as
 * text only.
 *
 * Focus never falls out of the dialog: the favorite star and the inline Delete stay
 * focusable while a save runs (`aria-disabled`), the star keeps focus when its row moves
 * (favorites sort first), "Delete…" focuses Keep, Keep returns to the row's ⋯, and a
 * delete moves on to the next row's Use (or the search field when none is left).
 */
import * as React from 'react';
import { BookCopy, ChevronDown, ListOrdered, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react';

import type { ChatContextInfo, ChatPrompt, ChatPromptCategory } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { useAnnouncer } from '@/soc/components/announcer';
import { SAVED_PROMPT_LIMITS } from '../chat-api';
import {
  CATEGORY_LABEL,
  PROMPT_CATEGORIES,
  filterPrompts,
  isPromptbook,
  orderPrompts,
  paramLabel,
  planPrompt,
  visibleStarters,
  type LibraryFilter,
  type LibraryPrompt,
} from './prompt-library';
import type { PromptDraft, SavedPromptsController } from './SavedPrompts';

export interface PromptLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: SavedPromptsController;
  /** The tool catalogue: starters are listed only when their tools are allowed. */
  context: ChatContextInfo | null;
  /** `/chat/context` failed and nothing is cached: starters cannot be listed. */
  contextError?: string | null;
  /** Use a prompt (the composer asks for its values, or inserts it). */
  onUse: (prompt: LibraryPrompt) => void;
  /** Open the Save dialog: a new prompt, a copy of a starter, or an edit. */
  onCompose: (draft: PromptDraft) => void;
  onCloseFocus?: () => void;
  /**
   * Round 13 (SPEC-chat §5.2): open filtered to these library categories (a start-screen
   * category pill). Absent or empty: the library opens as usual.
   */
  categories?: readonly ChatPromptCategory[];
}

/** T30: one line that says what the library is for. */
export const LIBRARY_DESCRIPTION = 'Saved prompts and ready-made questions. Pick one to fill the composer.';

const FILTERS: ReadonlyArray<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  // T35: the console writes UK English ("summarised", "centred").
  { id: 'favorites', label: 'Favourites' },
  ...PROMPT_CATEGORIES.map((c) => ({ id: c.id as LibraryFilter, label: c.label })),
];

/** The list's bottom fade while more rows are below (T30). */
const LIST_FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]';

const ROW_BUTTON = cn(
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
  focusRing,
);

function PromptMeta({ prompt, id }: { prompt: LibraryPrompt; id?: string }) {
  const plan = planPrompt(prompt);
  // A promptbook's step count is its expander ("3 steps", T30), not repeated here.
  const kind = plan.book ? 'Promptbook' : null;
  const parts: string[] = [];
  if (prompt.category) parts.push(CATEGORY_LABEL[prompt.category]);
  if (kind) parts.push(kind);
  if (plan.params.length) parts.push(`Asks for ${plan.params.map(paramLabel).join(', ')}`);
  if (!parts.length) return null;
  return (
    <span id={id} className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground" data-testid="prompt-meta">
      {kind ? <ListOrdered className="size-3" aria-hidden /> : null}
      <span>{parts.join(' · ')}</span>
    </span>
  );
}

/** "Run <title>" for a promptbook, "Use <title>" otherwise: the name starts with the visible label. */
export function promptActionLabel(prompt: LibraryPrompt): string {
  return `${isPromptbook(prompt) ? 'Run' : 'Use'} ${prompt.title}`;
}

/** Where focus goes once the list has re-rendered after a write. */
type PendingFocus =
  | { kind: 'more' | 'keep'; id: string }
  /** `fallback`: the neighbouring row, for when the row leaves the list (the Favorites filter). */
  | { kind: 'star'; id: string; fallback: string | null }
  | { kind: 'use'; id: string | null };

/** An ordinary prompt's text, two lines (the whole text goes into the composer on Use). */
function PromptPreview({ prompt, id }: { prompt: LibraryPrompt; id?: string }) {
  if (isPromptbook(prompt)) return null;
  return (
    <span id={id} className="mt-1 line-clamp-2 block whitespace-pre-line break-words text-xs text-muted-foreground">
      {prompt.text}
    </span>
  );
}

/** Whether a row has a meta line (category, "Promptbook", "Asks for ..."). */
function hasPromptMeta(prompt: LibraryPrompt): boolean {
  const plan = planPrompt(prompt);
  return !!prompt.category || plan.book || plan.params.length > 0;
}

/** T30: a promptbook row reads "{k} steps" and expands to show every step, never cut. */
function PromptbookSteps({ prompt }: { prompt: LibraryPrompt }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const steps = planPrompt(prompt).steps;
  if (!isPromptbook(prompt) || !steps.length) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
          focusRing,
        )}
        data-row-steps=""
      >
        <ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
        {steps.length} {steps.length === 1 ? 'step' : 'steps'}
      </button>
      {open ? (
        <ol id={listId} className="ml-6 mt-1 list-decimal space-y-1 text-xs text-muted-foreground">
          {steps.map((step, index) => (
            <li key={index} className="whitespace-pre-line break-words pl-1">
              {step}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** The row's main area IS Use (Run for a promptbook): title, meta and a short preview. */
/**
 * The row itself is Use (T30). Its accessible name is "Use {title}" ("Run" for a
 * promptbook): the visible title with a visually hidden verb, so the name starts with
 * what is shown. The meta line ("Asks for User", the category) and the text preview
 * stay readable as its description: a button's children are presentational, so they
 * are referenced, not left to the name.
 */
function RowUse({ prompt, onUse }: { prompt: LibraryPrompt; onUse: (prompt: LibraryPrompt) => void }) {
  const baseId = React.useId();
  const verbId = `${baseId}-verb`;
  const titleId = `${baseId}-title`;
  const metaId = `${baseId}-meta`;
  const previewId = `${baseId}-preview`;
  const describedBy = [hasPromptMeta(prompt) ? metaId : null, isPromptbook(prompt) ? null : previewId].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      aria-labelledby={`${verbId} ${titleId}`}
      aria-describedby={describedBy || undefined}
      data-row-use=""
      onClick={() => onUse(prompt)}
      className={cn('-mx-1 -my-0.5 block w-[calc(100%+0.5rem)] rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-hover', focusRing)}
    >
      <span id={verbId} className="sr-only">
        {isPromptbook(prompt) ? 'Run' : 'Use'}
      </span>
      <span id={titleId} className="block break-words text-sm font-medium text-foreground" data-row-title="">
        {prompt.title}
      </span>
      <PromptMeta prompt={prompt} id={metaId} />
      <PromptPreview prompt={prompt} id={previewId} />
    </button>
  );
}

export function PromptLibraryDialog({
  open,
  onOpenChange,
  controller,
  context,
  contextError = null,
  onUse,
  onCompose,
  onCloseFocus,
  categories,
}: PromptLibraryDialogProps) {
  const announce = useAnnouncer();
  const [query, setQuery] = React.useState('');
  const [filter, setFilterState] = React.useState<LibraryFilter>('all');
  /** A start-screen pill's categories, until a chip is chosen (Round 13). */
  const [pill, setPill] = React.useState<ChatPromptCategory[] | null>(null);
  const setFilter = (next: LibraryFilter) => {
    setPill(null);
    setFilterState(next);
  };
  const categoriesKey = (categories ?? []).join(',');
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const searchId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const pendingFocus = React.useRef<PendingFocus | null>(null);
  const { load, clearError } = controller;

  React.useEffect(() => {
    if (open) {
      // Start clean: an earlier action's failure belongs to that action.
      clearError();
      load();
    } else {
      setConfirming(null);
    }
  }, [open, load, clearError]);

  // Opened from a start-screen pill: filtered to its categories, a fresh search.
  React.useEffect(() => {
    if (!open) return;
    const wanted = categoriesKey ? (categoriesKey.split(',') as ChatPromptCategory[]) : [];
    if (wanted.length) {
      setPill(wanted);
      setFilterState('all');
      setQuery('');
    } else {
      setPill(null);
    }
  }, [open, categoriesKey]);

  /** Focus one control of a row (rows move and re-render, so look them up by id). */
  const focusRowControl = React.useCallback((id: string, selector: string): boolean => {
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-prompt-id]') ?? []).find(
      (el) => el.dataset.promptId === id,
    );
    const target = row?.querySelector<HTMLElement>(selector);
    if (!target) return false;
    target.focus();
    return true;
  }, []);

  // Apply a pending focus once the list reflects the write (and the save has finished).
  React.useLayoutEffect(() => {
    const next = pendingFocus.current;
    if (!next || controller.saving) return;
    if (next.kind === 'keep') {
      // Kept until the menu's own close-focus runs too (it would return to the gone ⋯).
      if (confirming === next.id) focusRowControl(next.id, '[data-confirm="keep"]');
      return;
    }
    pendingFocus.current = null;
    if (next.kind === 'star') {
      // An un-starred row leaves the Favorites list: on to its neighbour, else to search.
      if (focusRowControl(next.id, 'button[aria-pressed]')) return;
      const moved =
        next.fallback !== null &&
        (focusRowControl(next.fallback, 'button[aria-pressed]') || focusRowControl(next.fallback, '[data-row-use]'));
      if (!moved) searchRef.current?.focus();
    } else if (next.kind === 'more') focusRowControl(next.id, '[data-row-more]');
    else if (!next.id || !focusRowControl(next.id, '[data-row-use]')) searchRef.current?.focus();
  }, [controller.prompts, controller.saving, confirming, focusRowControl]);

  const own = React.useMemo(
    () => filterPrompts(orderPrompts(controller.prompts), pill ?? filter, query),
    [controller.prompts, filter, pill, query],
  );
  const starters = React.useMemo(
    () => (!pill && filter === 'favorites' ? [] : filterPrompts(visibleStarters(context), pill ?? filter, query)),
    [context, filter, pill, query],
  );
  const searching = query.trim() !== '' || filter !== 'all' || !!pill;

  // T30: the list fades at its bottom edge only while more rows are below.
  const [moreBelow, setMoreBelow] = React.useState(false);
  const measureList = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setMoreBelow(list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }, []);
  React.useLayoutEffect(() => {
    if (open) measureList();
  });

  const use = (prompt: LibraryPrompt) => {
    onOpenChange(false);
    onUse(prompt);
  };

  const toggleFavorite = async (prompt: ChatPrompt) => {
    // Never natively disabled while a save runs: that would drop focus out of the dialog.
    if (controller.saving) return;
    const next = !prompt.favorite;
    // The row moves (favorites sort first): its star keeps focus wherever it lands. Under
    // the Favorites filter an un-starred row leaves the list, so remember a neighbour.
    const at = own.findIndex((p) => p.id === prompt.id);
    const neighbour = own[at + 1] ?? own[at - 1] ?? null;
    pendingFocus.current = { kind: 'star', id: prompt.id, fallback: neighbour?.id ?? null };
    const ok = await controller.update(prompt.id, { favorite: next });
    if (ok) announce(next ? `Added ${prompt.title} to favourites` : `Removed ${prompt.title} from favourites`);
  };

  const remove = async (prompt: ChatPrompt) => {
    if (controller.saving) return;
    // Where focus goes after the row leaves: the next row's Use, else the previous one's.
    const at = own.findIndex((p) => p.id === prompt.id);
    const neighbour = own[at + 1] ?? own[at - 1] ?? null;
    pendingFocus.current = { kind: 'use', id: neighbour?.id ?? null };
    const ok = await controller.remove(prompt.id);
    setConfirming(null);
    if (ok) {
      announce(`Deleted ${prompt.title}`);
    } else {
      // Not deleted: back to the row's ⋯ (the error shows under the list).
      pendingFocus.current = { kind: 'more', id: prompt.id };
    }
  };

  const keep = (prompt: ChatPrompt) => {
    pendingFocus.current = { kind: 'more', id: prompt.id };
    setConfirming(null);
  };

  const compose = (draft: PromptDraft) => {
    onOpenChange(false);
    onCompose(draft);
  };

  const full = controller.state === 'ready' && controller.prompts.length >= SAVED_PROMPT_LIMITS.prompts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(44rem,92dvh)] max-w-2xl flex-col gap-3"
        onCloseAutoFocus={(event) => {
          if (onCloseFocus) {
            event.preventDefault();
            onCloseFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Prompt library</DialogTitle>
          <DialogDescription>{LIBRARY_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <label htmlFor={searchId} className="sr-only">
              Search prompts
            </label>
            <Input
              ref={searchRef}
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompts"
              className="pl-8"
            />
          </div>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => {
              const on = pill ? (pill as readonly string[]).includes(f.id) : filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors',
                    on
                      ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                    focusRing,
                  )}
                >
                  {f.id === 'favorites' ? <Star className={cn('size-3', on && 'fill-current')} aria-hidden /> : null}
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={listRef}
          onScroll={measureList}
          className={cn('-mx-1 min-h-0 flex-1 overflow-y-auto px-1', moreBelow && LIST_FADE)}
          data-testid="prompt-library-list"
          data-more-below={moreBelow || undefined}
        >
          <section aria-labelledby={`${searchId}-own`} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={`${searchId}-own`} className="text-xs font-medium text-muted-foreground">
                Your prompts
              </h3>
              {controller.state === 'ready' ? (
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {controller.prompts.length} of {SAVED_PROMPT_LIMITS.prompts}
                </span>
              ) : null}
            </div>
            {controller.state === 'loading' ? <p className="text-sm text-muted-foreground">Loading your prompts…</p> : null}
            {controller.state === 'ready' && controller.prompts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No saved prompts yet. Save the one in the composer, or save a copy of a starter prompt below.
              </p>
            ) : null}
            {controller.state === 'ready' && controller.prompts.length > 0 && own.length === 0 ? (
              <p className="text-sm text-muted-foreground">None of your prompts match.</p>
            ) : null}
            {own.length ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {own.map((prompt) => (
                  <li key={prompt.id} className="flex items-start gap-2 px-2.5 py-2" data-prompt-id={prompt.id}>
                    <button
                      type="button"
                      aria-pressed={Boolean(prompt.favorite)}
                      aria-label={`Favourite ${prompt.title}`}
                      aria-disabled={controller.saving || undefined}
                      onClick={() => void toggleFavorite(prompt)}
                      className={cn(
                        ROW_BUTTON,
                        'size-7 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                        prompt.favorite && 'text-warning-text hover:text-warning-text',
                      )}
                    >
                      <Star className={cn('size-4', prompt.favorite && 'fill-current')} aria-hidden />
                    </button>
                    <div className="min-w-0 flex-1">
                      <RowUse prompt={prompt} onUse={use} />
                      <PromptbookSteps prompt={prompt} />
                    </div>
                    {confirming === prompt.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          aria-disabled={controller.saving || undefined}
                          aria-label={`Delete ${prompt.title}`}
                          data-confirm="delete"
                          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                          onClick={() => void remove(prompt)}
                        >
                          Delete
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Keep ${prompt.title}`}
                          data-confirm="keep"
                          onClick={() => keep(prompt)}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger aria-label={`More actions for ${prompt.title}`} data-row-more="" className={ROW_BUTTON}>
                            <MoreHorizontal className="size-4" aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-44"
                            onCloseAutoFocus={(event) => {
                              // "Delete…" replaced ⋯ with the confirmation: focus its Keep.
                              if (pendingFocus.current?.kind !== 'keep') return;
                              event.preventDefault();
                              pendingFocus.current = null;
                              focusRowControl(prompt.id, '[data-confirm="keep"]');
                            }}
                          >
                            <DropdownMenuItem
                              onSelect={() =>
                                compose({
                                  editId: prompt.id,
                                  title: prompt.title,
                                  text: prompt.text,
                                  category: prompt.category ?? null,
                                  book: isPromptbook(prompt),
                                })
                              }
                            >
                              <Pencil aria-hidden />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-critical-text focus:text-critical-text"
                              onSelect={() => {
                                pendingFocus.current = { kind: 'keep', id: prompt.id };
                                setConfirming(prompt.id);
                              }}
                            >
                              <Trash2 aria-hidden />
                              Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {!pill && filter === 'favorites' ? null : (
            <section aria-labelledby={`${searchId}-starters`} className="mt-4 space-y-1.5">
              <h3 id={`${searchId}-starters`} className="text-xs font-medium text-muted-foreground">
                Starter prompts
              </h3>
              {starters.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {context === null
                    ? contextError
                      ? 'Starter prompts could not be loaded.'
                      : 'Loading starter prompts…'
                    : searching
                      ? 'No starter prompts match.'
                      : 'No starter prompts are available to you.'}
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border bg-muted/20">
                  {starters.map((prompt) => (
                    <li key={prompt.id} className="flex items-start gap-2 px-2.5 py-2" data-prompt-id={prompt.id}>
                      <div className="min-w-0 flex-1">
                        <RowUse prompt={prompt} onUse={use} />
                        <PromptbookSteps prompt={prompt} />
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={`More actions for ${prompt.title}`} data-row-more="" className={ROW_BUTTON}>
                          <MoreHorizontal className="size-4" aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem
                            disabled={full}
                            onSelect={() =>
                              compose({ title: prompt.title, text: prompt.text, category: prompt.category ?? null, book: isPromptbook(prompt) })
                            }
                          >
                            <BookCopy aria-hidden />
                            {full ? `Save a copy (you have ${SAVED_PROMPT_LIMITS.prompts})` : 'Save a copy'}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {controller.error ? (
          <p role="alert" className="text-xs text-critical-text">
            {controller.error}
          </p>
        ) : null}
        <div className="flex justify-end border-t border-border pt-3">
          <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => compose({ text: '' })}>
            <Plus aria-hidden />
            New prompt
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
