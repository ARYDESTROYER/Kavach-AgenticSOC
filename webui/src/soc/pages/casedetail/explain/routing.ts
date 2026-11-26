/**
 * The routing score behind "Why was this investigated?" (Round 16 FXD2).
 *
 * `GET /api/cases/{id}/forwarding` walks the deterministic auto-forward gates again with
 * today's settings. When the walk reached the risk floor it returns the available-signal
 * routing score, the floor, and the terms the score averaged (`routing_terms`: each
 * signal's stored factor and its weight, and `routing_weight_total`). This module prints
 * that arithmetic so it gives the score exactly:
 * "(0.25 x 58.56 + 0.20 x 9.69 + 0.15 x 20) / 0.60 = 32.63".
 *
 * Pure: plain data only, every value a number from the server (#9). Advisory: the gate it
 * describes ran before any verdict, and nothing here decides anything (#3).
 */
import { plain, trimmed } from '@/lib/explain/rounding';
import { weightText } from '@/lib/explain/risk';

/** One term of the routing score, as the forwarding route returns it. */
export interface RoutingTerm {
  factor?: string;
  weight?: number;
  value?: number;
}

/** The forwarding route's routing fields (absent from a build before them). */
export interface RoutingReading {
  routing_total?: number | null;
  risk_floor?: number | null;
  routing_gate_applied?: boolean;
  routing_terms?: RoutingTerm[] | null;
  routing_weight_total?: number | null;
}

/** The sentence every forwarding reading carries: it is not what happened at the time. */
export const TODAY_SETTINGS =
  "This reading uses today's settings, so it can differ from what happened when the case was investigated.";

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Round half up to two decimals, after clearing float noise. */
function halfUp2(value: number): number {
  const clean = Math.round(value * 1e9) / 1e9;
  return Math.floor(clean * 100 + 0.5 + 1e-9) / 100;
}

/**
 * The routing score as arithmetic, or null when the reading has no score. With its terms
 * the line reproduces the score from the printed numbers; without them (an older build)
 * it states the score and the floor only.
 */
export function routingScoreLine(reading: RoutingReading | null | undefined): string | null {
  if (!reading || !finite(reading.routing_total)) return null;
  const total = reading.routing_total;
  const floor = finite(reading.risk_floor) ? reading.risk_floor : null;
  const against =
    floor === null
      ? ''
      : reading.routing_gate_applied === false
        ? `, against a floor of ${trimmed(floor)} (the floor does not apply to these events)`
        : `, against a floor of ${trimmed(floor)}`;
  const terms = (reading.routing_terms ?? []).filter((t) => finite(t.weight) && finite(t.value));
  const weightTotal = finite(reading.routing_weight_total) ? reading.routing_weight_total : null;
  if (terms.length && weightTotal && weightTotal > 0) {
    const sum = terms.reduce((acc, t) => acc + Number(plain(t.weight as number, 4)) * Number(plain(t.value as number)), 0);
    const worked = halfUp2(sum / weightTotal);
    // Only print the arithmetic when it gives the score the server computed.
    if (Math.abs(worked - total) < 0.005) {
      const parts = terms.map((t) => `${weightText(t.weight as number)} x ${plain(t.value as number)}`).join(' + ');
      return `Routing score: (${parts}) / ${weightText(weightTotal)} = ${trimmed(total)}${against}.`;
    }
  }
  return `Routing score ${trimmed(total)}${against}.`;
}
