/**
 * Standup's numbers explained (Round 16 FXD2).
 *
 * Every figure the shift handoff shows gets a hover line with its inputs and a click panel
 * whose arithmetic gives the figure exactly: the strip counts against the window before,
 * the SLA pressure counts and each case's "over" line, the analysts' open work and the age
 * of a case in the attention queue. The risk chip uses the case explainer (`RiskExplain`).
 * The numbers are the server's shift snapshot (`GET /api/standup/report`); the Console
 * only subtracts and adds them.
 *
 * Pure: plain data only. Every case-derived string (an assignee name) stays a text value
 * (#9). Advisory: nothing here feeds a decision (#3).
 */
import { explainSla, type SlaReadingWire } from '@/lib/explain/sla';
import { count, plain } from '@/lib/explain/rounding';
import { minutesText } from '@/lib/explain/times';
import type { Explanation, ExplanationInput, ExplanationStep } from '@/lib/explain/types';
import { fmtDuration, fmtOverage } from '@/lib/format';

import type { AttentionRow, DeltaCell, SlaAging, SlaAgingRow, WorkloadRow } from './Standup.report.api';

/** What each strip count counts. */
export const STRIP_COUNTS: Record<string, string> = {
  open: 'open cases: New, Open, Awaiting analyst, Investigating, Escalated or On hold',
  needs_human_verdict: 'open cases whose AI verdict is Needs human',
  needs_human: 'open cases in the Awaiting analyst status',
  escalated: 'open cases in the Escalated status',
  unassigned: 'open cases with no assignee',
  sla_breached: 'open cases past their response target',
};

/** A signed change: "+3", "-2", "±0". */
function signed(delta: number): string {
  if (delta === 0) return '±0';
  return delta > 0 ? `+${count(delta)}` : `-${count(Math.abs(delta))}`;
}

const SNAPSHOT_NOTE = 'Counted by the server when the shift snapshot was generated.';

/**
 * One strip count against the window before: "Open: 15 now; 10 of them were created
 * before the last 24 hours; 15 - 10 = +5". The tile's "was" figure is the server's
 * stand-in for the window before: the same count over today's open cases that were
 * created before the window began. It is not a count taken back then, so it never says
 * "at the start of the window": a case that was open then and has closed since is not in
 * it (FXD2 review).
 */
export function explainStripCount(key: string, label: string, cell: DeltaCell, range: string): Explanation {
  const counts = STRIP_COUNTS[key] ?? 'open cases';
  const change = cell.current - cell.prior;
  return {
    metric: `standup_${key}`,
    title: label,
    value: cell.current,
    display: count(cell.current),
    summary: `${label}: ${count(cell.current)} now; ${count(cell.prior)} of them were created before the ${range}; ${count(cell.current)} - ${count(cell.prior)} = ${signed(change)}.`,
    formula: 'change = count now - the same count over the open cases created before the window',
    inputs: [
      { key: 'now', label: 'Now', value: count(cell.current), source: `Counted over the ${counts}` },
      {
        key: 'before',
        label: 'Created before the window',
        value: count(cell.prior),
        source: `The same count over the open cases created before the ${range}`,
      },
      { key: 'window', label: 'Window', value: range, source: 'The range above' },
    ],
    steps: [{ label: 'Change', expression: `${count(cell.current)} - ${count(cell.prior)}`, result: signed(change) }],
    provenance: 'server_computed',
    provenanceNote: SNAPSHOT_NOTE,
    caveats: [
      'The "was" figure is not a count taken when the window began. It counts the cases open now that were created before the window, so a case that has closed since is in neither count.',
    ],
  };
}

const SLA_TOTAL: Record<'open' | 'breached' | 'about_to_breach', { title: string; counts: string; caveat: string }> = {
  open: {
    title: 'Open',
    counts: 'open cases',
    caveat: 'Every open case is counted under its priority. A case without a priority is counted as unprioritized.',
  },
  breached: {
    title: 'Breached',
    counts: 'open cases past their response target',
    caveat: 'A case is breached once its response clock passes its priority\'s target. A late response stays breached.',
  },
  about_to_breach: {
    title: 'At risk',
    counts: 'open cases whose response clock still runs and has used at least {share} of its target',
    caveat: 'Only cases whose priority has a response target are classified.',
  },
};

