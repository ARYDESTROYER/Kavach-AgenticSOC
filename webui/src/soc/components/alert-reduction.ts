/**
 * The Alert reduction rule (Round 14, SPEC §4.4.3): the share of the window's raw alerts
 * that did not become a case, `1 - cases / ingested`, read from the noise-reduction
 * stages (`GET /api/metrics/noise-reduction`).
 *
 * ONE rule for every surface that prints it: the Cyber Defence Center's noise flow
 * (`NoiseFunnel`) and the Detection and data health board's KPI strip both call this,
 * so the two can never disagree about a number or about when to withhold it.
 *
 * It is withheld, with a plain reason, unless the alert counters are available and cover
 * the whole window, the case tally is complete, at least one alert was ingested and the
 * window did not open more cases than it counted alerts. A real but tiny reduction reads
 * "<1%", never a 0% that reads as "none", and one short of the whole reads ">99%". It is
 * never `reduction.overall_pct`, which measures "never reached a person", a different
 * figure.
 *
 * Pure, no React, no network; every input is an aggregate count (#7, #9).
 */
import { DASH } from '@/lib/format';
import type { NoiseReduction } from '@/lib/types';

export interface AlertReduction {
  /** The reduction in percent (0 to 100), or `null` when withheld. */
  value: number | null;
  /** The display text: a whole percent, "<1%", or the dash mark when withheld. */
  text: string;
  /** Why it is withheld (plain words), or `null` when measured. */
  reason: string | null;
}

/** The missing-value mark the noise flow prints in place of a withheld share. */
const WITHHELD_MARK = DASH;

function stageTotal(data: NoiseReduction, key: string): number | null {
  const stage = (data.stages ?? []).find((s) => s && s.key === key);
  if (!stage) return null;
  const total = stage.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/** The share of raw alerts that did not become a case, or why it cannot be stated. */
export function alertReduction(data: NoiseReduction | null | undefined): AlertReduction {
  const withheld = (reason: string): AlertReduction => ({ value: null, text: WITHHELD_MARK, reason });
  if (!data) return withheld('the noise reduction figures could not be read');
  if (!data.counters?.available) return withheld('alert counters are still warming up');
  // Short on purpose: the flow's "Partial coverage" notice explains it in full.
  if (data.counters?.incomplete) return withheld('partial coverage');
  if (data.cases_meta?.truncated) return withheld('case counts are partial for this window');
  const ingested = stageTotal(data, 'ingested');
  const cases = stageTotal(data, 'cases');
  if (ingested == null || cases == null) {
    return withheld('alerts or cases were not reported for this window');
  }
  if (ingested <= 0) return withheld('no alerts were ingested in this window');
  if (cases > ingested) return withheld('this window opened more cases than it counted alerts');
  const value = (1 - cases / ingested) * 100;
  const rounded = Math.round(value);
  // The share rule every board figure follows: a real but tiny reduction is "<1%", never
  // a 0% that reads as none, and one short of the whole is ">99%", never a 100% that
  // claims no alert became a case.
  const text = value > 0 && rounded === 0 ? '<1%' : value < 100 && rounded >= 100 ? '>99%' : `${rounded}%`;
  return { value, text, reason: null };
}
