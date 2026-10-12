/**
 * Report window statements, each window ONCE (Round 12 SPEC §7.2 decision 29; the
 * mirror of `routes_reports._merge_windows`, which stores new item scopes merged).
 *
 * One answer's lookups can label the same window differently: the case aggregates
 * "all time (since 28 Sep 2026)", a case list "all time" and the AI usage "all time
 * (since 12 Oct 2026)". They are one all-time window and read "all time (since 28 Sep
 * 2026)", from the earliest data. A relative window read both rolling and in whole days
 * ("last 90 days", "last 90 days (since 15 Jul 2026)") reads once, with the start its
 * breakdowns state; two different starts of one relative window keep the shared phrase
 * only. A comparison of a window that is also stated reads inside it ("last 90 days
 * (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 08:02"). Reports saved before
 * the server merged their scopes are merged here on read.
 */

const SINCE_WINDOW_RE = /^(.+?) \(since ([^()]+)\)( \([^()]+\))?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The trailing "and 2 more" the backend adds to a scope over its bound (`_join_windows`). */
export const MORE_WINDOWS_RE = /^and \d+ more$/;

/** The day a "since" detail names ("28 Sep 2026", "Nov 2025", "28 Sep 2026, UTC"), as a sortable number. */
function sinceDay(since: string): number | null {
  const head = since.split(',', 1)[0].trim();
  const day = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(head);
  const month = day ? null : /^([A-Z][a-z]{2}) (\d{4})$/.exec(head);
  const parts = day ? { d: Number(day[1]), m: day[2], y: Number(day[3]) } : month ? { d: 1, m: month[1], y: Number(month[2]) } : null;
  if (!parts) return null;
  const index = MONTHS.indexOf(parts.m);
  return index < 0 ? null : Date.UTC(parts.y, index, parts.d);
}

/** Each window stated once, in the order the windows first appear. */
export function mergeWindows(windows: readonly string[]): string[] {
  const groups = new Map<string, Array<[string, string]>>();
  for (const window of windows) {
    const match = SINCE_WINDOW_RE.exec(window);
    if (!match) {
      if (!groups.has(window)) groups.set(window, []);
      continue;
    }
    const [, base, since, zone = ''] = match;
    const details = groups.get(base) ?? [];
    if (!details.some(([s, z]) => s === since && z === zone)) details.push([since, zone]);
    groups.set(base, details);
  }
  const merged: string[] = [];
  for (const [base, details] of groups) {
    let chosen: [string, string] | null = null;
    if (details.length === 1) chosen = details[0];
    else if (details.length && base === 'all time') {
      const dated = details.map((detail) => [sinceDay(detail[0]), detail] as const);
      if (dated.every(([day]) => day !== null)) {
        chosen = dated.reduce((best, next) => ((next[0] as number) < (best[0] as number) ? next : best))[1];
      }
    }
    merged.push(chosen ? `${base} (since ${chosen[0]})${chosen[1]}` : base);
  }
  return foldComparisons(merged);
}

/**
 * How a comparison caption joins its periods (`periods.comparison_caption`), and how a
 * scope states one it has folded into its subject.
 */
const COMPARED_SEPARATOR = ' vs ';
const COMPARED_WITH = ', compared with ';

/** The window's phrase without its start, and whether it states one. */
function windowBase(window: string): [string, boolean] {
  const match = SINCE_WINDOW_RE.exec(window);
  return match ? [match[1], true] : [window, false];
}

/**
 * Is `window` the comparison subject `subject`, under the merge rule above: the same
 * text, or one phrase with and without its start; two different starts are not.
 */
function sameWindow(subject: string, window: string): boolean {
  if (subject === window) return true;
  const [a, aDated] = windowBase(subject);
  const [b, bDated] = windowBase(window);
  return a === b && !(aDated && bDated);
}

/** "B, C and D" as ["B", "C", "D"], never split inside brackets (a zone or a start). */
function splitPeriods(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    if (depth === 0) {
      const sep = [' and ', ', '].find((s) => text.startsWith(s, index));
      if (sep) {
        parts.push(current);
        current = '';
        index += sep.length;
        continue;
      }
    }
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')' && depth) depth -= 1;
    current += char;
    index += 1;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** [subject, compared periods] of a comparison window, raw ("A vs B") or already folded ("A, compared with B"). */
function comparison(window: string): [string, string[]] | null {
  const raw = window.indexOf(COMPARED_SEPARATOR);
  if (raw >= 0) {
    return [window.slice(0, raw), window.slice(raw + COMPARED_SEPARATOR.length).split(COMPARED_SEPARATOR).filter(Boolean)];
  }
  const folded = window.indexOf(COMPARED_WITH);
  if (folded >= 0) return [window.slice(0, folded), splitPeriods(window.slice(folded + COMPARED_WITH.length))];
  return null;
}

function andList(parts: readonly string[]): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface WindowEntry {
  text: string;
  subject: string;
  periods: string[];
  comparison: boolean;
  kept: boolean;
  changed: boolean;
  position: number;
}

/**
 * A comparison window whose subject is also stated reads once, inside it: "last 90
 * days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 08:02", never the same
 * phrase twice; so do two comparisons of one subject, each period once. A scope that
 * already reads that way (another item's) merges the same way, so the report header
 * states the window once. A comparison whose subject is not stated on its own is kept.
 */
function foldComparisons(windows: readonly string[]): string[] {
  const entries: WindowEntry[] = windows.map((window, position) => {
    const compared = comparison(window);
    return {
      text: window,
      subject: compared ? compared[0] : window,
      periods: compared ? [...compared[1]] : [],
      comparison: compared !== null,
      kept: true,
      changed: false,
      position,
    };
  });
  entries.forEach((entry, index) => {
    if (!entry.comparison) return;
    const target =
      entries.find((other) => other !== entry && other.kept && !other.comparison && sameWindow(entry.subject, other.text)) ??
      entries.slice(0, index).find((other) => other.kept && other.comparison && other.subject === entry.subject);
    if (!target) return;
    for (const period of entry.periods) if (!target.periods.includes(period)) target.periods.push(period);
    target.changed = true;
    // Where the window was first stated, comparison or not.
    target.position = Math.min(target.position, entry.position);
    entry.kept = false;
  });
  return entries
    .filter((entry) => entry.kept)
    .sort((a, b) => a.position - b.position)
    .map((entry) =>
      entry.changed && entry.periods.length
        ? `${entry.comparison ? entry.subject : entry.text}${COMPARED_WITH}${andList(entry.periods)}`
        : entry.text,
    );
}

/** A stored item scope's window line ("…; …; and 2 more") with each window stated once. */
export function mergeScopeWindow(window: string | null | undefined): string | null {
  if (!window) return window ?? null;
  const parts = window.split('; ');
  const more = parts.filter((part) => MORE_WINDOWS_RE.test(part.trim()));
  const windows = parts.filter((part) => !MORE_WINDOWS_RE.test(part.trim()));
  return [...mergeWindows(windows), ...more].join('; ');
}
