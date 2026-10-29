/**
 * Number words for the board widgets (Round 14, SPEC §4.4.3): the few formatting rules
 * every panel shares, so a count, a change, a share or a spend reads the same everywhere
 * and never claims less (or more) than the source said. Pure, no React.
 */
import { DASH, fmtDuration, fmtMoney, fmtNumber } from '@/lib/format';

/**
 * A count with its noun, singular for exactly one: "1 case", "12 cases", "1 analyst
 * review". `many` defaults to the noun plus "s".
 */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}

/**
 * A signed change in minutes for a comparison chip: "+18m", "-1h 5m", "+<1m" for a real
 * change under a minute, and "0m" only for no change at all (never a bare "<1m", which
 * reads as a figure, not a change).
 */
export function signedDuration(minutes: number): string {
  if (minutes === 0) return '0m';
  return `${minutes > 0 ? '+' : '-'}${fmtDuration(Math.abs(minutes))}`;
}

/** The smallest amount the money format shows (four decimals below one unit). */
const MONEY_FLOOR = 0.0001;

/**
 * A spend figure: a real but tiny amount reads "<$0.0001", never "$0.0000", which would
 * read as no spend at all; an exact zero reads as plain money ("$0.00"), like the other
 * amounts beside it, never with the four places a fraction of a cent needs.
 */
export function moneyText(value: number, currency?: string): string {
  // The money format gives amounts below one unit four places; a zero needs two. The
  // last two fraction digits are "00" in every locale's digits this format emits.
  if (value === 0) return fmtMoney(0, currency).replace(/00$/, '');
  if (value > 0 && value < MONEY_FLOOR / 2) return `<${fmtMoney(MONEY_FLOOR, currency)}`;
  return fmtMoney(value, currency);
}

/**
 * A share in 0..1 as a whole percent. A real but tiny share reads "<1%", never "0%", and
 * a share short of the whole reads ">99%", never "100%" (which would claim all of it).
 */
export function shareText(fraction: number): string {
  if (!Number.isFinite(fraction)) return DASH;
  return percentText(fraction * 100);
}

/**
 * A percent in 0..100 as a whole percent, by the same rule as {@link shareText}: "<1%"
 * for a real but tiny percent, ">99%" for one short of 100.
 */
export function percentText(pct: number): string {
  if (!Number.isFinite(pct)) return DASH;
  const rounded = Math.round(pct);
  if (pct > 0 && rounded === 0) return '<1%';
  if (pct < 100 && rounded >= 100) return '>99%';
  return `${rounded}%`;
}

/** The share `part / whole` as a whole percent ({@link shareText}), or '' with no whole. */
export function shareOf(part: number, whole: number): string {
  return whole > 0 && Number.isFinite(part) ? shareText(part / whole) : '';
}

/** A time of day for a freshness line ("14:02"), in the viewer's locale and zone. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}
