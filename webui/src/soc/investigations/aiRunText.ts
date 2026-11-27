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
 * accessible name (the row joins its parts with ", "): "AI investigation running" or
 * "AI investigation waiting". `null` when there is no run (or it finished). No elapsed
 * time: the row is drawn again only when its run changes (a frame comes at the start, when
 * the case is attached and at the end), so a time in the name would stay at "1 second"
 * for the whole run, and a name that ticks would make a focused row read itself again.
 * The header chip shows the clock and its popover says how long the run has gone on.
 */
export function aiRunAccessibleText(view: InvestigationView | null): string | null {
  if (!view || view.state === 'finished') return null;
  return `AI investigation ${view.state === 'running' ? 'running' : 'waiting'}`;
}
