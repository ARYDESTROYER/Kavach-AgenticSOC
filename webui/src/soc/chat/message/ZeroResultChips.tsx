/**
 * Zero-result chips (Round 12 SPEC D10, SYNTHESIS-chat P0-11): when a lookup of the
 * latest answer matched nothing, the engine stored one-click ways to widen it with the
 * observation the model saw. They are read through the step inspector route (owner-
 * scoped) and shown under the answer as chips; a chip sends the follow-up question that
 * re-runs the lookup (`origin: "follow_up"`, never user-authored text).
 *
 * Reads are cached per step for the session, so re-renders and remounts never fetch
 * the same observation twice, and a failed read just shows no chips (the answer's own
 * text already says how to widen the search).
 *
 * The chips arrive after the answer has rendered, so they only ever APPEND: they render
 * last, below the follow-ups (nothing above them moves), and a chip that a follow-up
 * already offers is left out instead of removing that follow-up (`chipsNotInFollowUps`).
 */
import * as React from 'react';
import { CornerDownRight, SearchX } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatStep } from '@/lib/types';
import { getStepObservation, isSafeChatId, type ChatZeroSuggestion } from '../chat-api';
import { zeroChips, zeroResultSteps, type ZeroChip } from './zero-suggestions';

/** At most this many zero-result lookups of one answer are read. */
const MAX_STEPS = 3;

const cache = new Map<string, Promise<ChatZeroSuggestion[]>>();

function suggestionsFor(conversationId: string, messageId: string, index: number): Promise<ChatZeroSuggestion[]> {
  const key = `${conversationId}/${messageId}/${index}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = getStepObservation(conversationId, messageId, index).then((read) => read.suggestions);
    // A failed read is not cached: the next mount may try again.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

/** Tests only. */
export function resetZeroChipCacheForTests(): void {
  cache.clear();
}

/**
 * The chips of an answer's zero-result lookups, or `[]`. `enabled` is false for
 * anything but the latest saved Workspace answer (case chat has no stored observations).
 */
export function useZeroResultChips(
  conversationId: string | null,
  messageId: string | null,
  steps: readonly ChatStep[] | undefined,
  enabled: boolean,
): ZeroChip[] {
  const zero = React.useMemo(() => zeroResultSteps(steps).slice(0, MAX_STEPS), [steps]);
  const indexes = zero.map((step) => step.index).join(',');
  const [chips, setChips] = React.useState<ZeroChip[]>([]);
  React.useEffect(() => {
    if (!enabled || !indexes || !isSafeChatId(conversationId) || !isSafeChatId(messageId)) {
      setChips([]);
      return undefined;
    }
    let alive = true;
    const list = indexes.split(',').map(Number);
    void Promise.allSettled(list.map((index) => suggestionsFor(conversationId, messageId, index))).then((results) => {
      if (!alive) return;
      const merged = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
      setChips(zeroChips(merged));
    });
    return () => {
      alive = false;
    };
  }, [conversationId, enabled, indexes, messageId]);
  return chips;
}

export interface ZeroResultChipsProps {
  chips: readonly ZeroChip[];
  /** Other lookups of the answer did find data: say that only some found nothing. */
  some?: boolean;
  disabled?: boolean;
  onPick: (question: string) => void;
  className?: string;
}

/** "Nothing matched. Widen the search:" (or "Some lookups found nothing.") and the chips. */
export function ZeroResultChips({ chips, some = false, disabled = false, onPick, className }: ZeroResultChipsProps) {
  if (!chips.length) return null;
  return (
    <div
      role="group"
      aria-label="Ways to widen the search"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      data-testid="zero-result-chips"
    >
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <SearchX className="size-3.5" aria-hidden />
        {some ? 'Some lookups found nothing. Widen them:' : 'Nothing matched. Widen the search:'}
      </span>
      {chips.map((chip) => (
        <button
          key={chip.question}
          type="button"
          disabled={disabled}
          title={chip.question}
          onClick={() => onPick(chip.question)}
          className={cn(
            'inline-flex min-h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
            focusRing,
          )}
        >
          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {chip.label}
        </button>
      ))}
    </div>
  );
}
