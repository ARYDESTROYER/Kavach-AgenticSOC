/**
 * The running promptbook, kept outside the composer (Round 12 SPEC D13, §3.1).
 *
 * Leaving the chat page unmounts the composer, but the step being answered goes on (the
 * turn runner detaches its view instead of aborting it). The book therefore lives here,
 * at module level in the lazy chat chunk next to `turn-runner.ts`: a returning composer
 * re-subscribes, finds the step's answer by its request key (live or restored from the
 * saved thread) and keeps advancing. Nothing is sent while no composer is mounted: the
 * next step goes out when the analyst is back on the book's conversation.
 *
 * One book at a time (sending is paused while one runs). Memory only: titles and step
 * text are never written to storage (#9), and sign-out forgets the book with every turn.
 */
import { onChatActivity } from '../../chat-activity/activity';

export type PromptbookStatus = 'running' | 'done' | 'stopped' | 'failed';

/** What the bar shows (a new object on every change). */
export interface PromptbookRun {
  title: string;
  steps: string[];
  /** The step being answered (0-based). */
  index: number;
  status: PromptbookStatus;
  /** What happened, when it ended. */
  note: string | null;
}

/** The step being answered. Mutated in place by the composer that drives the book. */
export interface PromptbookStep {
  index: number;
  /** The composer view that sent it (`itemsBefore` is meaningful only there). */
  viewId: number;
  /** `engine.items.length` right before the send, in that view. */
  itemsBefore: number;
  /** The engine's conversation when the step was sent (null: a new chat). */
  sentConversationId: string | null;
  /**
   * The idempotency key of the turn this step started. It survives a remount: a live
   * turn re-attaches with it and a saved answer is restored with it, so completion is
   * judged on THIS exchange only and another thread's answer never passes for it.
   */
  requestKey: string | null;
  /** The sending view has drawn the step's turn (its pair, or the engine busy with it). */
  shown: boolean;
  sawBusy: boolean;
}

export interface PromptbookState {
  run: PromptbookRun;
  /** The saved conversation the book runs in (null until a new chat's first answer names it). */
  conversationId: string | null;
  step: PromptbookStep | null;
}

let state: PromptbookState | null = null;
let viewCounter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** The bar's snapshot (`useSyncExternalStore`). */
export function getPromptbook(): PromptbookRun | null {
  return state?.run ?? null;
}

export function subscribePromptbook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live record (step and conversation are mutated in place; `run` is replaced). */
export function promptbookState(): PromptbookState | null {
  return state;
}

/** Start a book (replaces a finished one). */
export function beginPromptbook(title: string, steps: string[], conversationId: string | null): PromptbookState {
  state = {
    run: { title, steps: [...steps], index: 0, status: 'running', note: null },
    conversationId,
    step: null,
  };
  emit();
  return state;
}

/** Change what the bar shows. */
export function patchPromptbook(patch: Partial<PromptbookRun>): void {
  if (!state) return;
  state.run = { ...state.run, ...patch };
  emit();
}

/** End the book: no step is pending any more. */
export function endPromptbook(status: Exclude<PromptbookStatus, 'running'>, note: string): void {
  if (!state) return;
  state.step = null;
  patchPromptbook({ status, note });
}

/** Hide the bar. */
export function clearPromptbook(): void {
  if (!state) return;
  state = null;
  emit();
}

/** A fresh id for one composer view. */
export function nextPromptbookViewId(): number {
  viewCounter += 1;
  return viewCounter;
}

/** Tests only. */
export function resetPromptbookForTests(): void {
  state = null;
  viewCounter = 0;
  listeners.clear();
}

// Sign-out forgets the book with every turn (the next user never sees its title).
onChatActivity('clear', clearPromptbook);
