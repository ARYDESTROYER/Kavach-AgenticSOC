/**
 * PromptLibrary — the prompt library dialog (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8;
 * replaces "Manage saved prompts").
 *
 * One searchable list in two clearly separated groups:
 *
 *   - **Your prompts**: the analyst's saved prompts and promptbooks, favorites first. A
 *     star toggles the favorite; ⋯ edits or deletes (delete asks first, inline).
 *   - **Starter prompts**: read-only templates shipped with the console, per category,
 *     shown only when every tool they need is allowed. "Save a copy" makes an editable
 *     prompt of one.
 *
 * Filter chips (All, Favorites and the six categories) and a search field narrow both
 * groups. Each row names its category, whether it is a promptbook (and its steps) and
 * the values it asks for. "Use" hands the prompt to the composer, which asks for its
 * `{placeholders}` first (or runs a promptbook step by step); a prompt with nothing to
 * ask goes straight into the composer, never sent on selection.
 *
 * Prompt text is the analyst's own words or the console's starter copy: it renders as
 * text only.
 */
import * as React from 'react';
import { BookCopy, ListOrdered, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react';

import type { ChatContextInfo, ChatPrompt } from '@/lib/types';
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
import { promptKindLabel, type PromptDraft, type SavedPromptsController } from './SavedPrompts';

export interface PromptLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: SavedPromptsController;
  /** The tool catalogue: starters are listed only when their tools are allowed. */
  context: ChatContextInfo | null;
  /** Use a prompt (the composer asks for its values, or inserts it). */
  onUse: (prompt: LibraryPrompt) => void;
  /** Open the Save dialog: a new prompt, a copy of a starter, or an edit. */
  onCompose: (draft: PromptDraft) => void;
  onCloseFocus?: () => void;
}

const FILTERS: ReadonlyArray<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'favorites', label: 'Favorites' },
  ...PROMPT_CATEGORIES.map((c) => ({ id: c.id as LibraryFilter, label: c.label })),
];

const ROW_BUTTON = cn(
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
  focusRing,
);

function PromptMeta({ prompt }: { prompt: LibraryPrompt }) {
  const plan = planPrompt(prompt);
  const kind = promptKindLabel(prompt);
  const parts: string[] = [];
  if (prompt.category) parts.push(CATEGORY_LABEL[prompt.category]);
  if (kind) parts.push(kind);
  if (plan.params.length) parts.push(`Asks for ${plan.params.map(paramLabel).join(', ')}`);
  if (!parts.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground" data-testid="prompt-meta">
      {kind ? <ListOrdered className="size-3" aria-hidden /> : null}
      <span>{parts.join(' · ')}</span>
    </p>
  );
}

function PromptPreview({ prompt }: { prompt: LibraryPrompt }) {
  const plan = planPrompt(prompt);
  const text = plan.book ? plan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n') : prompt.text;
  return <p className="mt-1 line-clamp-2 whitespace-pre-line break-words text-xs text-muted-foreground">{text}</p>;
}

export function PromptLibraryDialog({ open, onOpenChange, controller, context, onUse, onCompose, onCloseFocus }: PromptLibraryDialogProps) {
  const announce = useAnnouncer();
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<LibraryFilter>('all');
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const searchId = React.useId();
  const { load } = controller;

  React.useEffect(() => {
    if (open) load();
    else setConfirming(null);
  }, [open, load]);

  const own = React.useMemo(() => filterPrompts(orderPrompts(controller.prompts), filter, query), [controller.prompts, filter, query]);
  const starters = React.useMemo(
    () => (filter === 'favorites' ? [] : filterPrompts(visibleStarters(context), filter, query)),
    [context, filter, query],
  );
  const searching = query.trim() !== '' || filter !== 'all';

  const use = (prompt: LibraryPrompt) => {
    onOpenChange(false);
    onUse(prompt);
  };

  const toggleFavorite = async (prompt: ChatPrompt) => {
    const next = !prompt.favorite;
    const ok = await controller.update(prompt.id, { favorite: next });
    if (ok) announce(next ? `Added ${prompt.title} to favorites` : `Removed ${prompt.title} from favorites`);
  };

  const remove = async (prompt: ChatPrompt) => {
    const ok = await controller.remove(prompt.id);
    setConfirming(null);
    if (ok) announce(`Deleted ${prompt.title}`);
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
          <DialogDescription>
            Your prompts and starter prompts. Values in braces, like {'{indicator}'}, are asked for before anything is
            sent; a promptbook runs its steps one after another.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <label htmlFor={searchId} className="sr-only">
              Search prompts
            </label>
            <Input
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
              const on = filter === f.id;
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

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="prompt-library-list">
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
                      aria-label={`Favorite ${prompt.title}`}
                      disabled={controller.saving}
                      onClick={() => void toggleFavorite(prompt)}
                      className={cn(ROW_BUTTON, 'size-7', prompt.favorite && 'text-warning-text hover:text-warning-text')}
                    >
                      <Star className={cn('size-4', prompt.favorite && 'fill-current')} aria-hidden />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{prompt.title}</p>
                      <PromptMeta prompt={prompt} />
                      <PromptPreview prompt={prompt} />
                    </div>
                    {confirming === prompt.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={controller.saving}
                          aria-label={`Delete ${prompt.title}`}
                          onClick={() => void remove(prompt)}
                        >
                          Delete
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Keep ${prompt.title}`} onClick={() => setConfirming(null)}>
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="outline" aria-label={`Use ${prompt.title}`} onClick={() => use(prompt)}>
                          {isPromptbook(prompt) ? 'Run' : 'Use'}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger aria-label={`More actions for ${prompt.title}`} className={ROW_BUTTON}>
                            <MoreHorizontal className="size-4" aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
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
                              onSelect={() => setConfirming(prompt.id)}
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

          {filter === 'favorites' ? null : (
            <section aria-labelledby={`${searchId}-starters`} className="mt-4 space-y-1.5">
              <h3 id={`${searchId}-starters`} className="text-xs font-medium text-muted-foreground">
                Starter prompts
              </h3>
              {starters.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {searching ? 'No starter prompts match.' : 'No starter prompts are available to you.'}
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border bg-muted/20">
                  {starters.map((prompt) => (
                    <li key={prompt.id} className="flex items-start gap-2 px-2.5 py-2" data-prompt-id={prompt.id}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{prompt.title}</p>
                        <PromptMeta prompt={prompt} />
                        <PromptPreview prompt={prompt} />
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="outline" aria-label={`Use ${prompt.title}`} onClick={() => use(prompt)}>
                          {isPromptbook(prompt) ? 'Run' : 'Use'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="w-8 px-0"
                          disabled={full}
                          aria-label={`Save a copy of ${prompt.title}`}
                          title={full ? `You have ${SAVED_PROMPT_LIMITS.prompts} saved prompts` : 'Save a copy you can change'}
                          onClick={() =>
                            compose({ title: prompt.title, text: prompt.text, category: prompt.category ?? null, book: isPromptbook(prompt) })
                          }
                        >
                          <BookCopy aria-hidden />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {controller.error ? <p className="text-xs text-critical-text">{controller.error}</p> : null}
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
