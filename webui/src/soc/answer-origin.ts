/**
 * Where an in-app view was opened from an answer (Round 14, SPEC §4.6.6 "Back to
 * answer"). A chat answer's drill (a rule sheet, a Logs view, a Cases list) remembers the
 * page the answer was on, so the destination can offer one link straight back to it.
 *
 * Module state, tiny, nothing at import time. What is kept is the exact answer, never the
 * page around it:
 *
 * - In the Chat workspace, the answer's saved conversation and message, as the host hands
 *   them to `AnswerBlocks` (`#/chat?conversationId=…&messageId=…`, built by the router's
 *   own `pageHash`). Without them, the location serves only when it names the open thread
 *   (`#/chat?conversationId=…`; Chat drops one that no longer does). The bare `#/chat`
 *   reopens whichever thread Chat prefers (a running one, an unread one, the newest), so
 *   it is never remembered: nothing is offered rather than a way to another thread.
 * - In Case Manager, the case the location names (`#/case_manager?caseId=…`, whose Chat
 *   tab holds the case answers); a location without a case is nothing to go back to.
 *
 * It is never a URL from data: ids pass the router's id grammar, and the hash is read back
 * through the same grammar before use, so nothing from an answer can steer the link.
 *
 * It is offered for the drill itself only: the view the drill opened, the first location
 * reached from the answer. Any other location (another link opened from that view, a
 * filter changed there, a page from the navigation) is not that view, and coming back to
 * the answer ends it, so a later view never offers a way back to an old answer. The view
 * is compared by its location, not by counting `hashchange` events: the router writes the
 * new location at once but its event arrives a task later, after the page that reads the
 * origin has already rendered.
 */

import { pageHash } from '@/soc/router';

/** How long a remembered answer stays offered (a person reading the drill, then back). */
export const ANSWER_ORIGIN_TTL_MS = 30 * 60_000;

/** The pages an answer lives on, and how the way back reads. */
const ORIGINS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^#\/chat(?:\?[\w.:=&%-]{0,600})?$/, label: 'Back to answer' },
  { pattern: /^#\/case_manager(?:\?[\w.:=&%/ -]{0,600})?$/, label: 'Back to the case' },
];

/** The saved answer a block belongs to (its conversation, and its message when saved). */
export interface AnswerLocation {
  conversationId: string;
  messageId?: string | null;
}

/** The router's conversation and message id grammar (`NAV_ID`). */
const ANSWER_ID = /^[\w.:-]{1,128}$/;
const CHAT_PAGE = /^#\/chat(?:\?|$)/;
const CHAT_THREAD = /^#\/chat\?(?:.*&)?conversationId=[^&]/;
const CASE_PAGE = /^#\/case_manager\?(?:.*&)?caseId=[^&]/;

export interface AnswerOrigin {
  /** The hash to return to (`#/chat?conversationId=…`). */
  hash: string;
  /** "Back to answer" or "Back to the case". */
  label: string;
}

/**
 * The remembered answer: `hash` to go back to, and `landed`, the location the drill
 * opened (null until it is reached).
 */
let remembered: { hash: string; at: number; landed: string | null } | null = null;
let listening = false;

function onHashChange(): void {
  if (!remembered) return;
  const here = window.location.hash || '';
  // Back on the answer (Back, or the link): nothing to go back to any more.
  if (here === remembered.hash) {
    remembered = null;
    return;
  }
  // The first location reached from the answer is the drill's own view; reaching any
  // other one means the person moved on.
  if (remembered.landed === null) remembered.landed = here;
  else if (here !== remembered.landed) remembered = null;
}

function originOf(hash: string): AnswerOrigin | null {
  for (const { pattern, label } of ORIGINS) {
    if (pattern.test(hash)) return { hash, label };
  }
  return null;
}

/**
 * Where "Back to answer" goes for an answer shown at `location`: the answer's own
 * conversation and message in the Chat workspace, the case in Case Manager; null when the
 * exact answer is not known (nothing is better than a link to another thread).
 */
function answerHash(location: string, answer: AnswerLocation | null | undefined): string | null {
  if (CHAT_PAGE.test(location)) {
    if (answer && ANSWER_ID.test(answer.conversationId)) {
      const messageId = answer.messageId && ANSWER_ID.test(answer.messageId) ? answer.messageId : undefined;
      return pageHash('chat', { conversationId: answer.conversationId, messageId });
    }
    return CHAT_THREAD.test(location) ? location : null;
  }
  return CASE_PAGE.test(location) ? location : null;
}

/**
 * Remember the answer, just before a drill leaves it: `answer` is the saved answer the
 * drill belongs to (from `AnswerBlocks`). A page that does not show answers, or a Chat
 * answer whose conversation is unknown, is ignored (nothing to go back to). `now` is for
 * tests.
 */
export function rememberAnswerOrigin(answer?: AnswerLocation | null, now: number = Date.now()): void {
  if (typeof window === 'undefined') return;
  const hash = answerHash(window.location.hash || '', answer);
  remembered = hash && originOf(hash) ? { hash, at: now, landed: null } : null;
  if (remembered && !listening) {
    // Installed on first use only (never at import): it counts the pages reached since.
    window.addEventListener('hashchange', onHashChange);
    listening = true;
  }
}

/**
 * The answer to go back to, for the view the drill opened while it is still fresh; null
 * otherwise. Read where the view is: a location other than the one the drill reached
 * (a later link already written by the router, its event still to come) gets nothing.
 */
export function answerOrigin(now: number = Date.now()): AnswerOrigin | null {
  if (!remembered || now - remembered.at > ANSWER_ORIGIN_TTL_MS) return null;
  if (remembered.landed !== null && (window.location.hash || '') !== remembered.landed) return null;
  return originOf(remembered.hash);
}

/** Forget the answer (the way back was taken, or the person browsed on). */
export function clearAnswerOrigin(): void {
  remembered = null;
}
