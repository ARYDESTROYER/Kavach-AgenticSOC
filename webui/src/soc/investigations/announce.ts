/**
 * Polite announcements for AI runs (Round 16 SPEC §4.5 WP09): at most one every 10 s.
 * A change that arrives sooner waits for the 10 s mark and then says the latest state,
 * so the last word (a finished run) is never lost. Through the app's one live region
 * (`useAnnouncer`); plain text only (#9).
 *
 * The end of a run is said once on a console (FXB). Two other surfaces may say it: the
 * case page's finish toast (`ReinvestigateDialog.tsx`) and a close dialog's finished note
 * (`AiRunCloseNotice.tsx`). Each marks the run here (`noteRunEnd`), and the header chip
 * leaves its own end announcement out for a run already said. The chip waits a moment
 * before it says an end (`END_GRACE_MS`), and longer while the page reads the case to
 * decide on its toast (`'pending'`), so the toast is not beaten to it.
 *
 * The close and status dialogs also mark the cases their note covers while they are open
 * (`holdRunNotice`), so the case page shows no finish toast over the dialog: its note
 * already says the run finished.
 */
import * as React from 'react';

import { useAnnouncer } from '@/soc/components/announcer';

export const ANNOUNCE_EVERY_MS = 10_000;
/** How long an end announcement waits for the toast or a dialog note to say it first. */
export const END_GRACE_MS = 1000;
/** The longest it waits while the page reads the case to decide on its toast. */
export const END_WAIT_MS = 10_000;
const END_RECHECK_MS = 250;
const END_KEEP = 64;

/** Run ids whose end another surface says (`'said'`) or may say once a read lands (`'pending'`). */
const endSaid = new Map<string, 'pending' | 'said'>();

/** Mark how a run's end is said elsewhere on this console; `null` forgets it. */
export function noteRunEnd(runId: string | null | undefined, state: 'pending' | 'said' | null): void {
  if (!runId) return;
  endSaid.delete(runId);
  if (!state) return;
  endSaid.set(runId, state);
  if (endSaid.size > END_KEEP) endSaid.delete(endSaid.keys().next().value as string);
}

/** Whether another surface says a run's end (`'said'`), may say it soon (`'pending'`), or not. */
export function runEndSaid(runId: string | null | undefined): 'pending' | 'said' | null {
  return runId ? endSaid.get(runId) ?? null : null;
}

/** Cases a close or status dialog's run note covers while it is open (a count per case). */
const notices = new Map<string, number>();

/** Mark `caseIds` as covered by an open dialog's run note. Returns the release. */
export function holdRunNotice(caseIds: readonly string[]): () => void {
  const ids = [...new Set(caseIds.filter(Boolean))];
  for (const id of ids) notices.set(id, (notices.get(id) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    for (const id of ids) {
      const left = (notices.get(id) ?? 1) - 1;
      if (left > 0) notices.set(id, left);
      else notices.delete(id);
    }
  };
}

/** Whether an open close or status dialog's run note covers `caseId`. */
export function runNoticeOpen(caseId: string | null | undefined): boolean {
  return Boolean(caseId && notices.has(caseId));
}

/** Forget every mark (tests only). */
export function resetRunEndMarksForTests(): void {
  endSaid.clear();
  notices.clear();
}

/**
 * Say `message` politely, at most once every `everyMs`. `endOf` names the run whose end
 * `message` says: it is then said only if no other surface says that end.
 */
export function useThrottledAnnouncement(
  message: string,
  everyMs = ANNOUNCE_EVERY_MS,
  endOf: string | null = null,
): void {
  const announce = useAnnouncer();
  const last = React.useRef(-Infinity);
  const said = React.useRef('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!message || message === said.current) return undefined;
    const giveUpAt = Date.now() + END_WAIT_MS;
    const speak = () => {
      timer.current = null;
      const elsewhere = runEndSaid(endOf);
      if (elsewhere === 'pending' && Date.now() < giveUpAt) {
        timer.current = setTimeout(speak, END_RECHECK_MS);
        return;
      }
      last.current = Date.now();
      said.current = message;
      // Said by the toast or the dialog's note: counted as said, never said twice.
      if (elsewhere !== 'said') announce(message, 'polite');
    };
    const wait = Math.max(last.current + everyMs - Date.now(), endOf ? END_GRACE_MS : 0);
    if (wait <= 0) speak();
    else timer.current = setTimeout(speak, wait);
    return undefined;
  }, [message, everyMs, announce, endOf]);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}
