/**
 * `gauge.active_risk` "Active risk index" (Round 5 / G7; Round 14, SPEC §4.4.3): the
 * mean risk of the cases open right now, on the Cyber Defence Center's gauge, with the
 * critical threshold marked ("74 and above is critical"). The gauge explains itself
 * (Round 16, WP16): hover for the mean over the open cases, click for the sum and count
 * the server read (`GET /api/metrics/explain?metric=active_risk_index`) and how a case's
 * risk is scored with the weights in force. Numeric only (#9); advisory (#3).
 */
import { count, trimmed } from '@/lib/explain/rounding';
import type { Explanation } from '@/lib/explain/types';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { MetricExplain } from '@/soc/components/metrics-explain/MetricExplain';

import { statNumber, useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { WidgetShell, countOf, requestState, resolveTitle, staleOf, type WidgetProps, type WidgetState } from './common';

/** The critical band starts here (the Overview's Active Risk Index notch). */
export const CRITICAL_RISK = 74;

const METRICS_REQ: DashboardRequest = { key: 'metrics' };

/**
 * The Active risk index before its explanation is read: the mean on screen over the open
 * cases (`MetricExplain` replaces it with the server's sum and count on open).
 */
export function activeRiskInitial(score: number, open: number | null): Explanation {
  const cases = open === null ? 'the open cases' : `${count(open)} open case${open === 1 ? '' : 's'}`;
  return {
    metric: 'active_risk_index',
    title: 'Active risk index',
    value: score,
    display: trimmed(score, 1),
    summary: `Mean risk ${trimmed(score, 1)} over ${cases}.`,
    formula: "sum of the open cases' risk scores / the number of open cases",
    inputs: open === null ? [] : [{ key: 'open', label: 'Open cases', value: count(open), source: 'Server count' }],
    steps: [],
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server over the cases open now.',
    caveats: [],
  };
}

export function RiskGaugeWidget(props: WidgetProps) {
  const answer = useDashboardRequest({ key: 'metrics' });
  const data = answer.data;
  const title = resolveTitle(props, 'Active risk index');
  const { retry } = useDashboardData();
  const score = statNumber((data?.active_risk_index as number | string | undefined) ?? null);
  const open = statNumber((data?.active_risk_case_count as number | string | undefined) ?? null);
  const onRetry = () => retry(METRICS_REQ);
  let state: WidgetState | null = requestState(answer, onRetry);
  // The server answers a mean of 0 over zero open cases: an empty set has no mean, so
  // that is "nothing to score", never a gauge at 0.
  if (!state && (score == null || open === 0)) state = { kind: 'empty', title: 'No open cases to score right now' };
  return (
    <WidgetShell
      title={title}
      caption="Open now · mean risk"
      exit={{ label: 'View open cases', page: 'cases', opts: { status: '__active__' } }}
      state={state}
      stale={staleOf(answer, onRetry)}
    >
      <div className="flex flex-col items-center justify-center gap-2 py-2">
        {/* No label under the value: the caption names the measure, and the gauge's
            accessible name falls back to "Risk 59". */}
        {score != null ? (
          <MetricExplain metric="active_risk_index" title={title} windowHours={0} initial={activeRiskInitial(score, open)}>
            <RiskGauge score={score} notch={CRITICAL_RISK} />
          </MetricExplain>
        ) : (
          <RiskGauge score={0} notch={CRITICAL_RISK} />
        )}
        <p className="text-sm text-muted-foreground">
          {open != null ? `${countOf(open, 'open case')} · ` : ''}
          {CRITICAL_RISK} and above is critical
        </p>
      </div>
    </WidgetShell>
  );
}
