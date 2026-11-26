/**
 * A dashboard mean or share you can hover and click (Round 16 SPEC §4.5 WP12 and WP16):
 * the Active risk index (the mean risk of the cases open now) and SLA attainment (the
 * share of scored cases that met their targets).
 *
 * Wraps the shown figure in the Explain trigger. Hover or focus gives the one-line reading
 * of the figure on screen; a click, Enter, Space or tap opens the panel and reads the
 * figure's own explanation once (`GET /api/metrics/explain?metric=`): its sum or count on
 * top, its count below, the cases it counts and the window. For the Active risk index the
 * panel also says how a case's risk is scored, with the weights in force (an operator's
 * `prefs.risk_weights`, research explainability D7), read once with the explanation.
 *
 * Lazy-only (it imports the Explain kit): rendered by dashboard widgets, never by an
 * entry module. Every value is our own number or copy, a text node (#9); advisory (#3).
 */
import * as React from 'react';

import { ExplainTrigger } from '@/design-system/explain';
import { api } from '@/lib/api';
import { getMetricExplain } from '@/lib/api-metrics-explain';
import { count, trimmed } from '@/lib/explain/rounding';
import type { Explanation } from '@/lib/explain/types';
import type { MetricExplainResponse } from '@/lib/types-metrics-explain';
import { useOptionalAuth } from '@/soc/auth';
import { activeRiskHelpText, type RiskWeightSet } from '@/soc/components/riskCopy';

import { explainKpiShare, linkFromHash, nounFor } from './builders';

/** The figures this trigger explains. */
export type ServerFigureMetric = 'active_risk_index' | 'sla_attainment';

/** The panel note while the figure's cases are read, and when they could not be. */
export const FIGURE_READING = 'Reading the cases behind this figure.';
export const FIGURE_READ_FAILED = 'The cases behind this figure could not be read.';

/** The panel's caveats from the server's own notes on the population it read. */
function populationCaveats(data: MetricExplainResponse): string[] {
  const out: string[] = [];
  if (data.population) out.push(`Cases counted: ${data.population}`);
  if (data.truncated) {
    out.push(`Computed over the newest ${count(data.fetched)} of ${count(data.store_total)} cases.`);
  }
  if (!data.available && data.reason) out.push(`Not measured: ${data.reason}.`);
  return out;
}

/**
 * The Active risk index explained from `GET /api/metrics/explain?metric=active_risk_index`:
 * the sum of the open cases' risk scores over their count. Null without a response.
 */
export function explainActiveRisk(data: MetricExplainResponse | null, title = 'Active risk index'): Explanation | null {
  if (!data) return null;
  const sum = typeof data.numerator === 'number' ? data.numerator : null;
  const open = typeof data.denominator === 'number' ? data.denominator : null;
  const value = typeof data.value === 'number' ? data.value : null;
  const measured = data.available && value !== null && sum !== null && open !== null && open > 0;
  return {
    metric: 'active_risk_index',
    title,
    value,
    display: value === null ? 'Not measured' : trimmed(value, 1),
    summary: measured
      ? `Mean risk ${trimmed(value, 1)} over ${count(open)} ${nounFor(open, 'open cases')}: ${trimmed(sum, 2)} / ${count(open)}.`
      : 'No case is open, so there is no index.',
    formula: "sum of the open cases' risk scores / the number of open cases",
    inputs: [
      { key: 'sum', label: 'Sum of the risk scores', value: sum === null ? 'Not recorded' : trimmed(sum, 2), source: 'Server' },
      { key: 'open', label: 'Open cases', value: open === null ? 'Not recorded' : count(open), source: 'Server count' },
      { key: 'window', label: 'Window', value: data.window || 'all time', source: 'Every case open now' },
    ],
    steps: measured ? [{ label: 'Mean', expression: `${trimmed(sum, 2)} / ${count(open)}`, result: trimmed(value, 1) }] : [],
    rounding: 'The server rounds the mean to one decimal.',
    provenance: 'server_computed',
    provenanceNote: 'Computed by the server over the cases open now.',
    caveats: populationCaveats(data),
    link: linkFromHash('Open cases', '#/cases?status=__active__'),
  };
}