/** One SLA pressure count as the sum of its priorities: "P4 5 + P3 5 = 10". */
export function explainSlaTotal(kind: 'open' | 'breached' | 'about_to_breach', sla: SlaAging): Explanation | null {
  const total = sla.totals?.[kind];
  if (typeof total !== 'number') return null;
  const meta = SLA_TOTAL[kind];
  const parts = Object.entries(sla.by_priority ?? {})
    .map(([priority, bucket]) => [priority, Number(bucket?.[kind] ?? 0)] as const)
    .filter(([, n]) => Number.isFinite(n))
    .sort(([a], [b]) => a.localeCompare(b));
  const sum = parts.reduce((acc, [, n]) => acc + n, 0);
  const words = (priority: string) => (priority === 'unprioritized' ? 'No priority' : priority);
  const steps: ExplanationStep[] =
    parts.length && sum === total
      ? [{ label: 'Sum', expression: parts.map(([p, n]) => `${words(p)} ${count(n)}`).join(' + '), result: count(total) }]
      : [];
  const counts = meta.counts.replace('{share}', `${Math.round((sla.warn_fraction ?? 0.8) * 100)}%`);
  return {
    metric: `standup_sla_${kind}`,
    title: `SLA ${meta.title.toLowerCase()}`,
    value: total,
    display: count(total),
    summary: `${count(total)} ${counts}${steps.length ? `: ${steps[0].expression}` : ''}.`,
    formula: 'the sum of the counts per priority',
    inputs: parts.map(([p, n]) => ({ key: `priority_${p}`, label: words(p), value: count(n), source: 'Server count' })),
    steps,
    provenance: 'server_computed',
    provenanceNote: SNAPSHOT_NOTE,
    caveats: [meta.caveat, 'Measured now, not limited by the range above.'],
  };
}

/**
 * How far past its target a breached row is, as the line shows it: the clock's elapsed
 * minutes minus the target when the server sends them (the same numbers the explanation
 * prints), else the server's rounded overage.
 */
export function slaRowOverMinutes(row: SlaAgingRow): number {
  if (typeof row.elapsed_minutes === 'number' && Number.isFinite(row.elapsed_minutes)) {
    return Math.round((Number(plain(row.elapsed_minutes)) - Number(plain(row.target_minutes))) * 100) / 100;
  }
  return row.overdue_minutes;
}

