/**
 * PromptRunner — what happens after the analyst picks a library prompt (Round 12 SPEC
 * §3.1, SYNTHESIS-chat P1-8).
 *
 *   - {@link PromptParamsCard}: a prompt with `{placeholders}` (or any promptbook) opens an
 *     inline card above the composer that asks for each value in the analyst's own words,
 *     previews exactly what will be sent, then Sends it (a promptbook: Run n steps).
 *     Values fill every placeholder of the same name in one pass; nothing is sent until
 *     the analyst confirms. Esc or Cancel closes it.
 *   - {@link usePromptbookRunner} + {@link PromptbookBar}: a promptbook runs as
 *     consecutive turns of THIS conversation — the next step is sent only after the
 *     previous answer has finished — with a visible "Step 2 of 3" counter and Stop. A
 *     step that fails, is stopped, or ends with the assistant asking a question stops
 *     the book (the remaining steps are not sent); switching conversations stops it too.
 *     Leaving the chat page does not: the book is kept in `promptbook-store.ts` (the step
 *     goes on like any detached turn) and continues when the analyst is back on its
 *     conversation (Round 12 SPEC D13).
 *
 * Every step is sent as the analyst's own message (`origin: "user"`): the text is their
 * saved prompt or a console starter, and every value in it is what they typed (SPEC
 * §4.8 taint rule). Each step is an ordinary chat turn: metered, audited and read-only.
 */
import * as React from 'react';
import { ListOrdered, MessageSquareText, Square, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Button, buttonVariants } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { useAnnouncer } from '@/soc/components/announcer';
import { listRuns, stopRun, type TurnRun } from '../turn-runner';
import type { ChatEngine } from '../useChatEngine';
import { fillPrompt, paramKey, paramLabel, type PromptPlan } from './prompt-library';
import {
  beginPromptbook,
  clearPromptbook,
  endPromptbook,
  getPromptbook,
  nextPromptbookViewId,
  patchPromptbook,
  promptbookState,
  subscribePromptbook,
  type PromptbookRun,
  type PromptbookStatus,
} from './promptbook-store';

/** The longest value one placeholder takes. */
export const PARAM_VALUE_CHARS = 400;

const ICON_BUTTON = cn(
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
  focusRing,
);

/* -------------------------------------------------------------------------- */
/* Values card.                                                                */
/* -------------------------------------------------------------------------- */

export interface PromptParamsCardProps {
  plan: PromptPlan;
  /** Send (or run) now; false while an answer is being written or sending is blocked. */
  canRun: boolean;
  /** Why it cannot run now, when it cannot. */
  blockedReason?: string | null;
  /** The filled steps (one for an ordinary prompt). */
  onSubmit: (steps: string[]) => void;
  onCancel: () => void;
}

