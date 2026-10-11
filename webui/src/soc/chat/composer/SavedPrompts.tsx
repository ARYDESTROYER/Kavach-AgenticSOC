/**
 * Saved prompts (SPEC §10.4; Round 12 prompt library, SPEC §3.1): `UserPrefs.chat_prompts`
 * — at most 50, title ≤ 60, text ≤ 2,000, an optional category and a favorite star —
 * read and written through the existing personal prefs routes. No new store or endpoint.
 *
 * `useSavedPrompts()` loads lazily (the first composer focus or menu open), never at
 * mount, and keeps the server's answer as the truth: a save that the server did not
 * store reports an error instead of showing a prompt that is not there. Every write
 * re-reads the list first so another tab's change is not overwritten by a stale copy.
 * Prompts are the analyst's own words; they render as text and are inserted into the
 * composer (sent later as an ordinary user message), never sent on selection — a prompt
 * with `{placeholders}` or a promptbook first asks for its values (`PromptRunner`).
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatPrompt, ChatPromptCategory } from '@/lib/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { useAnnouncer } from '@/soc/components/announcer';
import {
  SAVED_PROMPTS_UNSUPPORTED,
  SAVED_PROMPT_LIMITS,
  getSavedPrompts,
  normaliseSavedPrompts,
  putSavedPrompts,
} from '../chat-api';
import { displayText } from '../stream-events';
import {
  PROMPTBOOK_SEPARATOR,
  PROMPT_CATEGORIES,
  isPromptCategory,
  isPromptbook,
  newPromptId,
  paramLabel,
  promptParams,
  promptbookProblem,
  promptbookSteps,
} from './prompt-library';

export type SavedPromptsState = 'idle' | 'loading' | 'ready' | 'error';

export interface SavedPromptInput {
  title: string;
  text: string;
  category?: ChatPromptCategory | null;
  favorite?: boolean;
  /** Save as a promptbook (steps separated by `---` lines). */
  book?: boolean;
}

export type SavedPromptPatch = Partial<Pick<ChatPrompt, 'title' | 'text' | 'category' | 'favorite'>>;

export interface SavedPromptsController {
  prompts: ChatPrompt[];
  state: SavedPromptsState;
  error: string | null;
  /** Load once (later calls are no-ops unless the last load failed). */
  load: () => void;
  /** Save a new prompt; resolves false (and sets `error`) on failure. */
  save: (input: SavedPromptInput) => Promise<boolean>;
  /** Change one prompt (favorite, category, title or text). */
  update: (id: string, patch: SavedPromptPatch) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  saving: boolean;
  /** Forget the last write's error (a dialog that opens starts clean). */
  clearError: () => void;
}

/**
 * A write refused because the list changed in another tab (the prompt is gone, or the
 * list is full). It carries the list as the server has it now, so the view shows that
 * instead of a row every later action would fail on.
 */
export class StalePromptsError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly prompts: ChatPrompt[],
  ) {
    super(status, message, null);
    this.name = 'StalePromptsError';
  }
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** One prompt as the backend stores it, or null when its text is unusable. */
function shaped(prompt: ChatPrompt): ChatPrompt | null {
  return normaliseSavedPrompts([prompt])[0] ?? null;
}

/** The server kept what was written (an older server drops unknown fields silently). */
function stored(list: readonly ChatPrompt[], wanted: ChatPrompt): boolean {
  const got = list.find((p) => p.id === wanted.id);
  if (!got) return false;
  return (got.category ?? null) === (wanted.category ?? null) && Boolean(got.favorite) === Boolean(wanted.favorite);
}

/**
 * Add one prompt (a promptbook gets its id prefix). Refuses a 51st. A blank title is
 * taken from the first line (a promptbook's first step), never from the whole text with
 * its `---` step separators flattened into it.
 */
export async function addLibraryPrompt(input: SavedPromptInput): Promise<{ prompt: ChatPrompt; prompts: ChatPrompt[] }> {
  const prompt = shaped({
    id: newPromptId(Boolean(input.book)),
    title: input.title?.trim() || defaultPromptTitle(input.text),
    text: input.text,
    ...(input.category ? { category: input.category } : {}),
    ...(input.favorite ? { favorite: true } : {}),
  });
  if (!prompt) throw new ApiError(422, 'Write the prompt text first.', null);
  const current = await getSavedPrompts();
  if (current.length >= SAVED_PROMPT_LIMITS.prompts) {
    throw new StalePromptsError(409, `You have ${SAVED_PROMPT_LIMITS.prompts} saved prompts. Delete one to save another.`, current);
  }
  const list = await putSavedPrompts([...current, prompt]);
  if (!stored(list, prompt)) throw new ApiError(501, SAVED_PROMPTS_UNSUPPORTED, null);
  return { prompt, prompts: list };
}

