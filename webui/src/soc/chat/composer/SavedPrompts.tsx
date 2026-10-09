/**
 * Saved prompts (SPEC §10.4): `UserPrefs.chat_prompts` — at most 50, title ≤ 60,
 * text ≤ 2,000 — read and written through the existing personal prefs routes.
 *
 * `useSavedPrompts()` loads lazily (the first composer focus or menu open), never at
 * mount, and keeps the server's answer as the truth: a save that the server did not
 * store reports an error instead of showing a prompt that is not there. Prompts are
 * the analyst's own words; they render as text and are inserted into the composer
 * (sent later as an ordinary user message), never sent on selection.
 */
import * as React from 'react';
import { Trash2 } from 'lucide-react';
import type { ChatPrompt } from '@/lib/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { useAnnouncer } from '@/soc/components/announcer';
import { addSavedPrompt, deleteSavedPrompt, getSavedPrompts, SAVED_PROMPT_LIMITS } from '../chat-api';
import { displayText } from '../stream-events';

export type SavedPromptsState = 'idle' | 'loading' | 'ready' | 'error';

export interface SavedPromptsController {
  prompts: ChatPrompt[];
  state: SavedPromptsState;
  error: string | null;
  /** Load once (later calls are no-ops unless the last load failed). */
  load: () => void;
  /** Save a new prompt; resolves false (and sets `error`) on failure. */
  save: (input: { title: string; text: string }) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  saving: boolean;
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

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

  const save = React.useCallback(async (input: { title: string; text: string }) => {
    setSaving(true);
    try {
      const result = await addSavedPrompt(input);
      if (alive.current) {
        setPrompts(result.prompts);
        setState('ready');
        setError(null);
      }
      return true;
    } catch (err) {
      if (alive.current) setError(message(err, 'The prompt could not be saved.'));
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, []);

  const remove = React.useCallback(async (id: string) => {
    setSaving(true);
    try {
      const next = await deleteSavedPrompt(id);
      if (alive.current) {
        setPrompts(next);
        setError(null);
      }
      return true;
    } catch (err) {
      if (alive.current) setError(message(err, 'The prompt could not be deleted.'));
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  }, []);

  return { prompts, state, error, load, save, remove, saving };
}

/** First line of a prompt, bounded to the title limit. */
export function defaultPromptTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  return displayText(firstLine, SAVED_PROMPT_LIMITS.title_chars);
}

export interface SavePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The text to save (the current draft or a past user turn). */
  initialText: string;
  controller: SavedPromptsController;
  /** Where focus returns when the dialog closes (the composer). */
  onCloseFocus?: () => void;
}

export function SavePromptDialog({ open, onOpenChange, initialText, controller, onCloseFocus }: SavePromptDialogProps) {
  const announce = useAnnouncer();
  const [title, setTitle] = React.useState('');
  const [text, setText] = React.useState('');
  const titleId = React.useId();
  const textId = React.useId();
  const { load } = controller;

  React.useEffect(() => {
    if (!open) return;
    setTitle(defaultPromptTitle(initialText));
    setText(initialText.slice(0, SAVED_PROMPT_LIMITS.text_chars));
    load();
  }, [open, initialText, load]);

  const full = controller.state === 'ready' && controller.prompts.length >= SAVED_PROMPT_LIMITS.prompts;
  const canSave = !controller.saving && !full && text.trim().length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const ok = await controller.save({ title: title.trim(), text });
    if (ok) {
      announce('Prompt saved');
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          if (onCloseFocus) {
            event.preventDefault();
            onCloseFocus();
          }
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Save prompt</DialogTitle>
            <DialogDescription>
              Saved prompts appear in Options and when you type / in the composer.
              {controller.state === 'ready'
                ? ` ${controller.prompts.length} of ${SAVED_PROMPT_LIMITS.prompts} used.`
                : ''}
            </DialogDescription>
          </DialogHeader>
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
            <Label htmlFor={textId}>Prompt</Label>
            <Textarea
              id={textId}
              value={text}
              maxLength={SAVED_PROMPT_LIMITS.text_chars}
              onChange={(event) => setText(event.target.value)}
              className="min-h-28"
            />
            <p className="text-right text-2xs text-muted-foreground tabular-nums">
              {Array.from(text).length} / {SAVED_PROMPT_LIMITS.text_chars}
            </p>
          </div>
          {full ? (
            <p className="text-xs text-warning-text">
              You have {SAVED_PROMPT_LIMITS.prompts} saved prompts. Delete one to save another.
            </p>
          ) : null}
          {controller.error ? <p className="text-xs text-critical-text">{controller.error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} aria-busy={controller.saving || undefined}>
              Save prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface ManagePromptsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: SavedPromptsController;
  /** Put a prompt's text into the composer. */
  onUse: (prompt: ChatPrompt) => void;
  onCloseFocus?: () => void;
}

export function ManagePromptsDialog({ open, onOpenChange, controller, onUse, onCloseFocus }: ManagePromptsDialogProps) {
  const announce = useAnnouncer();
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const { load } = controller;

  React.useEffect(() => {
    if (open) load();
    else setConfirming(null);
  }, [open, load]);

  const remove = async (prompt: ChatPrompt) => {
    const ok = await controller.remove(prompt.id);
    setConfirming(null);
    if (ok) announce(`Deleted ${prompt.title}`);
  };

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
        <DialogHeader>
          <DialogTitle>Saved prompts</DialogTitle>
          <DialogDescription>
            {controller.state === 'ready'
              ? `${controller.prompts.length} of ${SAVED_PROMPT_LIMITS.prompts} saved. Use one to put it in the composer.`
              : 'Your personal prompts, kept with your preferences.'}
          </DialogDescription>
        </DialogHeader>
        {controller.state === 'loading' ? <p className="text-sm text-muted-foreground">Loading saved prompts…</p> : null}
        {controller.state === 'ready' && controller.prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved prompts yet. Use Options → Saved prompts → Save current prompt.
          </p>
        ) : null}
        {controller.prompts.length ? (
          <ul className="max-h-[50dvh] divide-y divide-border overflow-y-auto rounded-md border border-border">
            {controller.prompts.map((prompt) => (
              <li key={prompt.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{prompt.title}</p>
                  <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{prompt.text}</p>
                </div>
                {confirming === prompt.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Names carry the prompt: a list of identical "Delete"/"Keep"/"Use"
                        buttons is unusable by name in a screen reader's control list. */}
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
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Use ${prompt.title}`}
                      onClick={() => {
                        onUse(prompt);
                        onOpenChange(false);
                      }}
                    >
                      Use
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-8 px-0"
                      aria-label={`Delete ${prompt.title}…`}
                      onClick={() => setConfirming(prompt.id)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {controller.error ? <p className="text-xs text-critical-text">{controller.error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
