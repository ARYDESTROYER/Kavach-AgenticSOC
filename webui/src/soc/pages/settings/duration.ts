/**
 * Plain readings of a stored duration for Settings help lines (Round 14, SPEC §4.9.5 and
 * §4.9.6: numbers carry their unit and a reading such as "(24 hours)", so nobody has to do
 * the arithmetic on "1440 min" or "21600 s").
 *
 * Pure and dependency-free apart from the number formatter; every Settings section that
 * shows a duration in a small unit uses it, so the readings are worded one way.
 */
import { fmtNumber } from '@/lib/format';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * A plain reading of a duration in seconds ("24 hours", "3 days", "15 minutes"), or ''
 * when it is not a whole number of minutes, hours or days. Days are used from two days
 * up (a day reads as "24 hours", the way people say a daily window).
 *
 * `above` (seconds) keeps the reading to units larger than the field's own: a field in
 * minutes passes 60, so "15 min" gets no reading ("15 minutes" would only repeat it)
 * while "1440 min" reads "24 hours".
 */
export function durationReading(seconds: number | null | undefined, above = 0): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const plural = (n: number, word: string) => `${fmtNumber(n)} ${word}${n === 1 ? '' : 's'}`;
  let unit = 0;
  let text = '';
  if (seconds % DAY === 0 && seconds >= 2 * DAY) {
    unit = DAY;
    text = plural(seconds / DAY, 'day');
  } else if (seconds % HOUR === 0) {
    unit = HOUR;
    text = plural(seconds / HOUR, 'hour');
  } else if (seconds % MINUTE === 0) {
    unit = MINUTE;
    text = plural(seconds / MINUTE, 'minute');
  }
  return unit > above ? text : '';
}

/**
 * A minute count as people say it: a reading in hours or days when it is a whole number
 * of them ("4 hours", "3 days"), else the minutes themselves ("15 minutes").
 */
export function minutesReading(minutes: number): string {
  const reading = durationReading(minutes * MINUTE, MINUTE);
  if (reading) return reading;
  return `${fmtNumber(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** A help sentence with the reading in brackets before its full stop, when there is one. */
export function withReading(help: string, reading: string): string {
  if (!reading) return help;
  const body = help.endsWith('.') ? help.slice(0, -1) : help;
  return `${body} (${reading}).`;
}
