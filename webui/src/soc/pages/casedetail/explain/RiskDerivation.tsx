/**
 * The risk score's weighted-sum table (Round 16 SPEC §4.5 WP11, extracted from
 * `StageTimeline` so the Timeline's "Risk assigned" stage and the risk explainer share
 * it).
 *
 * Reads the stage timeline's `risk_calculation`: each stored factor, its weight and its
 * points. With weights recorded at scoring (`weight_basis: recorded_at_scoring`) the
 * table is the recorded arithmetic; otherwise it is a read-time reconstruction with
 * today's weights, and a score that today's weights do not reproduce says so plainly
 * without being rewritten.
 *
 * SECURITY (#9): factor labels and numbers are our own; nothing here renders source data.
 */
import * as React from 'react';
import { Calculator } from 'lucide-react';

import { DASH, humanizeToken } from '@/lib/format';
import { displayScore } from '@/lib/explain/rounding';
import { RISK_FACTOR_LABELS } from '@/lib/explain/risk';

import type { StageRiskFactor, StageStep, TimelineStage } from '@/soc/pages/CaseDetail.api';

function preciseNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return DASH;
  return String(Number(value.toFixed(digits)));
}

function factorLabel(factor: string, label?: string): string {
  return label || RISK_FACTOR_LABELS[factor as keyof typeof RISK_FACTOR_LABELS] || humanizeToken(factor);
}

/** Backward-compatible extraction for stage payloads created before risk_calculation. */
export function legacyRiskFactors(steps: StageStep[]): StageRiskFactor[] {
  const found = new Map<string, StageRiskFactor>();
  const pattern = /(asset[_ ]criticality|volume|velocity|reputation|diversity)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/gi;
  for (const step of steps) {
    if (!step.trusted || !/risk\s+factors?/i.test(step.label)) continue;
    for (const match of step.body.matchAll(pattern)) {
      const factor = match[1].toLowerCase().replace(' ', '_');
      const value = Number(match[2]);
      if (!Number.isFinite(value) || found.has(factor)) continue;
      found.set(factor, {
        factor,
        label: factorLabel(factor),
        value,
        weight: Number.NaN,
        weighted_value: Number.NaN,
        contribution: Number.NaN,
      });
    }
  }
  return [...found.values()];
}

/** True when the stage's weights are the ones recorded when the case was scored. */
export function weightsRecorded(basis: unknown): boolean {
  return basis === 'recorded_at_scoring';
}

export const RiskDerivation: React.FC<{ stage: TimelineStage }> = ({ stage }) => {
  const calculation = stage.state.risk_calculation;
  const factors = calculation?.factors?.length ? calculation.factors : legacyRiskFactors(stage.steps);
  const displayed =
    displayScore(calculation?.displayed_score ?? calculation?.recorded_score ?? stage.state.risk_score ?? 0) ?? 0;
  const recorded = weightsRecorded(calculation?.weight_basis);
  const derivationTitle = calculation?.matches_displayed_score
    ? `How ${displayed}/100 was derived`
    : `Risk score details · ${displayed}/100`;

  return (
    <section
      className="mt-3 max-w-4xl border border-border bg-surface-sunken p-4"
      aria-labelledby={`risk-derivation-${stage.id || 'stage'}`}
      data-testid="risk-derivation"
    >
      <div className="flex items-center gap-2">
        <Calculator className="h-4 w-4 text-medium-text" aria-hidden />
        <h4 id={`risk-derivation-${stage.id || 'stage'}`} className="text-sm font-semibold text-foreground">
          {derivationTitle}
        </h4>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Each factor is a stored 0 to 100 input. Contribution = value × weight ÷ the total weight.
      </p>

      {factors.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">Risk score factor calculation</caption>
            <thead>
              <tr className="border-b border-border text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-2 py-2 font-medium">Factor</th>
                <th scope="col" className="px-2 py-2 font-medium">Value</th>
                <th scope="col" className="px-2 py-2 font-medium">Weight</th>
                <th scope="col" className="px-2 py-2 font-medium">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((factor) => {
                const share =
                  calculation && calculation.denominator ? (factor.weight / calculation.denominator) * 100 : Number.NaN;
                return (
                  <tr key={factor.factor} className="border-b border-border/70 last:border-0">
                    <th scope="row" className="px-2 py-2 font-medium text-foreground">
                      {factorLabel(factor.factor, factor.label)}
                    </th>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {preciseNumber(factor.value, 2)}/100
                    </td>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {Number.isFinite(factor.weight) ? `${preciseNumber(factor.weight)} (${preciseNumber(share, 2)}%)` : DASH}
                    </td>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {Number.isFinite(factor.contribution) ? `${preciseNumber(factor.contribution)} pts` : DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {calculation ? (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs leading-relaxed">
          <p className="font-mono text-foreground/90" data-testid="risk-formula">
            Σ(value × weight) = {preciseNumber(calculation.numerator)}; {preciseNumber(calculation.numerator)} ÷{' '}
            {preciseNumber(calculation.denominator)} = {preciseNumber(calculation.calculated_score)}/100, shown as{' '}
            {displayed}/100 (rounded half up).
          </p>
          <p className="text-muted-foreground" data-testid="risk-weight-basis">
            {recorded
              ? 'Weights shown are the ones recorded when this case was scored.'
              : 'Weights shown are the current configured weights used by this read-time reconstruction.'}
          </p>
          {!recorded && !calculation.matches_displayed_score ? (
            <p className="text-warning-text" role="note">
              The current weights calculate {preciseNumber(calculation.calculated_score)}/100, while this case records{' '}
              {preciseNumber(calculation.recorded_score)}/100. This case was scored before its weights were recorded, so
              the difference cannot be attributed exactly; the configuration may have changed since it was scored. The
              recorded score has not been rewritten.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground" role="note">
          {factors.length
            ? 'This older timeline payload supplies factor values and the final score, but not the configured weights or weighted contributions. Exact arithmetic cannot be reconstructed from the available data.'
            : 'This older timeline payload supplies the final score, but no factor values, configured weights, or weighted contributions. Exact arithmetic cannot be reconstructed from the available data.'}
        </p>
      )}
    </section>
  );
};
