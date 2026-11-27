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

/**
 * A label as it reads mid-sentence: its first word loses its capital ("Without" →
 * "without") unless that word is an acronym ("IP"), and every other word keeps the
 * label's own case ("source IP", "Open and closed cases" → "open and closed cases").
 */
function midSentence(text: string): string {
  const first = text.split(/\s/, 1)[0] ?? '';
  const acronym = first.length > 1 && first === first.toUpperCase() && first !== first.toLowerCase();
  return acronym ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The follow-up question a suggestion label asks (engine label → plain question). The
 * prefixes match case-insensitively; the rest of the label is kept as written, so
 * "Without the source IP filter" asks "Show the same without the source IP filter"
 * (the engine's `chat_followups.suggestion_question` builds the same words).
 */
export function suggestionQuestion(label: string): string {
  const text = label.trim();
  const low = text.toLowerCase();
  if (low === 'all time') return 'Show the same for all time';
  if (low === 'all sources') return 'Show the same across all sources';
  if (low === 'any severity') return 'Show the same for any severity';
  const lead = midSentence(text);
  if (low.startsWith('without the ')) return `Show the same ${lead}`;
  if (low.startsWith('last ')) return `Show the same for the ${lead}`;
  return `Show the same for ${lead}`;
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

/**
 * Chips a follow-up does not already offer (case-insensitive). The chips arrive AFTER the
 * answer (one read of the stored observation), so they never take anything away from
 * what is already on screen: a follow-up the analyst may be about to click stays, and a
 * chip asking the same question is the one left out (no content swap, no layout shift).
 */
export function chipsNotInFollowUps(chips: readonly ZeroChip[], followUps: readonly string[]): ZeroChip[] {
  if (!followUps.length) return [...chips];
  const offered = new Set(followUps.map((text) => text.trim().toLowerCase()));
  return chips.filter((chip) => !offered.has(chip.question.toLowerCase()));
}