export function PromptParamsCard({ plan, canRun, blockedReason = null, onSubmit, onCancel }: PromptParamsCardProps) {
  const announce = useAnnouncer();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [tried, setTried] = React.useState(false);
  const firstRef = React.useRef<HTMLInputElement | null>(null);
  const submitRef = React.useRef<HTMLButtonElement>(null);
  const inputRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const reasonId = `${baseId}-reason`;

  React.useEffect(() => {
    // Ask for the first value at once; a promptbook without values focuses Run.
    (firstRef.current ?? submitRef.current)?.focus();
  }, []);

  const missing = plan.params.filter((name) => !(values[paramKey(name)] ?? '').trim());
  const filled = plan.steps.map((step) => fillPrompt(step, values));
  const n = plan.steps.length;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (missing.length) {
      setTried(true);
      inputRefs.current.get(paramKey(missing[0]))?.focus();
      return;
    }
    if (!canRun) {
      // The button stays focusable while it cannot send; say why instead of doing nothing.
      if (blockedReason) announce(blockedReason);
      return;
    }
    onSubmit(filled);
  };

  const action = plan.book ? `Run ${n} ${n === 1 ? 'step' : 'steps'}` : 'Send';

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the card from any of its fields
    <section
      aria-labelledby={titleId}
      className="mb-2 rounded-md border border-border bg-card p-3 shadow-sm"
      data-testid="prompt-params"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          // Handled here, so the composer's Esc never stops a running answer instead.
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <div className="flex items-start gap-2">
          {plan.book ? (
            <ListOrdered className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="truncate text-sm font-medium text-foreground">
              {plan.prompt.title}
            </h3>
            <p className="text-xs text-muted-foreground">
              {plan.book
                ? `Promptbook · ${n} ${n === 1 ? 'step' : 'steps'}, each sent after the previous answer finishes.`
                : 'Fill in the values, then send.'}
            </p>
          </div>
          <button type="button" className={ICON_BUTTON} aria-label="Close without sending" onClick={onCancel}>
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {plan.params.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {plan.params.map((name, index) => {
              const key = paramKey(name);
              const id = `${baseId}-p${index}`;
              const invalid = tried && !(values[key] ?? '').trim();
              return (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={id}>{paramLabel(name)}</Label>
                  <Input
                    id={id}
                    ref={(el) => {
                      if (index === 0) firstRef.current = el;
                      if (el) inputRefs.current.set(key, el);
                      else inputRefs.current.delete(key);
                    }}
                    value={values[key] ?? ''}
                    maxLength={PARAM_VALUE_CHARS}
                    autoComplete="off"
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${id}-err` : undefined}
                    onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                  />
                  {invalid ? (
                    <p id={`${id}-err`} className="text-2xs text-critical-text">
                      Enter a value.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="rounded-sm bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground" data-testid="prompt-preview">
          <p className="mb-0.5 font-medium text-foreground">{plan.book ? 'Steps' : 'Will send'}</p>
          {plan.book ? (
            <ol className="list-decimal space-y-0.5 pl-4">
              {filled.map((step, i) => (
                <li key={i} className="whitespace-pre-line break-words">
                  {step}
                </li>
              ))}
            </ol>
          ) : (
            <p className="line-clamp-4 whitespace-pre-line break-words">{filled[0]}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!canRun && blockedReason ? (
            <p id={reasonId} className="mr-auto text-xs text-muted-foreground">
              {blockedReason}
            </p>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={submitRef}
            type="submit"
            size="sm"
            aria-disabled={!canRun || undefined}
            aria-describedby={!canRun && blockedReason ? reasonId : undefined}
            className="aria-disabled:opacity-50"
          >
            {action}
          </Button>
        </div>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Promptbook runner.                                                          */
/* -------------------------------------------------------------------------- */

export type { PromptbookRun, PromptbookStatus } from './promptbook-store';

export interface PromptbookRunner {
  run: PromptbookRun | null;
  /** Start a promptbook (refused while an answer is being written or a book runs). */
  start: (title: string, steps: string[]) => boolean;
  /** Stop: the step's answer is stopped and no further step is sent. */
  stop: () => void;
  /** Hide the finished bar. */
  dismiss: () => void;
  running: boolean;
}

export interface PromptbookRunnerOptions {
  /** False for the case composer: promptbooks belong to Workspace chat only. */
  enabled?: boolean;
  /**
   * The host cannot send yet (the thread list or a thread is still loading): nothing is
   * judged until the view has settled on a conversation.
   */
  hostBlocked?: boolean;
}

/** Notices that mean the step was refused before an answer (the next would be too). */
const REFUSED_NOTICES = new Set(['budget', 'breaker', 'provider', 'denied']);

/** Why sending is paused while a promptbook runs (the composer's block reason). */
export const PROMPTBOOK_RUNNING_REASON = 'A promptbook is running. Stop it to ask something else.';

/** The request key of the newest turn this tab started for `text`, when the runner has it. */
function startedRequestKey(text: string): string | null {
  const message = text.trim();
  let newest: TurnRun | null = null;
  for (const run of listRuns()) {
    if (run.request?.message === message && (!newest || run.id > newest.id)) newest = run;
  }
  return newest?.requestKey ?? null;
}

/**
 * Drive the running promptbook from this composer view. The book itself lives in
 * `promptbook-store.ts`, so leaving the chat page never loses it: the view that comes
 * back finds the step's answer by its request key and keeps advancing.
 */
export function usePromptbookRunner(
  engine: ChatEngine,
  announce: (message: string) => void = () => undefined,
  options: PromptbookRunnerOptions = {},
): PromptbookRunner {
  const { enabled = true, hostBlocked = false } = options;
  const snapshot = React.useSyncExternalStore(subscribePromptbook, getPromptbook, getPromptbook);
  const [viewId] = React.useState(nextPromptbookViewId);
  /** This view has shown the book's conversation: a later switch away stops the book. */
  const seen = React.useRef(false);
  const engineRef = React.useRef(engine);
  engineRef.current = engine;
  const announceRef = React.useRef(announce);
  announceRef.current = announce;

  /** End the book: `note` is shown in the bar; `spoken` is announced. */
  const finish = React.useCallback((status: Exclude<PromptbookStatus, 'running'>, note: string, spoken = note) => {
    endPromptbook(status, note);
    announceRef.current(spoken);
  }, []);

  const sendStep = React.useCallback(
    (steps: string[], index: number): boolean => {
      const book = promptbookState();
      const current = engineRef.current;
      if (!book) return false;
      const before = current.items.length;
      if (!current.send(steps[index], { origin: 'user' })) return false;
      book.step = {
        index,
        viewId,
        itemsBefore: before,
        sentConversationId: current.conversationId,
        requestKey: startedRequestKey(steps[index]),
        shown: false,
        sawBusy: false,
      };
      return true;
    },
    [viewId],
  );

  const start = React.useCallback(
    (title: string, steps: string[]) => {
      const current = engineRef.current;
      if (!enabled || !steps.length || current.busy || promptbookState()?.run.status === 'running') return false;
      beginPromptbook(title, steps, current.conversationId);
      seen.current = true;
      if (!sendStep(steps, 0)) {
        endPromptbook('failed', 'The first step could not be sent.');
        return false;
      }
      announceRef.current(`Running ${title}: step 1 of ${steps.length}`);
      return true;
    },
    [enabled, sendStep],
  );

  const stop = React.useCallback(() => {
    const book = promptbookState();
    if (!enabled || !book || book.run.status !== 'running') return;
    const current = engineRef.current;
    const key = book.step?.requestKey ?? null;
    const onScreen = key === null ? book.step?.viewId === viewId : current.items.some((item) => item.requestKey === key);
    if (onScreen && current.busy && current.canStop) {
      current.stop();
    } else if (key !== null) {
      // The step is answered in a thread that is not on screen: stop it through the runner.
      const run = listRuns().find((item) => item.requestKey === key && item.state === 'running');
      if (run) stopRun(run);
    }
    finish('stopped', `Stopped at step ${book.run.index + 1} of ${book.run.steps.length}.`);
  }, [enabled, finish, viewId]);

  const dismiss = React.useCallback(() => {
    if (enabled) clearPromptbook();
  }, [enabled]);

  // Advance after each answer. Reads the engine as rendered: busy, the transcript and
  // the conversation id; and the book as stored (never a stale snapshot).
  const { busy, items, conversationId } = engine;
  React.useEffect(() => {
    if (!enabled || hostBlocked) return;
    const book = promptbookState();
    if (!book || book.run.status !== 'running') return;
    const { run, step } = book;
    const n = run.steps.length;
    if (step && step.requestKey === null && step.viewId === viewId) {
      // The engine adds the turn synchronously: its pair is on screen from the next render.
      const started = items.slice(step.itemsBefore).find((item) => item.kind === 'assistant');
      if (started?.requestKey) step.requestKey = started.requestKey;
    }
    const key = step?.requestKey ?? null;
    if (step && step.viewId === viewId && !step.shown) {
      if (busy || (key !== null ? items.some((item) => item.requestKey === key) : items.length > step.itemsBefore)) {
        step.shown = true;
      } else if (conversationId === step.sentConversationId && key !== null) {
        // This view sent the step but has not drawn it yet: the book's own update can
        // render before the engine's (a store update is synchronous, the engine's state
        // update from an effect is not). Judge nothing while the turn is still running.
        const turn = listRuns().find((item) => item.requestKey === key);
        if (turn?.state === 'running') return;
      }
    }
    const holds = key !== null && items.some((item) => item.requestKey === key);
    if (holds && conversationId && book.conversationId !== conversationId) book.conversationId = conversationId;
    const same =
      holds ||
      (book.conversationId !== null
        ? conversationId === book.conversationId
        : conversationId === null && key === null && step?.viewId === viewId);
    if (!same) {
      // Another transcript is on screen. In a view that has shown the book's thread this
      // is a switch. A view that has not (the analyst left the chat and came back) waits
      // on an empty New chat for the thread to open, and stops when another one opens.
      if (conversationId !== null || seen.current) {
        const why = seen.current ? 'you switched conversations' : 'another conversation is open';
        finish('stopped', `Stopped at step ${run.index + 1} of ${n}: ${why}.`);
      }
      return;
    }
    seen.current = true;
    if (!step) return;
    if (busy) {
      step.sawBusy = true;
      return;
    }
    const answer = key === null ? undefined : items.find((item) => item.kind === 'assistant' && item.requestKey === key);
    if (!answer || answer.kind !== 'assistant') {
      // The turn ended without an answer in this thread (nothing was saved).
      if (key !== null || step.sawBusy) finish('failed', `Step ${step.index + 1} of ${n} did not finish. The remaining steps were not sent.`);
      return;
    }
    if (answer.status === 'running') return;
    if (answer.status === 'error') {
      finish('failed', `Step ${step.index + 1} of ${n} failed. The remaining steps were not sent.`);
      return;
    }
    const response = answer.response;
    const kind = response?.notice?.kind;
    if (kind && REFUSED_NOTICES.has(kind)) {
      finish('failed', `Step ${step.index + 1} of ${n} could not be answered. The remaining steps were not sent.`);
      return;
    }
    if (kind === 'cancelled') {
      finish('stopped', `Stopped at step ${step.index + 1} of ${n}.`);
      return;
    }
    if (response?.clarify) {
      finish('stopped', `Paused at step ${step.index + 1} of ${n}: the assistant asked a question. Answer it, then continue yourself.`);
      return;
    }
    const next = step.index + 1;
    if (next >= n) {
      finish('done', `Finished all ${n} steps.`, `${run.title}: finished all ${n} steps.`);
      return;
    }
    if (!sendStep(run.steps, next)) {
      finish('failed', `Step ${next + 1} of ${n} could not be sent. The remaining steps were not sent.`);
      return;
    }
    patchPromptbook({ index: next });
    announceRef.current(`Step ${next + 1} of ${n}`);
  }, [enabled, hostBlocked, snapshot, busy, items, conversationId, finish, sendStep, viewId]);

  const run = enabled ? snapshot : null;
  return { run, start, stop, dismiss, running: run?.status === 'running' };
}

export interface PromptbookBarProps {
  runner: PromptbookRunner;
  /** The bar was closed: where focus goes next (the composer). */
  onClosed?: () => void;
}

const STOP_BUTTON = buttonVariants({ variant: 'outline', size: 'sm', className: 'h-7 shrink-0 gap-1.5 px-2' });

/**
 * The step counter with Stop while a promptbook runs; what happened once it ends. Stop
 * and Close are ONE button, so focus stays on it when the book ends (by Stop or by
 * itself); Close hands focus to the composer.
 */
export function PromptbookBar({ runner, onClosed }: PromptbookBarProps) {
  const { run } = runner;
  if (!run) return null;
  const running = run.status === 'running';
  const n = run.steps.length;
  return (
    <div
      className={cn(
        'mb-2 flex items-start gap-2 rounded-md border px-3 py-1.5 text-xs',
        running ? 'border-primary/30 bg-primary/5' : 'border-border bg-card',
      )}
      data-testid="promptbook-bar"
      data-status={run.status}
    >
      <ListOrdered className="mt-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        <p className="flex min-w-0 items-baseline">
          <span className="min-w-0 truncate font-medium text-foreground">{run.title}</span>
          {running ? (
            <span className="shrink-0 whitespace-pre tabular-nums text-muted-foreground" aria-live="off">
              {' · '}Step {run.index + 1} of {n}
            </span>
          ) : null}
        </p>
        {!running && run.note ? (
          <p className="break-words text-muted-foreground" data-testid="promptbook-note">
            {run.note}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className={running ? STOP_BUTTON : ICON_BUTTON}
        aria-label={running ? undefined : 'Close'}
        onClick={() => {
          if (running) {
            runner.stop();
            return;
          }
          runner.dismiss();
          onClosed?.();
        }}
      >
        {running ? (
          <>
            <Square className="size-3 fill-current" aria-hidden />
            Stop
          </>
        ) : (
          <X className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