/** Change one prompt in place (its position and id stay). */
export async function updateLibraryPrompt(id: string, patch: SavedPromptPatch): Promise<ChatPrompt[]> {
  const current = await getSavedPrompts();
  const target = current.find((p) => p.id === id);
  if (!target) throw new StalePromptsError(404, 'That prompt no longer exists.', current);
  const merged: ChatPrompt = { ...target, ...patch };
  if (!merged.category) delete merged.category;
  if (!merged.favorite) delete merged.favorite;
  const next = shaped(merged);
  if (!next) throw new ApiError(422, 'Write the prompt text first.', null);
  const list = await putSavedPrompts(current.map((p) => (p.id === id ? next : p)));
  if (!stored(list, next)) throw new ApiError(501, SAVED_PROMPTS_UNSUPPORTED, null);
  return list;
}

/** Delete one prompt by id. */
export async function removeLibraryPrompt(id: string): Promise<ChatPrompt[]> {
  const current = await getSavedPrompts();
  if (!current.some((p) => p.id === id)) return current;
  const list = await putSavedPrompts(current.filter((p) => p.id !== id));
  if (list.some((p) => p.id === id)) throw new ApiError(501, SAVED_PROMPTS_UNSUPPORTED, null);
  return list;
}

export function useSavedPrompts(): SavedPromptsController {
  const [prompts, setPrompts] = React.useState<ChatPrompt[]>([]);
  const [state, setState] = React.useState<SavedPromptsState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const alive = React.useRef(true);
  const loadStarted = React.useRef(false);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = React.useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    setState('loading');
    getSavedPrompts()
      .then((list) => {
        if (!alive.current) return;
        setPrompts(list);
        setState('ready');
        setError(null);
      })
      .catch((err: unknown) => {
        loadStarted.current = false;
        if (!alive.current) return;
        setState('error');
        setError(message(err, 'Saved prompts could not be loaded.'));
      });
  }, []);

  /** Run one write; the server's list replaces ours on success. */
  const write = React.useCallback(async (run: () => Promise<ChatPrompt[]>, fallback: string) => {
    setSaving(true);
    try {
      const list = await run();
      if (alive.current) {
        setPrompts(list);
        setState('ready');
        setError(null);
      }
      return true;
    } catch (err) {
      if (alive.current) {
        setError(message(err, fallback));
        // The list changed elsewhere: show it as it is now.
        if (err instanceof StalePromptsError) {
          setPrompts(err.prompts);
          setState('ready');
        }
      }
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, []);

  const save = React.useCallback(
    (input: SavedPromptInput) => write(async () => (await addLibraryPrompt(input)).prompts, 'The prompt could not be saved.'),
    [write],
  );
  const update = React.useCallback(
    (id: string, patch: SavedPromptPatch) => write(() => updateLibraryPrompt(id, patch), 'The prompt could not be changed.'),
    [write],
  );
  const remove = React.useCallback(
    (id: string) => write(() => removeLibraryPrompt(id), 'The prompt could not be deleted.'),
    [write],
  );

  const clearError = React.useCallback(() => {
    // A failed LOAD keeps its message until the next load (the dialogs retry it).
    setError((prev) => (prev !== null && loadStarted.current ? null : prev));
  }, []);

  return { prompts, state, error, load, save, update, remove, saving, clearError };
}

/** First line of a prompt, bounded to the title limit. */
export function defaultPromptTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() && !/^\s*-{3,}\s*$/.test(line)) ?? '';
  return displayText(firstLine, SAVED_PROMPT_LIMITS.title_chars);
}

const NO_CATEGORY = '__none__';

/** What the Save dialog starts from: a draft to save, a copy of a starter, or a prompt to edit. */
export interface PromptDraft {
  title?: string;
  text: string;
  category?: ChatPromptCategory | null;
  book?: boolean;
  /** Edit this saved prompt instead of adding a new one. */
  editId?: string | null;
}

export interface SavePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The text to save (the current draft or a past user turn). */
  initialText: string;
  /** Round 12: a fuller starting point (title, category, kind, or a prompt to edit). */
  initial?: PromptDraft | null;
  controller: SavedPromptsController;
  /** Where focus returns when the dialog closes (the composer). */
  onCloseFocus?: () => void;
}

