/**
 * Team activity's numbers explained (Round 16 FXD2).
 *
 * * The median time to acknowledge lists the sorted times it is taken from (the server
 *   sends the times around the median, `ack_sample_seconds`, and the rank of the first,
 *   `ack_sample_offset`), so the median can be worked again: "(120 + 720) / 2 = 420
 *   seconds, shown as 7m".
 * * People active names who was counted and what they did, because a sign-in counts as
 *   activity while the people table's case work columns leave sign-ins out.
 *
 * Pure: plain data only. A person's name is a text value, never markup (#9). Counts with
 * context, never a ranking or a score (Round 15 SPEC D3.5).
 */
import { count, trimmed } from '@/lib/explain/rounding';
import type { Explanation, ExplanationInput } from '@/lib/explain/types';
import type { PersonActivity, TeamKind, TeamTotals } from '@/lib/types-team';
import { explainTeamAckMedian } from '@/soc/components/metrics-explain/builders';

import { KIND_ORDER, KIND_WORDS, fmtSeconds, personName } from './team-format';

/** The team summary with the run of times around its median (Round 16 FXD2, additive). */
export type TeamTotalsWithTimes = TeamTotals & {
  ack_sample_seconds?: number[];
  ack_sample_offset?: number;
};

/** How many times the median's inputs list, at most, around the middle. */
const LISTED_TIMES = 12;

/** One time as the panel prints it: "2m (120 s)". */
function timeText(seconds: number): string {
  return `${fmtSeconds(seconds) ?? `${trimmed(seconds, 3)}s`} (${trimmed(seconds, 3)} s)`;
}

/**
 * The median time to acknowledge with the times it is taken from. Without the times (an
 * older backend) it is the shared explanation, which names the rule only.
 */
export function explainTeamMedian(team: TeamTotalsWithTimes, shown: string, window: string): Explanation | null {
  const base = explainTeamAckMedian({ medianSeconds: team.median_ack_seconds, samples: team.ack_samples, shown, window });
  if (!base) return null;
  const listed = Array.isArray(team.ack_sample_seconds) ? team.ack_sample_seconds.filter((v) => Number.isFinite(v)) : [];
  const offset = Math.max(0, Math.floor(team.ack_sample_offset ?? 0));
  const n = team.ack_samples;
  if (!listed.length || !(n > 0)) return base;
  const lo = Math.floor((n - 1) / 2);
  const hi = Math.floor(n / 2);
  const a = listed[lo - offset];
  const b = listed[hi - offset];
  if (a === undefined || b === undefined) return base;

  // The listed times: all of them when few, else the ones around the middle.
  const firstShown = Math.max(0, Math.min(listed.length - LISTED_TIMES, lo - offset - Math.floor(LISTED_TIMES / 2) + 1));
  const window_ = listed.slice(firstShown, firstShown + LISTED_TIMES);
  const fromRank = offset + firstShown + 1;
  const toRank = offset + firstShown + window_.length;
  const all = n === window_.length;
  const timesInput: ExplanationInput = {
    key: 'times',
    label: all ? 'The times, in order' : `Times at ranks ${count(fromRank)} to ${count(toRank)} of ${count(n)}`,
    value: window_.map(timeText).join(', '),
    source: 'Server, sorted shortest first',
  };
  const median = n % 2 === 1 ? a : (a + b) / 2;
  const step =
    n % 2 === 1
      ? { label: 'Median', expression: `the time at rank ${count(lo + 1)} of ${count(n)}: ${trimmed(a, 3)} seconds`, result: `${trimmed(median, 4)} seconds, shown as ${shown}` }
      : {
          label: 'Median',
          expression: `ranks ${count(lo + 1)} and ${count(hi + 1)} of ${count(n)}: (${trimmed(a, 3)} + ${trimmed(b, 3)}) / 2`,
          result: `${trimmed(median, 4)} seconds, shown as ${shown}`,
        };
  return {
    ...base,
    inputs: [...base.inputs, timesInput],
    steps: [step],
    caveats: all ? base.caveats : [`Showing ${count(window_.length)} of ${count(n)} times, the ones around the median.`, ...base.caveats],
  };
}

/** A person's counted actions in words: "1 acknowledged, 1 commented, 3 sign-ins". */
function actionsInWords(counts: Record<TeamKind, number>): string {
  return KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${count(counts[k])} ${KIND_WORDS[k].toLowerCase()}`)
    .join(', ');
}

/** How many people the panel names, at most. */
const LISTED_PEOPLE = 20;

/**
 * People active: the people with at least one counted action in the window, sign-ins
 * included. Null when the people list does not give the server's count (then the tile
 * keeps its number without a claim the Console cannot back).
 */
export function explainPeopleActive(people: readonly PersonActivity[], total: number, window: string): Explanation | null {
  const counted = people.filter((p) => p.kind !== 'unattributed' && KIND_ORDER.some((k) => (p.counts[k] ?? 0) > 0));
  if (counted.length !== total) return null;
  const listed = counted.slice(0, LISTED_PEOPLE);
  const actions = (p: PersonActivity) => KIND_ORDER.reduce((sum, k) => sum + (p.counts[k] ?? 0), 0);
  const signInOnly = counted.filter((p) => KIND_ORDER.every((k) => k === 'signed_in' || !(p.counts[k] ?? 0))).length;
  const caveats = [
    'A sign-in counts as activity, so a person who only signed in is active. The people table\'s case work leaves sign-ins out.',
    'Work that names no person (Not attributed) is not a person and is not counted.',
  ];
  if (counted.length > listed.length) caveats.unshift(`Showing ${count(listed.length)} of ${count(counted.length)} people.`);
  return {
    metric: 'team_people_active',
    title: 'People active',
    value: total,
    display: count(total),
    summary: `${count(total)} ${total === 1 ? 'person' : 'people'} with at least one counted action, ${window}${signInOnly ? `; ${count(signInOnly)} of them only signed in` : ''}.`,
    formula: 'people with at least one counted action in the window, sign-ins included',
    inputs: [
      ...listed.map((p, i) => ({
        key: `person_${i}`,
        label: personName(p),
        value: `${count(actions(p))} counted ${actions(p) === 1 ? 'action' : 'actions'}`,
        source: actionsInWords(p.counts),
      })),
      { key: 'window', label: 'Window', value: window, source: 'The range above' },
    ],
    steps: [{ label: 'Count', expression: `${count(counted.length)} ${counted.length === 1 ? 'person' : 'people'} listed above`, result: count(total) }],
    provenance: 'server_computed',
    provenanceNote: "Counted by the server from the window's audit rows.",
    caveats,
  };
}
