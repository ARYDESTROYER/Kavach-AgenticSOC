/**
 * `gauge.active_risk` "Active risk index" (Round 5 / G7; Round 14, SPEC §4.4.3): the
 * mean risk of the cases open right now, on the Cyber Defence Center's gauge, with the
 * critical threshold marked ("74 and above is critical"). Numeric only (#9); advisory (#3).
 */
import { RiskGauge } from '@/soc/components/RiskGauge';

import { statNumber, useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { WidgetShell, countOf, requestState, resolveTitle, staleOf, type WidgetProps, type WidgetState } from './common';

/** The critical band starts here (the Overview's Active Risk Index notch). */
export const CRITICAL_RISK = 74;

const METRICS_REQ: DashboardRequest = { key: 'metrics' };

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
        <RiskGauge score={score ?? 0} notch={CRITICAL_RISK} />
        <p className="text-sm text-muted-foreground">
          {open != null ? `${countOf(open, 'open case')} · ` : ''}
          {CRITICAL_RISK} and above is critical
        </p>
      </div>
    </WidgetShell>
  );
}