/** Whole minutes as "12 days, 15 hours and 18 minutes" (the parts the line rounds from). */
function partsInWords(minutes: number): string {
  const total = Math.round(Math.max(0, minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  const units = [
    [days, 'day'],
    [hours, 'hour'],
    [rest, 'minute'],
  ] as const;
  const words = units.filter(([n]) => n > 0).map(([n, unit]) => `${count(n)} ${unit}${n === 1 ? '' : 's'}`);
  if (!words.length) return '0 minutes';
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The step that turns a number of minutes into the line's words: the whole minutes and
 * their parts ("17,548 whole minutes: 12 days, 4 hours and 28 minutes", shown as
 * "12d 4h"), or, under a minute, the "<1m" the line prints.
 */
function shownStep(from: string, minutes: number, shown: string): ExplanationStep {
  if (minutes < 1) return { label: 'Shown', expression: `${from} is under a minute`, result: shown };
  return {
    label: 'Shown',
    expression: `${from} rounds to ${count(Math.round(minutes))} whole minutes: ${partsInWords(minutes)}`,
    result: `${shown} (the two largest units)`,
  };
}

const ANCHOR_OF: Record<string, string> = {
  first_response_at: 'acknowledged',
  acknowledged_at: 'acknowledged',
  status_history: 'status_history',
};

/**
 * A breached case's "over" line ("12d 15h over"): the response clock's elapsed time minus
 * its priority's target, from `explainSla`, with the line's own rounding.
 */
export function explainSlaOverage(row: SlaAgingRow, label: string): Explanation | null {
  if (typeof row.elapsed_minutes !== 'number' || !Number.isFinite(row.elapsed_minutes)) return null;
  const stopped = row.running === false;
  const reading: SlaReadingWire = {
    clock: 'response',
    start_at: row.start_at ?? null,
    anchor: stopped ? ANCHOR_OF[row.stop_source ?? ''] ?? 'acknowledged' : 'created',
    responded_at: stopped ? (row.stopped_at ?? null) : null,
    target_minutes: row.target_minutes,
    due_at: row.due_at ?? null,
    elapsed_minutes: row.elapsed_minutes,
    state: 'breached',
    priority: row.priority_level || null,
    priority_source: null,
    running: typeof row.running === 'boolean' ? row.running : null,
    stop_source: row.stop_source ?? null,
  };
  const base = explainSla(reading);
  if (!base) return null;
  const over = slaRowOverMinutes(row);
  const shown = fmtOverage(over);
  const steps = base.steps.map((step) => (step.label === 'Shown' ? shownStep(minutesText(over), over, shown) : step));
  const priority = row.priority_level ? `${row.priority_level} ` : '';
  return {
    ...base,
    metric: 'standup_sla_overage',
    title: `${label} response SLA`,
    value: over,
    display: shown,
    summary: `${label} ${priority}response clock: ${fmtDuration(row.elapsed_minutes)} elapsed against the ${fmtDuration(row.target_minutes)} target, so ${shown}.`,
    steps,
    rounding: 'The line rounds to whole minutes and shows the two largest units (days and hours, or hours and minutes).',
  };
}

/** The workload row's owner in words: the no-owner bucket reads "Unassigned". */
function ownerWords(analyst: string): string {
  const name = (analyst ?? '').trim();
  return !name || name === '(unassigned)' ? 'Unassigned' : name;
}

/** An analyst's open work: "2 escalated + 0 awaiting analyst + 1 other open = 3". */
export function explainWorkload(row: WorkloadRow): Explanation {
  const owner = ownerWords(row.analyst);
  const unassigned = owner === 'Unassigned';
  const other = Math.max(0, row.open - row.escalated - row.needs_human);
  const who = unassigned ? 'Open cases with no assignee' : `Open cases assigned to ${owner}`;
  const inputs: ExplanationInput[] = [
    { key: 'escalated', label: 'Escalated', value: count(row.escalated), source: 'Server count' },
    { key: 'needs_human', label: 'Awaiting analyst', value: count(row.needs_human), source: 'Server count' },
    { key: 'other', label: 'In another open status', value: count(other), source: 'Open minus the two above' },
    { key: 'open', label: 'Open', value: count(row.open), source: 'Server count' },
  ];
  return {
    metric: 'standup_workload',
    title: unassigned ? 'Unassigned open work' : `${owner}'s open work`,
    value: row.open,
    display: count(row.open),
    summary: `${who}: ${count(row.escalated)} escalated + ${count(row.needs_human)} awaiting analyst + ${count(other)} in another open status = ${count(row.open)}.`,
    formula: 'open = escalated + awaiting analyst + in another open status',
    inputs,
    steps: [
      {
        label: 'Open',
        expression: `${count(row.escalated)} + ${count(row.needs_human)} + ${count(other)}`,
        result: count(row.open),
      },
    ],
    provenance: 'server_computed',
    provenanceNote: SNAPSHOT_NOTE,
    caveats: ['The bar compares this count with the busiest owner; it is not a share of anything.'],
  };
}

/**
 * A case's age in the attention queue: the snapshot time minus when the case was detected
 * (or created). Null without the instant the server counted from.
 */
export function explainQueueAge(row: AttentionRow, generatedAt: string | null | undefined): Explanation | null {
  const from = row.age_from_at ?? null;
  const start = from ? Date.parse(from) : Number.NaN;
  const end = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!from || !generatedAt || Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const minutes = (end - start) / 60_000;
  const anchor = row.age_from === 'detected_at' ? 'detected' : 'created';
  const shown = fmtDuration(row.age_minutes);
  return {
    metric: 'standup_age',
    title: 'Age in the queue',
    value: row.age_minutes,
    display: shown,
    summary: `${shown} in the queue: from when the case was ${anchor} to when this snapshot was generated.`,
    formula: `snapshot time - the time the case was ${anchor}`,
    inputs: [
      { key: 'from', label: anchor === 'detected' ? 'Detected' : 'Created', value: from, source: 'Stored on the case' },
      { key: 'generated', label: 'Snapshot generated', value: generatedAt, source: 'The server, for this reading' },
    ],
    steps: [
      { label: 'Difference', expression: `${generatedAt} - ${from}`, result: minutesText(minutes) },
      // The whole minutes the row rounds to and their parts, so "12d 4h" can be worked by
      // hand: 17,548 minutes is 12 days, 4 hours and 28 minutes (FXD2 review). The row
      // shows the server's age, so the parts come from it.
      shownStep(minutesText(minutes), row.age_minutes, shown),
    ],
    rounding: 'Rounded to whole minutes, then shown in its two largest units (days and hours, or hours and minutes).',
    provenance: 'server_computed',
    provenanceNote: SNAPSHOT_NOTE,
    caveats: [],
  };
}