export function SavePromptDialog({ open, onOpenChange, initialText, initial = null, controller, onCloseFocus }: SavePromptDialogProps) {
  const announce = useAnnouncer();
  const [title, setTitle] = React.useState('');
  const [text, setText] = React.useState('');
  const [category, setCategory] = React.useState<ChatPromptCategory | null>(null);
  const [book, setBook] = React.useState(false);
  const titleId = React.useId();
  const textId = React.useId();
  const categoryId = React.useId();
  const textHelpId = React.useId();
  const problemId = React.useId();
  const fullId = React.useId();
  const { load, clearError } = controller;
  const editing = Boolean(initial?.editId);

  React.useEffect(() => {
    if (!open) return;
    const startText = initial?.text ?? initialText;
    setTitle(initial?.title ? displayText(initial.title, SAVED_PROMPT_LIMITS.title_chars) : defaultPromptTitle(startText));
    setText(startText.slice(0, SAVED_PROMPT_LIMITS.text_chars));
    setCategory(isPromptCategory(initial?.category) ? initial.category : null);
    setBook(Boolean(initial?.book));
    // Another action's failure (a delete in the library) is not this dialog's.
    clearError();
    load();
  }, [open, initialText, initial, load, clearError]);

  const full = !editing && controller.state === 'ready' && controller.prompts.length >= SAVED_PROMPT_LIMITS.prompts;
  const bookProblem = book && text.trim() ? promptbookProblem(text) : null;
  const params = React.useMemo(() => (book ? promptParams(...promptbookSteps(text)) : promptParams(text)), [book, text]);
  const canSave = !controller.saving && !full && text.trim().length > 0 && !bookProblem;
  // Why Save cannot be used, as the button's description (it stays focusable).
  const blockedBy = [bookProblem ? problemId : null, full ? fullId : null].filter(Boolean).join(' ') || undefined;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const ok = initial?.editId
      ? await controller.update(initial.editId, { title: title.trim() || defaultPromptTitle(text), text, category })
      : await controller.save({ title: title.trim() || defaultPromptTitle(text), text, category, book });
    if (ok) {
      announce(editing ? 'Prompt updated' : book ? 'Promptbook saved' : 'Prompt saved');
      onOpenChange(false);
    }
  };

  const heading = editing ? (book ? 'Edit promptbook' : 'Edit prompt') : 'Save prompt';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onCloseAutoFocus={(event) => {
          if (onCloseFocus) {
            event.preventDefault();
            onCloseFocus();
          }
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>
              Your prompts appear in the prompt library and when you type / in the composer.
              {controller.state === 'ready' && !editing
                ? ` ${controller.prompts.length} of ${SAVED_PROMPT_LIMITS.prompts} used.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {editing ? null : (
            <div className="grid gap-1.5">
              <p className="text-sm font-medium leading-none text-foreground">Kind</p>
              <SegmentedControl
                aria-label="Kind"
                size="sm"
                options={[
                  { value: 'prompt', label: 'Prompt' },
                  { value: 'book', label: 'Promptbook' },
                ]}
                value={book ? 'book' : 'prompt'}
                onValueChange={(value) => setBook(value === 'book')}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={title}
                maxLength={SAVED_PROMPT_LIMITS.title_chars}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Taken from the first line when empty"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={categoryId}>Category</Label>
              <Select value={category ?? NO_CATEGORY} onValueChange={(value) => setCategory(isPromptCategory(value) ? value : null)}>
                <SelectTrigger id={categoryId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                  {PROMPT_CATEGORIES.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={textId}>{book ? 'Steps' : 'Prompt'}</Label>
            <Textarea
              id={textId}
              value={text}
              maxLength={SAVED_PROMPT_LIMITS.text_chars}
              onChange={(event) => setText(event.target.value)}
              aria-describedby={bookProblem ? `${textHelpId} ${problemId}` : textHelpId}
              aria-invalid={bookProblem ? true : undefined}
              className="min-h-28"
            />
            <div className="flex items-start justify-between gap-3 text-2xs text-muted-foreground">
              <p id={textHelpId} className="min-w-0">
                {book
                  ? `One step per block, with ${PROMPTBOOK_SEPARATOR} on its own line between steps. Each step is sent after the previous answer finishes. `
                  : ''}
                Write {'{name}'} for a value you fill in each time, for example {'{indicator}'}.
              </p>
              <span className="shrink-0 tabular-nums">
                {Array.from(text).length} / {SAVED_PROMPT_LIMITS.text_chars}
              </span>
            </div>
            {params.length ? (
              <p className="text-xs text-muted-foreground" data-testid="save-prompt-params">
                Asks for: {params.map(paramLabel).join(', ')}
              </p>
            ) : null}
            {bookProblem ? (
              <p id={problemId} className="text-xs text-critical-text">
                {bookProblem}
              </p>
            ) : null}
          </div>
          {full ? (
            <p id={fullId} className="text-xs text-warning-text">
              You have {SAVED_PROMPT_LIMITS.prompts} saved prompts. Delete one to save another.
            </p>
          ) : null}
          {controller.error ? (
            <p role="alert" className="text-xs text-critical-text">
              {controller.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              aria-disabled={!canSave || undefined}
              aria-describedby={blockedBy}
              aria-busy={controller.saving || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {editing ? 'Save changes' : book ? 'Save promptbook' : 'Save prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Promptbook · 3 steps" / null for an ordinary prompt. */
export function promptKindLabel(prompt: Pick<ChatPrompt, 'id' | 'text'>): string | null {
  if (!isPromptbook(prompt)) return null;
  const n = promptbookSteps(prompt.text).length;
  return `Promptbook · ${n} ${n === 1 ? 'step' : 'steps'}`;
}
