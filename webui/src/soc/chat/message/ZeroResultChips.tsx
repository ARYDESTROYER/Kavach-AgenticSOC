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
 * last, after the follow-ups in the same row (Round 13, SPEC-chat §4.2: ghost chips behind
 * a muted "Widen the search:" label; nothing before them moves), and a chip that a
 * follow-up already offers is left out instead of removing that follow-up
 * (`chipsNotInFollowUps`). They stay when the viewer turned suggested follow-ups off:
 * they are honest search widening, not suggestions.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { ChatStep } from '@/lib/types';
import { getStepObservation, isSafeChatId, type ChatZeroSuggestion } from '../chat-api';
import { SuggestionChip } from './FollowUps';
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
  disabled?: boolean;
  onPick: (question: string) => void;
  className?: string;
}

/** The muted label in front of the zero-result chips. */
export const WIDEN_LABEL = 'Widen the search:';

/** "Widen the search:" and the chips (ghost chips, the follow-ups' style). */
export function ZeroResultChips({ chips, disabled = false, onPick, className }: ZeroResultChipsProps) {
  if (!chips.length) return null;
  return (
    <div
      role="group"
      aria-label="Ways to widen the search"
      className={cn('flex max-w-full flex-wrap items-center gap-1', className)}
      data-testid="zero-result-chips"
    >
      <span className="px-1 text-xs text-muted-foreground">{WIDEN_LABEL}</span>
      {chips.map((chip) => (
        <SuggestionChip key={chip.question} label={chip.label} title={chip.question} disabled={disabled} onClick={() => onPick(chip.question)} />
      ))}
    </div>
  );
}