/**
 * SLA attainment explained from `GET /api/metrics/explain?metric=sla_attainment`: the
 * cases that met their targets over the cases scored against one. Null without a response.
 */
export function explainSlaAttainment(data: MetricExplainResponse | null, title = 'SLA attainment'): Explanation | null {
  if (!data) return null;
  const share = explainKpiShare({
    metric: 'sla_attainment',
    title,
    numerator: data.numerator,
    denominator: data.denominator,
    numeratorLabel: 'cases that met their targets',
    denominatorLabel: 'scored cases',
    window: data.window || 'the window',
    dividedBy: 'server',
    caveats: populationCaveats(data),
  });
  if (!share) return null;
  return { ...share, formula: 'cases that met every target / cases scored against a target' };
}

export interface MetricExplainProps {
  metric: ServerFigureMetric;
  /** The figure's name, for example "Active risk index". */
  title: string;
  /** The window the figure covers, in hours (0, or ignored, for all time). */
  windowHours: number;
  /** The hover line and panel before the figure's explanation is read (the figure on screen). */
  initial: Explanation | null;
  /** The shown figure. */
  children: React.ReactNode;
  className?: string;
}

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; data: MetricExplainResponse; weights: Partial<RiskWeightSet> | null }
  | { state: 'failed' };

export function MetricExplain({ metric, title, windowHours, initial, children, className }: MetricExplainProps) {
  // Outside an auth context (a widget preview), the settings are not read.
  const auth = useOptionalAuth();
  const [load, setLoad] = React.useState<Load>({ state: 'idle' });
  const abortRef = React.useRef<AbortController | null>(null);
  const loadedKey = React.useRef<string | null>(null);
  const loadKey = `${metric}|${windowHours}`;
  React.useEffect(() => () => abortRef.current?.abort(), []);
  const canReadSettings = Boolean(auth?.hasPermission('settings', 'read'));

  const fetchFigure = React.useCallback(() => {
    if (loadedKey.current === loadKey) return;
    loadedKey.current = loadKey;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoad({ state: 'loading' });
    // The weights in force, for the risk index's scoring sentence (defaults when unread).
    const weights =
      metric === 'active_risk_index' && canReadSettings
        ? Promise.resolve(api.getSettings()).then(
            (s) => (s?.prefs?.risk_weights as Partial<RiskWeightSet> | undefined) ?? null,
            () => null,
          )
        : Promise.resolve(null);
    Promise.all([getMetricExplain(metric, windowHours, controller.signal), weights]).then(
      ([data, live]) => {
        if (!controller.signal.aborted) setLoad({ state: 'done', data, weights: live });
      },
      () => {
        if (controller.signal.aborted) return;
        loadedKey.current = null;
        setLoad({ state: 'failed' });
      },
    );
  }, [canReadSettings, loadKey, metric, windowHours]);

  const data = load.state === 'done' ? load.data : null;
  const explanation = React.useMemo(() => {
    const read = metric === 'active_risk_index' ? explainActiveRisk(data, title) : explainSlaAttainment(data, title);
    return read ?? initial;
  }, [data, initial, metric, title]);
  if (!explanation) return <>{children}</>;

  const weights = load.state === 'done' ? load.weights : null;
  const detail = (
    <div className="space-y-1.5" data-testid="metric-explain-detail">
      {load.state === 'loading' ? <p className="text-muted-foreground">{FIGURE_READING}</p> : null}
      {load.state === 'failed' ? <p className="text-muted-foreground">{FIGURE_READ_FAILED}</p> : null}
      {metric === 'active_risk_index' && load.state === 'done' ? (
        <p className="leading-relaxed text-foreground/90" data-testid="metric-explain-risk-help">
          {activeRiskHelpText(weights)}
          {weights ? '' : ' These are the default weights: the settings in force could not be read.'}
        </p>
      ) : null}
    </div>
  );

  return (
    <span className={className} data-metric-explain={metric}>
      <ExplainTrigger
        explanation={explanation}
        detail={detail}
        onOpenChange={(open) => {
          if (open) fetchFigure();
        }}
      >
        {children}
      </ExplainTrigger>
    </span>
  );
}
