/**
 * The risk score explainer (Round 16 SPEC §4.5 WP11; research explainability §3 and R2).
 *
 * Wraps the shown score. The hover line is the weighted sum with the real numbers, from
 * the inputs recorded at scoring (`risk_breakdown.inputs`); the click panel shows each
 * factor's arithmetic, the weights in force, the rounding and the band. For a case scored
 * before the inputs were recorded it says so, and on first open it reads the stage
 * timeline's reconstruction with today's weights, labelled as such, with the mismatch
 * note when today's weights do not reproduce the score.
 *
 * `variant="row"` is the mouse-only hover card for a queue row (S11): no focusable content,
 * no request; the row's accessible name carries the score.
 */
import * as React from 'react';

import { ExplainTrigger } from '@/design-system/explain';
import { explainRiskScore } from '@/lib/explain/risk';
import type { RiskBreakdown } from '@/lib/types';
import { getCaseStages, type StageRiskCalculation } from '@/soc/pages/CaseDetail.api';

export interface RiskExplainProps {
  caseId: string;
  score: number | null | undefined;
  breakdown: RiskBreakdown | null | undefined;
  children: React.ReactNode;
  variant?: 'row';
}

/** The risk stage's read-time calculation, or null when the timeline has none. */
async function loadCalculation(caseId: string): Promise<StageRiskCalculation | null> {
  const response = await getCaseStages(caseId);
  const stage = (response?.stages ?? []).find((s) => s.kind === 'risk');
  return stage?.state?.risk_calculation ?? null;
}

export const RiskExplain: React.FC<RiskExplainProps> = ({ caseId, score, breakdown, children, variant }) => {
  const [calculation, setCalculation] = React.useState<StageRiskCalculation | null>(null);
  const requested = React.useRef<string | null>(null);
  const recorded = Boolean(breakdown?.inputs);

  React.useEffect(() => {
    setCalculation(null);
    requested.current = null;
  }, [caseId]);

  const explanation = React.useMemo(
    () => explainRiskScore({ score, breakdown, calculation: recorded ? null : calculation }),
    [score, breakdown, calculation, recorded],
  );

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open || recorded || variant === 'row' || !caseId || requested.current === caseId) return;
      requested.current = caseId;
      const forCase = caseId;
      void loadCalculation(forCase)
        .then((next) => {
          if (requested.current === forCase) setCalculation(next);
        })
        .catch(() => undefined);
    },
    [caseId, recorded, variant],
  );

  return (
    <ExplainTrigger
      explanation={explanation}
      mode={variant === 'row' ? 'row-hover' : 'interactive'}
      onOpenChange={onOpenChange}
    >
      {children}
    </ExplainTrigger>
  );
};
