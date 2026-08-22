/**
 * Shared, pure formatting helpers for the posture dashboards (Round 3 / Feature 5).
 *
 * These read the server-side posture rollup (StatBlock + CompareBlock shapes) and turn
 * them into render-ready primitives for KPI tiles + delta badges. Kept framework-free
 * and co-located so the Metrics + Overview pages share one honest interpretation of
 * the "labelled DASH" + "delta%" conventions the backend emits.
 *
 * The backend marks a missing stat with a DASH string ("—") and a `reason`; we honour
 * that (never a fake 0). A delta_pct may be a number, the DASH string, or `null`
 * ("new growth" — prior window was 0).
 */
import { DASH } from '@/lib/format';
import type { CompareBlock, StatBlock } from './Metrics.posture.api';

// --------------------------------------------------------------------------- //
// Lifecycle-timing copy — the SINGLE honest source of MTTA / MTTR / Dwell labels
// --------------------------------------------------------------------------- //

/** The three lifecycle-timing intervals the backend rollup exposes, keyed to the
 * `lifecycle_intervals` StatBlocks (`mtta_minutes` / `mttr_minutes` / `dwell_minutes`). */
export type LifecycleMetricKey = 'mtta' | 'mttr' | 'dwell';

interface LifecycleMetricCopy {
  /** Short KPI-tile label (the acronym). */
  label: string;
  /** Plain-English expansion for the tile sub-line / column sub-title. */
  sub: string;
  /** One-sentence formula help (what interval is measured), grounded verbatim in
   * `backend/app/engine/metrics.py::lifecycle_intervals`. */
  help: string;
}

/**
 * The ONE honest source of the lifecycle-timing copy shared by the Overview
 * ("Cyber Defence Center") + Metrics posture surfaces. It mirrors exactly what
 * `engine/metrics.py::lifecycle_intervals` measures — no invented "MTTD".
 *
 * The backend measures each interval from case CREATION (or the explicit detection
 * anchor when populated) to a status-history transition, and reports p50 / p90 / mean:
 *   • MTTA  → first ACK transition (investigating / escalated / on-hold).
 *   • MTTR  → first TERMINAL transition (resolved / closed).
 *   • Dwell → first RESPONSE transition (investigating / escalated / on-hold /
 *             resolved / closed) — i.e. time-to-first-response.
 *
 * ⚠ Dwell is deliberately NOT labelled "MTTD" (mean-time-to-detect): we do not measure
 * log-arrival→detection latency, so surfacing it as detection time would be dishonest.
 * The backend has NO `mttd` key (locked by `test_posture_has_no_mttd_field`).
 */
export const LIFECYCLE_METRICS: Record<LifecycleMetricKey, LifecycleMetricCopy> = {
  mtta: {
    label: 'MTTA',
    sub: 'Time to acknowledge',
    help: 'Median (p50) time from case creation — or detection when known — to the first analyst acknowledgement (the case entering investigating, escalated, or on-hold).',
  },
  mttr: {
    label: 'MTTR',
    sub: 'Time to resolve',
    help: 'Median (p50) time from case creation — or detection when known — to the first terminal transition (resolved or closed).',
  },
  dwell: {
    label: 'Dwell',
    sub: 'Time to first response',
    help: 'Median (p50) time from case creation — or detection when known — to the first active response (investigating, escalated, on-hold, resolved, or closed). This is time-to-first-response, not time-to-detect.',
  },
};

/** The short KPI label for a lifecycle metric (e.g. `'mtta'` → `"MTTA"`). */
export function kpiLabel(key: LifecycleMetricKey): string {
  return LIFECYCLE_METRICS[key].label;
}

/** True when a value is a finite number we can render/compute on. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Humanize a minutes value to a compact duration ("Xd Yh" / "Xh Ym" / "Xm"). A
 * non-numeric input (e.g. the backend DASH string) passes through as DASH.
 */
export function humanizeMinutes(mins: number | string | null | undefined): string {
  if (!isNum(mins) || mins < 0) return DASH;
  if (mins < 1) return '<1m';
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** A 0..1 ratio rendered as a whole-number percent; DASH for non-numbers. */
export function ratioPct(v: number | string | null | undefined): string {
  if (!isNum(v)) return DASH;
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)}%`;
}

/** The p50 of a StatBlock as a humanized duration, honouring the unavailable DASH. */
export function statP50Duration(block: StatBlock | undefined): string {
  if (!block || !block.available) return DASH;
  return humanizeMinutes(block.p50);
}

export interface DeltaView {
  /** Signed delta value (drives arrow + color), or undefined when there is none. */
  value?: number;
  /** Pre-formatted label (e.g. "+12%", "—", "new"). */
  label: string;
  /** When false, render NO delta badge (no comparison was available). */
  show: boolean;
}

/**
 * Interpret a CompareBlock's `delta_pct` into a render-ready delta view.
 *
 * * a number → "+N%" / "-N%" with the TRUE signed `value` (positive = rose).
 * * `null`   → "new" (prior window was 0; growth undefined) — shown, but with NO
 *   numeric value so the tile draws no misleading arrow.
 * * DASH / undefined → no badge (no honest comparison to draw).
 *
 * The returned `value` is the literal signed change; whether a rise or a fall is GOOD
 * is now the KpiTile's `goodDirection` prop (Round-5 bug #2 fix — the ARROW follows the
 * true sign, the COLOR follows judgement). Callers pass `goodDirection="down"` for
 * lower-is-better metrics (MTTA/MTTR, FP rate, escalation) instead of pre-flipping here.
 */
export function deltaView(block: CompareBlock | undefined): DeltaView {
  if (!block) return { label: DASH, show: false };
  const d = block.delta_pct;
  if (d === null) return { label: 'new', show: true };
  if (!isNum(d)) return { label: DASH, show: false };
  const rounded = Math.round(d * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return {
    value: rounded,
    label: `${sign}${rounded}%`,
    show: rounded !== 0,
  };
}

/** Render the absolute current value of a CompareBlock (number or DASH). */
export function compareValue(
  block: CompareBlock | undefined,
  fmt: (n: number) => string,
): string {
  if (!block || !isNum(block.value)) return DASH;
  return fmt(block.value);
}
