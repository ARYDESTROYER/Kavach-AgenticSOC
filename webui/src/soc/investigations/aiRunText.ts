/**
 * The words for a case's AI investigation run (Round 16 SPEC §4.5 WP09, S2). Pure
 * functions with no imports beyond types. Never "Investigating" alone: that word is the
 * human acknowledged status (`CaseStatus.INVESTIGATING`).
 */
import type { InvestigationView } from '@/lib/types';

/** "40 seconds", "1 minute", "3 hours". */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  const [n, unit] =
    seconds < 60 ? [seconds, 'second'] : seconds < 3600 ? [Math.floor(seconds / 60), 'minute'] : [Math.floor(seconds / 3600), 'hour'];
  return `${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`;
}

/** "0:42", "12:05", "1:02:09": the time since `fromIso`, ticking each second. */
export function elapsedClock(fromIso: string | null | undefined, now: number): string {
  const from = Date.parse(fromIso || '');
  const total = Number.isFinite(from) ? Math.max(0, Math.floor((now - from) / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The words a screen reader hears for a case's run, appended to the queue row's
 * accessible name (the row joins its parts with ", "): "AI investigation running,
 * started 40 seconds ago" or "AI investigation waiting, queued 12 seconds ago". `null`
 * when there is no run (or it finished).
 */
export function aiRunAccessibleText(view: InvestigationView | null, now: number): string | null {
  if (!view || view.state === 'finished') return null;
  const running = view.state === 'running';
  const since = Date.parse((running ? view.started_at : view.queued_at) || '');
  const when = Number.isFinite(since) ? `, ${running ? 'started' : 'queued'} ${spokenDuration(now - since)} ago` : '';
  return `AI investigation ${running ? 'running' : 'waiting'}${when}`;
}
