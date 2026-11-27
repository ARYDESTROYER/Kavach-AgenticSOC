/**
 * Follow-up back-off (Round 13, SPEC-chat §4.2): per viewer, in this browser only.
 *
 * After 5 answers in a row whose follow-up chips were shown and none was used, an answer
 * offers only its first chip; any use resets the count and restores three. An answer
 * counts once, when the NEXT fresh answer's chips appear while its own went unused (an
 * answer written in this session, never a restored thread opened to read). Server-side
 * back-off is deferred (SPEC-chat §9).
 *
 * Storage: `localStorage` key `soc.chat.followups.ignored`, a small integer. Every access
 * is in try/catch (a private window, blocked site data, or no storage at all), and the
 * chips render correctly without it (three chips). No question text is ever stored.
 */
import * as React from 'react';

export const FOLLOW_UPS_IGNORED_KEY = 'soc.chat.followups.ignored';
/** Answers in a row with unused chips before only the first chip shows. */
export const FOLLOW_UPS_BACKOFF_AFTER = 5;
/** Chips an answer offers normally and after back-off. */
export const FOLLOW_UPS_MAX = 3;
export const FOLLOW_UPS_BACKED_OFF = 1;

/** The fresh answer whose chips were shown last and are not used yet (this tab only). */
let pendingAnswer: string | null = null;
const listeners = new Set<() => void>();

function readCount(): number {
  try {
    const raw = window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 0;
  } catch {
    return 0;
  }
}

function writeCount(n: number): void {
  try {
    if (n <= 0) window.localStorage.removeItem(FOLLOW_UPS_IGNORED_KEY);
    else window.localStorage.setItem(FOLLOW_UPS_IGNORED_KEY, String(Math.min(n, 1000)));
  } catch {
    /* no storage: the chips simply never back off */
  }
  listeners.forEach((listener) => listener());
}

/** How many chips an answer offers now (3, or 1 after back-off). */
export function followUpLimit(): number {
  return readCount() >= FOLLOW_UPS_BACKOFF_AFTER ? FOLLOW_UPS_BACKED_OFF : FOLLOW_UPS_MAX;
}

/**
 * A fresh answer's chips are on screen. If another fresh answer's chips were shown before
 * and none was used, that answer counts as ignored.
 */
export function noteFollowUpsShown(answerKey: string): void {
  if (pendingAnswer === answerKey) return;
  if (pendingAnswer !== null) writeCount(readCount() + 1);
  pendingAnswer = answerKey;
}

/** A follow-up chip was used: the count resets and three chips come back. */
export function noteFollowUpUsed(): void {
  pendingAnswer = null;
  writeCount(0);
}

/** Tests only. */
export function resetFollowUpBackoffForTests(): void {
  pendingAnswer = null;
  try {
    window.localStorage.removeItem(FOLLOW_UPS_IGNORED_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The chip limit for one answer, kept current when another answer changes the count. A
 * fresh answer (written in this session) records that its chips were shown; its first
 * render already counts the unused answer before it, so its chips never shrink in view.
 */
export function useFollowUpLimit(answerKey: string, fresh: boolean, shown: boolean): number {
  const count = React.useSyncExternalStore(subscribe, readCount, () => 0);
  const counts = fresh && shown && pendingAnswer !== null && pendingAnswer !== answerKey;
  React.useEffect(() => {
    if (fresh && shown) noteFollowUpsShown(answerKey);
  }, [answerKey, fresh, shown]);
  return (counts ? count + 1 : count) >= FOLLOW_UPS_BACKOFF_AFTER ? FOLLOW_UPS_BACKED_OFF : FOLLOW_UPS_MAX;
}
