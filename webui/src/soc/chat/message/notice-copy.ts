/**
 * Notice copy (Round 12 SPEC D2, D3, D5, D9): what each turn notice is called, how it
 * reads, how loud it is and which outcome word (if any) the meta row leads with.
 *
 * Pure functions over the normalised notice (an engine template, never model text):
 *
 *   - A limit is never presented as an incomplete answer. `cap`, the time limit and the
 *     output limit exist only in the operator's `bounded` mode; their callout says what
 *     happened, but the meta row no longer leads with "Partial" (that word is kept for a
 *     true failure: a lookup or a model call that failed, or a continuation that stalled).
 *   - The daily AI budget never pauses chat (D5). A `budget` notice on a chat answer is
 *     the optional chat spending cap ("Today's chat spending limit…") or, on an older
 *     answer, the AI budget; the title names which, and an answer that was already being
 *     written ("…so this answer stops here") reads as a warning, not a failure.
 *   - `limited` (D9): data lookups ran, part of the question is beyond them.
 *   - `unsupported` names a console page only when one resolved.
 *   - `compacted` (D4) is a quiet line, never a callout.
 */
import type { TurnNotice, TurnNoticeKind } from '@/lib/types';

export type NoticeTone = 'warning' | 'critical' | 'info' | 'neutral';

/** The meta row's leading outcome word. */
export type TurnOutcomeWord = 'Stopped' | 'Partial' | 'Failed' | 'Needs input';

export const NOTICE_TITLE: Record<TurnNoticeKind, string> = {
  partial: 'Partial answer',
  cap: 'Answer limit reached',
  budget: 'AI budget reached',
  provider: 'The model could not answer',
  breaker: 'The model is paused after repeated failures',
  denied: 'Some lookups were not allowed',
  timeout: 'The answer ran out of time',
  cancelled: 'Stopped',
  unsupported: 'Not something this assistant can do',
  not_saved: 'Not saved',
  limited: 'Answered with what chat can read',
  stopped_repeating: 'Stopped repeating the same lookup',
  compacted: 'Earlier messages were summarised to keep going',
};

export const NOTICE_TONE: Record<TurnNoticeKind, NoticeTone> = {
  partial: 'warning',
  cap: 'info',
  budget: 'critical',
  provider: 'critical',
  breaker: 'critical',
  denied: 'info',
  timeout: 'info',
  cancelled: 'neutral',
  unsupported: 'info',
  not_saved: 'warning',
  limited: 'info',
  stopped_repeating: 'info',
  compacted: 'neutral',
};

/** Notice kinds that render as the top-of-answer callout. */
export const CALLOUT_NOTICE_KINDS: ReadonlySet<TurnNoticeKind> = new Set<TurnNoticeKind>([
  'partial',
  'cap',
  'denied',
  'timeout',
  'provider',
  'breaker',
  'cancelled',
  'unsupported',
  'budget',
  'limited',
  'stopped_repeating',
]);

/** The body an `unsupported` notice gets when no console page resolved (D9). */
export const UNSUPPORTED_NO_LINK = 'Chat has no lookup for this data yet.';
/** The optional chat spending cap (D5), as the engine words it. */
const CHAT_CAP_RE = /chat spending limit/i;
/** "…so this answer stops here": the answer was already being written. */
const CUT_RE = /stops here/i;
/** The bounded-mode output-limit template ("Answer cut at the output limit"). */
const OUTPUT_LIMIT_RE = /output limit/i;

/**
 * The part of `message` that does not repeat `title` ("Stopped repeating the same
 * lookup; the answer uses…" under the title "Stopped repeating the same lookup" reads
 * "The answer uses…"). `null` when nothing is left to say.
 */
export function noticeBody(title: string, message: string): string | null {
  const text = message.trim();
  if (!text || text === title) return null;
  if (text.toLowerCase().startsWith(title.toLowerCase())) {
    const rest = text.slice(title.length).replace(/^[\s;:,.—–-]+/, '').trim();
    if (!rest) return null;
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return text;
}

export interface NoticeViewContext {
  /** Answer text is shown under the notice (a cut answer, not a D1 failure). */
  answered?: boolean;
  /** At least one console page resolved for an `unsupported` answer. */
  hasConsoleLink?: boolean;
}

export interface NoticeView {
  title: string;
  /** The sentence under the title (never a repeat of it); `null` for none. */
  body: string | null;
  tone: NoticeTone;
  /** A quiet one-line note instead of a callout. */
  quiet: boolean;
}

/** How one notice reads (title, body, tone, loudness). */
export function noticeView(notice: TurnNotice, context: NoticeViewContext = {}): NoticeView {
  const message = notice.message ?? '';
  let title = NOTICE_TITLE[notice.kind] ?? NOTICE_TITLE.partial;
  let tone = NOTICE_TONE[notice.kind] ?? 'warning';
  let body: string | null;
  switch (notice.kind) {
    case 'budget': {
      if (CHAT_CAP_RE.test(message)) title = 'Chat spending limit reached';
      if (context.answered || CUT_RE.test(message)) tone = 'warning';
      body = noticeBody(title, message);
      break;
    }
    case 'unsupported':
      body = context.hasConsoleLink ? noticeBody(title, message) : UNSUPPORTED_NO_LINK;
      break;
    case 'partial':
      if (OUTPUT_LIMIT_RE.test(message)) {
        title = 'Answer cut at the output limit';
        tone = 'info';
      }
      body = noticeBody(title, message);
      break;
    default:
      body = noticeBody(title, message);
  }
  return { title, body, tone, quiet: notice.kind === 'compacted' };
}

/**
 * The meta row's outcome word for a settled answer, or `null`. Limits never earn
 * "Partial" (D2/D3): only a real failure does. A budget notice is "Failed" only when
 * nothing was answered (D1); the chat cap cutting an answer short is said by its callout.
 */
export function outcomeWord(notice: TurnNotice | null | undefined, { answered = false }: { answered?: boolean } = {}): TurnOutcomeWord | null {
  if (!notice) return null;
  switch (notice.kind) {
    case 'cancelled':
      return 'Stopped';
    case 'partial':
      return OUTPUT_LIMIT_RE.test(notice.message ?? '') ? null : 'Partial';
    case 'provider':
    case 'breaker':
      return 'Failed';
    case 'budget':
      return answered ? null : 'Failed';
    default:
      return null;
  }
}
