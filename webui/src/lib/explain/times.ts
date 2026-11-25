/**
 * The case clock explanations (Round 16 SPEC §4.5 WP11; research explainability R6).
 *
 * The inspector's Times section shows one computed number: the time to detect, from the
 * case's first member event to its opening, the per-case input of the posture MTTD. This
 * module states that subtraction with the two stored instants.
 *
 * Pure: plain data only (#9). Advisory: never feeds `decide()` (#3).
 */
import { trimmed } from './rounding';
import type { Explanation } from './types';

/**
 * The time to detect a case: opened minus the first member event. `display` is the value
 * the inspector shows ("4m"). Null when either instant is missing or unreadable, or the
 * case opened before its first event (the posture metrics leave such a case out too).
 */
export function explainTimeToDetect(
  firstEventAt: string | null | undefined,
  openedAt: string | null | undefined,
  display: string,
): Explanation | null {
  if (!firstEventAt || !openedAt) return null;
  const first = Date.parse(firstEventAt);
  const opened = Date.parse(openedAt);
  if (Number.isNaN(first) || Number.isNaN(opened) || opened < first) return null;
  const minutes = (opened - first) / 60_000;
  return {
    metric: 'time_to_detect',
    title: 'Time to detect',
    value: minutes,
    display,
    summary: `Time to detect ${display}: from the case's first event to the moment it opened.`,
    formula: 'time the case opened - time of its first member event',
    inputs: [
      { key: 'first_event', label: 'First event', value: firstEventAt, source: 'The earliest member event of the case' },
      { key: 'opened', label: 'Opened', value: openedAt, source: 'When the case was created' },
    ],
    steps: [{ label: 'Difference', expression: `${openedAt} - ${firstEventAt}`, result: `${trimmed(minutes)} minutes` }],
    rounding: 'Under a minute it is shown in seconds; otherwise in minutes, hours and days.',
    provenance: 'recorded',
    provenanceNote: 'Both times are stored on the case.',
    caveats: ["The dashboards' time to detect (MTTD) is the median of this value across cases."],
  };
}
