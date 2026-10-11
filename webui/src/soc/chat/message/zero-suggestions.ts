/**
 * Zero-result recovery (Round 12 SPEC D10, SYNTHESIS-chat P0-11): a lookup that matched
 * nothing carries engine-built `suggestions[]` in the observation the model saw (a wider
 * window, every source, the same lookup without one filter). The answer shows them as
 * one-click chips; a chip sends a follow-up question that re-runs the lookup.
 *
 * The labels are ENGINE templates ("All time", "Without the rule filter", "Last 7
 * days"), never model or log text. The question a chip sends is built here from the
 * label alone, in the same words the Demo planner offers as follow-ups ("Show the same
 * for all time"), so a chip and a follow-up never both ask the same thing.
 */
import type { ChatStep } from '@/lib/types';
import type { ChatZeroSuggestion } from '../chat-api';

/** A chip: what it shows and the follow-up question it sends. */
export interface ZeroChip {
  label: string;
  question: string;
}

/** The follow-up question a suggestion label asks (engine label → plain question). */
export function suggestionQuestion(label: string): string {
  const text = label.trim();
  const low = text.toLowerCase();
  if (low === 'all time') return 'Show the same for all time';
  if (low === 'all sources') return 'Show the same across all sources';
  if (low === 'any severity') return 'Show the same for any severity';
  if (low.startsWith('without the ')) return `Show the same ${low}`;
  if (low.startsWith('last ')) return `Show the same for the ${low}`;
  if (low.startsWith('this ')) return `Show the same for ${low}`;
  return `Show the same for ${low}`;
}

/** Chips for a set of suggestions (deduplicated by question, at most 4). */
export function zeroChips(suggestions: readonly ChatZeroSuggestion[]): ZeroChip[] {
  const out: ZeroChip[] = [];
  for (const suggestion of suggestions) {
    const question = suggestionQuestion(suggestion.label);
    if (!suggestion.label || out.some((chip) => chip.question === question)) continue;
    out.push({ label: suggestion.label, question });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * The lookups of an answer that matched nothing and kept a stored observation (the
 * step inspector's read carries their suggestions). A failed or refused lookup is not
 * a zero result: its run-log row says why.
 */
export function zeroResultSteps(steps: readonly ChatStep[] | undefined): ChatStep[] {
  return (steps ?? []).filter(
    (step) => step.kind === 'tool' && step.status === 'ok' && step.rows === 0 && !!step.observation_ref,
  );
}

/** Follow-ups that a chip already offers are not shown twice (case-insensitive). */
export function withoutChipQuestions(followUps: readonly string[], chips: readonly ZeroChip[]): string[] {
  if (!chips.length) return [...followUps];
  const asked = new Set(chips.map((chip) => chip.question.toLowerCase()));
  return followUps.filter((text) => !asked.has(text.trim().toLowerCase()));
}
