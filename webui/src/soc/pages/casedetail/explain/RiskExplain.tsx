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
import { explainRiskScore, recordedRiskInputs, type AssetRangeReading } from '@/lib/explain/risk';
import type { RiskBreakdown } from '@/lib/types';
import { getCaseStages, type StageRiskCalculation } from '@/soc/pages/CaseDetail.api';

export interface RiskExplainProps {
  caseId: string;
  score: number | null | undefined;
  breakdown: RiskBreakdown | null | undefined;
  children: React.ReactNode;
  variant?: 'row';
  /**
   * Today's internal network range that holds the entity (the triage read's
   * `asset_cidr`, sent only to a person who may read the settings).
   */
  assetRange?: AssetRangeReading | null;
}

/** The risk stage's read-time calculation, or null when the timeline has none. */
async function loadCalculation(caseId: string): Promise<StageRiskCalculation | null> {
  const response = await getCaseStages(caseId);
  const stage = (response?.stages ?? []).find((s) => s.kind === 'risk');
  return stage?.state?.risk_calculation ?? null;
}

/** The read of today's weights for a case scored before its inputs were recorded. */
type ReadState = 'idle' | 'loading' | 'done' | 'failed';

/** What the panel says while the read runs, or after it failed (never a silent wait). */
const READ_NOTE: Partial<Record<ReadState, string>> = {
  loading: "Reading today's weights from the case timeline.",
  failed: "The case timeline could not be read, so the calculation with today's weights is not shown.",
};

export const RiskExplain: React.FC<RiskExplainProps> = ({ caseId, score, breakdown, children, variant, assetRange }) => {
  const [calculation, setCalculation] = React.useState<StageRiskCalculation | null>(null);
  const [read, setRead] = React.useState<ReadState>('idle');
  const requested = React.useRef<string | null>(null);
  // Recorded only when the inputs have the recorded shape: a partial object reads as not
  // recorded, so today's reconstruction is still read for it.
  const recorded = recordedRiskInputs(breakdown) !== null;

  React.useEffect(() => {
    setCalculation(null);
    setRead('idle');
    requested.current = null;
  }, [caseId]);

  const explanation = React.useMemo(() => {
    const base = explainRiskScore({ score, breakdown, calculation: recorded ? null : calculation, assetRange });
    const note = recorded ? undefined : READ_NOTE[read];
    return base && note ? { ...base, caveats: [...base.caveats, note] } : base;
  }, [score, breakdown, calculation, recorded, read, assetRange]);

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open || recorded || variant === 'row' || !caseId || requested.current === caseId) return;
      requested.current = caseId;
      const forCase = caseId;
      setRead('loading');
      void loadCalculation(forCase)
        .then((next) => {
          if (requested.current !== forCase) return;
          setCalculation(next);
          setRead('done');
        })
        .catch(() => {
          if (requested.current === forCase) setRead('failed');
        });
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
