/**
 * Detection and data health widgets (Round 14, SPEC §4.4.3, §4.4.4):
 *
 * - `chart.noise_funnel` "Noise reduction": raw alerts to cases to outcomes over the
 *   window, on a square-root scale so the last stages stay visible. Its headline is the
 *   shared Alert reduction rule (the Cyber Defence Center's figure, never a second
 *   formula). While row-level scope is on, its case stages are hidden (D16).
 * - `table.noisy_rules` "Noisiest rules": rules whose analyst-graded false-positive rate is
 *   over the tuning target, with their tuning state. Rule tuning state, not case data.
 * - `table.telemetry_gaps` "Telemetry gaps": data the detections asked for that no source
 *   sent, only from recorded query evidence (connector absence alone is never a gap).
 * - `kpi.auto_close_health` "Auto-close health": the agent's first-decision auto-close
 *   rate in the window against the window before, from the append-only decision trail.
 *
 * Read-only; nothing here is an input to `decide()` (#3). Rule ids and field names are
 * untrusted plain text (#9).
 */
import { CircleDashed, ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtNumber, humanizeToken } from '@/lib/format';
import type { NoiseReduction, RecordedAutoCloseHealth } from '@/lib/types';
import { alertReduction } from '@/soc/components/alert-reduction';
import { RuleLink } from '@/soc/components/RuleLink';
import {
  isLedgerRowActive,
  type RuleNoise,
  type TelemetryRecommendationsResponse,
  type TuningRecommendationsResponse,
} from '@/soc/pages/Tuning.api';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import {
  BarRow,
  BoundCount,
  PHONE_ROW_TARGET,
  PanelList,
  PanelListItem,
  PanelRow,
  PanelTable,
  panelFit,
  type PanelColumn,
} from './panel-table';
import {
  SCOPED_SENTENCE,
  SCOPE_UNCONFIRMED_MESSAGE,
  WidgetShell,
  countOf,
  requestState,
  resolveTitle,
  shareOf,
  shareText,
  staleOf,
  type WidgetProps,
  type WidgetState,
} from './common';
import { autoCloseGapReason, sentence } from './kpi-eval';

/**
 * The cases-opened note when the window opened more cases than the counters counted
 * alerts (late correlation, or push cases the counters did not see): the same state the
 * shared Alert reduction rule withholds, never a "1 case per 0 alerts" ratio.
 */
export const MORE_CASES_THAN_ALERTS = 'more cases than alerts counted in this window';

function stageTotal(data: NoiseReduction, key: string): number | null {
  const s = (data.stages ?? []).find((st) => st.key === key);
  return s && typeof s.total === 'number' && Number.isFinite(s.total) ? s.total : null;
}

export interface FunnelStageRow {
  key: string;
  label: string;
  value: number;
  /** The value is a lower bound (the counters or the case tally cover part of the window). */
  bound: boolean;
  note: string;
  tone: string;
}

/** The note a share takes when its counts cover only part of the window. */
export const PARTIAL_COVERAGE_NOTE = 'not measured: partial coverage';

/**
 * The stages the board shows, in flow order, each with its plain-words note. Alert stages
 * need the alert counters; case stages are left out while row-level scope is on.
 *
 * Honesty: when the alert counters cover only part of the window (`counters.incomplete`)
 * the alert counts are lower bounds and no share is derived from them (a share of
 * minutes of alerts against a whole window of cases is no measurement). When the case
 * tally hit its cap (`cases_meta.truncated`) the case counts are lower bounds and their
 * shares are withheld the same way.
 */
export function funnelRows(data: NoiseReduction, opts: { caseStages: boolean }): FunnelStageRow[] {
  const rows: FunnelStageRow[] = [];
  const alertsPartial = data.counters?.incomplete === true;
  const casesPartial = data.cases_meta?.truncated === true;
  const ingested = data.counters?.available ? stageTotal(data, 'ingested') : null;
  const clustered = data.counters?.available ? stageTotal(data, 'clustered') : null;
  const cases = stageTotal(data, 'cases');
  if (ingested != null) {
    rows.push({
      key: 'ingested',
      label: 'Alerts ingested',
      value: ingested,
      bound: alertsPartial,
      note: 'raw alerts from every source',
      tone: 'bg-accent-bar',
    });
  }
  if (clustered != null && ingested != null) {
    const folded = !alertsPartial && ingested > 0 ? shareOf(ingested - clustered, ingested) : '';
    rows.push({
      key: 'clustered',
      label: 'After clustering',
      value: clustered,
      bound: alertsPartial,
      note: alertsPartial
        ? `Share folded into clusters ${PARTIAL_COVERAGE_NOTE}`
        : folded
          ? `${folded} folded into clusters`
          : 'related alerts grouped',
      tone: 'bg-accent-bar',
    });
  }
  if (opts.caseStages && cases != null) {
    const perCase =
      ingested == null
        ? 'investigable cases'
        : alertsPartial || casesPartial
          ? `Alerts per case ${PARTIAL_COVERAGE_NOTE}`
          : cases > ingested
            ? MORE_CASES_THAN_ALERTS
            : cases > 0
              ? `1 case per ${countOf(Math.max(1, Math.round(ingested / cases)), 'alert')}`
              : 'investigable cases';
    rows.push({ key: 'cases', label: 'Cases opened', value: cases, bound: casesPartial, note: perCase, tone: 'bg-primary' });
    const ofCases = (n: number, fallback: string) =>
      casesPartial ? fallback : cases > 0 ? `${shareOf(n, cases)} of cases` : fallback;
    const auto = stageTotal(data, 'auto_cleared');
    if (auto != null) {
      rows.push({
        key: 'auto_cleared',
        label: 'Closed by the AI agent',
        value: auto,
        bound: casesPartial,
        note: ofCases(auto, 'auto-cleared false positives'),
        tone: 'bg-success',
      });
    }
    const escalated = stageTotal(data, 'escalated');
    if (escalated != null) {
      rows.push({
        key: 'escalated',
        label: 'Sent to a person',
        value: escalated,
        bound: casesPartial,
        note: ofCases(escalated, 'escalated to an analyst'),
        tone: 'bg-warning',
      });
    }
  }
  return rows;
}

const NOISE_REQ: DashboardRequest = { key: 'noise' };

export function NoiseFunnelWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Noise reduction');
  const { windowInfo, objectScoped, scopeError, retry, retryScope } = useDashboardData();
  const answer = useDashboardRequest({ key: 'noise' });
  const data = answer.data;
  const onRetry = () => retry(NOISE_REQ);
  let state = requestState(answer, onRetry);
  const caseStages = objectScoped === false;
  // Scope not known yet: the case stages may or may not be shown, so the panel waits
  // rather than saying they are hidden (a claim nobody confirmed).
  if (!state && objectScoped === undefined && !scopeError) state = { kind: 'loading' };
  const rows = data ? funnelRows(data, { caseStages }) : [];
  if (!state && data && rows.length === 0) {
    state = caseStages
      ? { kind: 'empty', title: `No alerts or cases in the ${windowInfo.phrase}` }
      : objectScoped === true
        ? { kind: 'scoped' }
        : { kind: 'unconfirmed', onRetry: retryScope };
  }
  const reduction = data && caseStages ? alertReduction(data) : null;
  const caption = `${windowInfo.label}${reduction?.value != null ? ` · ${reduction.text} alert reduction` : ''}`;
  const max = rows.reduce((m, r) => Math.max(m, Math.sqrt(Math.max(0, r.value))), 0);
  const notes = [
    'Bar length uses a square-root scale so the last stages stay visible.',
    data && !data.counters?.available ? 'Alert stages start when the alert counters do.' : null,
    data?.counters?.available && data.counters.incomplete
      ? 'The alert counters cover only part of this window, so alert counts are lower bounds.'
      : null,
    caseStages && data?.cases_meta?.truncated ? 'Case counts are partial for this window, so they are lower bounds.' : null,
    !caseStages && objectScoped === true ? `Case stages: ${SCOPED_SENTENCE.toLowerCase()}` : null,
    !caseStages && scopeError ? `Case stages are hidden: ${SCOPE_UNCONFIRMED_MESSAGE.toLowerCase()}` : null,
  ].filter(Boolean);
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={{ label: 'Open the flow', page: 'overview' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={notes.join(' ')}
    >
      <ul className="flex flex-col gap-3.5" aria-label={title}>
        {rows.map((r) => (
          <BarRow
            key={r.key}
            label={r.label}
            value={Math.sqrt(Math.max(0, r.value))}
            max={max}
            barClass={r.tone}
            right={<BoundCount value={r.value} bound={r.bound} className="font-semibold text-foreground" />}
            sub={r.note}
          />
        ))}
      </ul>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Noisiest rules
// --------------------------------------------------------------------------- //

const TARGET_WORDS: Readonly<Record<string, string>> = {
  correlation_n: 'correlation count',
  severity_floor: 'severity floor',
  suppress: 'suppression',
};

function changeText(target: string, before: unknown, after: unknown): string {
  const what = TARGET_WORDS[target] ?? humanizeToken(target).toLowerCase();
  const fmt = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? String(v) : 'unset');
  return `${what} ${fmt(before)} to ${fmt(after)}`;
}

export interface NoisyRuleRow {
  noise: RuleNoise;
  state: 'applied' | 'proposed' | 'collecting' | 'watching';
  text: string;
}

/** The rules over the target, noisiest first, each with its tuning state in plain words. */
export function noisyRuleRows(t: TuningRecommendationsResponse, limit = 6): NoisyRuleRow[] {
  const applied = new Map<string, (typeof t.applied)[number]>();
  for (const row of t.applied ?? []) if (isLedgerRowActive(row) && !applied.has(row.rule_id)) applied.set(row.rule_id, row);
  const proposed = new Map<string, (typeof t.recommendations)[number]>();
  for (const rec of t.recommendations ?? []) if (!proposed.has(rec.rule_id)) proposed.set(rec.rule_id, rec);
  return (t.rule_noise ?? [])
    .filter((n) => n.over_target)
    .sort((a, b) => b.fp_rate - a.fp_rate || b.total - a.total)
    .slice(0, limit)
    .map((noise) => {
      const a = applied.get(noise.rule_id);
      if (a) {
        const day = a.applied_at ? new Date(a.applied_at) : null;
        const when = day && Number.isFinite(day.getTime()) ? ` ${day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
        return { noise, state: 'applied', text: `Applied${when}: ${changeText(a.target, a.before, a.after)}` };
      }
      const p = proposed.get(noise.rule_id);
      if (p) {
        return {
          noise,
          state: 'proposed',
          text: p.shadow_blocked ? `Held by the safety check: ${changeText(p.kind, p.before, p.after)}` : `Proposed: ${changeText(p.kind, p.before, p.after)}`,
        };
      }
      if (noise.correlation_n_inert) {
        return { noise, state: 'watching', text: 'Fires on every event, so a threshold change would do nothing' };
      }
      const samples = noise.analyst_samples ?? 0;
      if (samples < t.min_samples) {
        return { noise, state: 'collecting', text: `Needs more analyst-graded cases (${fmtNumber(samples)} of ${fmtNumber(t.min_samples)})` };
      }
      return { noise, state: 'watching', text: 'Watching for more outcomes' };
    });
}

const STATE_TONE: Readonly<Record<NoisyRuleRow['state'], { dot: string; text: string }>> = {
  applied: { dot: 'bg-success', text: 'text-success-text' },
  proposed: { dot: 'bg-info', text: 'text-info-text' },
  collecting: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  watching: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

const TUNING_REQ: DashboardRequest = { key: 'tuning' };

const NOISY_RULE_COLUMNS: readonly PanelColumn[] = [
  { label: 'Rule and tuning' },
  { label: 'Cases', width: '5rem', align: 'right' },
  { label: 'FP rate', width: '7.5rem', align: 'right' },
];

export function NoisyRulesWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Noisiest rules');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'tuning' });
  const t = answer.data;
  const onRetry = () => retry(TUNING_REQ);
  let state = requestState(answer, onRetry);
  if (!state && t && !t.enabled) state = { kind: 'unavailable', title: 'Auto-tuning is turned off' };
  const rows = t ? noisyRuleRows(t) : [];
  if (!state && t && rows.length === 0) state = { kind: 'empty', title: 'No rule is over the false-positive target' };
  const target = t ? `${Math.round(t.fp_rate_target * 100)}%` : '';
  const stateLine = (r: NoisyRuleRow) => (
    <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs', STATE_TONE[r.state].text)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', STATE_TONE[r.state].dot)} aria-hidden />
      <span className="min-w-0 truncate" title={r.text}>
        {r.text}
      </span>
    </span>
  );
  const fp = (n: RuleNoise) => shareText(n.fp_rate);
  return (
    <WidgetShell
      title={title}
      caption={`Right now · analyst-graded false-positive rate over the ${target} target`}
      exit={{ label: 'Open Auto-tuning', page: 'tuning' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer="The rate is a lower bound from analyst-graded cases only; the AI verdict never counts."
    >
      <PanelList label={title} fit={panelFit(NOISY_RULE_COLUMNS)}>
        {rows.map((r) => (
          <PanelListItem
            key={r.noise.rule_id}
            // The row's primary action: a 44 px target on a phone (SPEC §3.3).
            primary={<RuleLink rule={r.noise.rule_id} origin="Noisiest rules" className={cn('text-sm leading-6 text-foreground', PHONE_ROW_TARGET)} />}
            trailing={fp(r.noise)}
            secondary={stateLine(r)}
          />
        ))}
      </PanelList>
      <PanelTable
        label={title}
        columns={NOISY_RULE_COLUMNS}
      >
        {rows.map((r) => (
          <PanelRow
            key={r.noise.rule_id}
            cells={[
              {
                content: (
                  <span className="block min-w-0">
                    <RuleLink
                      rule={r.noise.rule_id}
                      origin="Noisiest rules"
                      // `leading-6`: a 24 px pointer target (SPEC §3.3).
                      className="block truncate text-sm leading-6 text-foreground"
                      title={r.noise.rule_id}
                    />
                    {stateLine(r)}
                  </span>
                ),
              },
              { content: fmtNumber(r.noise.total), align: 'right', numeric: true },
              {
                content: (
                  <>
                    {fp(r.noise)} <span className="text-xs text-muted-foreground">n={fmtNumber(r.noise.analyst_samples ?? 0)}</span>
                  </>
                ),
                align: 'right',
                numeric: true,
              },
            ]}
          />
        ))}
      </PanelTable>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Telemetry gaps
// --------------------------------------------------------------------------- //

const TELEMETRY_REQ: DashboardRequest = { key: 'telemetry' };

/**
 * What the Telemetry gaps panel may say for an answer it read. Gap capture itself may not
 * exist in this build (`capture_status: 'not_available'`): an empty list then means
 * nothing was measured, so it says capture is not available, never "no gap recorded"
 * (which reads as healthy telemetry). "No telemetry gap found" is only for capture that
 * ran and found nothing.
 */
export function telemetryState(t: TelemetryRecommendationsResponse): WidgetState | null {
  const rows = t.recommendations ?? [];
  if (rows.length > 0) return null;
  if (t.capture_status === 'not_available') {
    return {
      kind: 'unavailable',
      title: 'Telemetry gap capture is not available yet',
      description: t.capture_not_available_reason || t.not_available_reason || undefined,
    };
  }
  if (t.capture_status === 'available') {
    return { kind: 'empty', title: 'No telemetry gap found', description: t.not_available_reason || undefined };
  }
  // An older server that does not say whether capture runs.
  return {
    kind: 'unavailable',
    title: 'No telemetry gap recorded',
    description: t.not_available_reason || 'Gaps are recorded only from query evidence.',
  };
}

export function TelemetryGapsWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Telemetry gaps');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'telemetry' });
  const t = answer.data;
  const onRetry = () => retry(TELEMETRY_REQ);
  let state = requestState(answer, onRetry);
  if (!state && t) state = telemetryState(t);
  const rows = t?.recommendations ?? [];
  // The scan count is stated only where capture runs (no scan when it does not).
  const scanned = t && t.capture_status !== 'not_available' ? `, ${countOf(t.scanned_cases, 'case')} scanned` : '';
  return (
    <WidgetShell
      title={title}
      caption={`Right now · from query evidence${scanned}`}
      exit={{ label: 'Open Auto-tuning', page: 'tuning' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={t?.truncated ? 'Only the newest cases were scanned, so there may be more.' : undefined}
    >
      <ul className="flex flex-col divide-y divide-border/60" aria-label={title}>
        {rows.map((g) => (
          <li key={`${g.source_type}-${g.field}`} className="flex gap-3 py-2.5 first:pt-0">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
            <span className="min-w-0">
              <span className="block break-words text-sm font-medium text-foreground">
                <span className="font-mono">{g.field}</span> from {g.source_label || g.source_type}
              </span>
              <span className="block break-words text-sm text-muted-foreground">
                {g.benefit} · {countOf(g.affected_case_count, 'case')}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Auto-close health
// --------------------------------------------------------------------------- //

/**
 * How a status reads. Only `ok` is good news. A status that means "cannot be measured"
 * (nothing decided, too few to judge, every decision inside an outage, auto-close turned
 * off) is muted with no check mark: a measurement gap is never shown as health.
 */
export type AutoCloseTone = 'healthy' | 'attention' | 'unmeasured';

export const AUTO_CLOSE_STATUS_WORDS: Readonly<Record<string, { label: string; tone: AutoCloseTone }>> = {
  ok: { label: 'Healthy', tone: 'healthy' },
  no_volume: { label: 'No decisions in the window', tone: 'unmeasured' },
  disabled: { label: 'Turned off', tone: 'unmeasured' },
  insufficient_evidence: { label: 'Not enough decisions to judge', tone: 'unmeasured' },
  outage_excluded: { label: 'Not measured: decisions fell in an outage', tone: 'unmeasured' },
  never_fired: { label: 'Has not closed a case yet', tone: 'attention' },
  degraded: { label: 'Lower than before', tone: 'attention' },
  collapsed: { label: 'Stopped closing cases', tone: 'attention' },
};

const TONE_STYLE: Readonly<Record<AutoCloseTone, { icon: typeof ShieldCheck; text: string }>> = {
  healthy: { icon: ShieldCheck, text: 'text-success-text' },
  attention: { icon: ShieldAlert, text: 'text-warning-text' },
  unmeasured: { icon: CircleDashed, text: 'text-muted-foreground' },
};

function rateText(rate: unknown): string | null {
  return typeof rate === 'number' && Number.isFinite(rate) ? shareText(rate) : null;
}

/** The policy in plain words (display only; the policy itself lives in Settings). */
export function policyWords(h: RecordedAutoCloseHealth): string {
  const p = h.policy;
  if (!p?.available) return 'Not readable';
  if (!p.any_enabled) return 'Turned off';
  const classes = [p.false_positive_enabled ? 'false positives' : null, p.true_positive_enabled ? 'true positives' : null].filter(Boolean);
  return classes.length ? `Closes ${classes.join(' and ')}` : 'Turned off';
}

const AUTO_CLOSE_REQ: DashboardRequest = { key: 'autoClose' };

export function AutoCloseHealthWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Auto-close health');
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'autoClose' });
  const h = answer.data;
  const onRetry = () => retry(AUTO_CLOSE_REQ);
  const state = requestState(answer, onRetry);
  const current = rateText(h?.current?.rate);
  const baseline = rateText(h?.baseline?.rate);
  const status = AUTO_CLOSE_STATUS_WORDS[h?.status ?? ''] ?? { label: humanizeToken(h?.status ?? ''), tone: 'unmeasured' as const };
  const tone = TONE_STYLE[status.tone];
  const StatusIcon = tone.icon;
  // Why the rate is not measured, said once (under "Not measured"): the trail's own gap
  // first (no decision on record), else the server's reason for the window.
  const trailGap = autoCloseGapReason(h?.current);
  const gap = current ? null : (trailGap ?? (h?.current?.reason ? sentence(h.current.reason) : null));
  // The status reason adds to a measured rate (why it is lower, why it stopped); when the
  // rate is not measured the line above already says why, so it is not repeated.
  const footer = current && h?.reason ? sentence(h.reason) : undefined;
  const decided = typeof h?.current?.decided === 'number' && Number.isFinite(h.current.decided) ? h.current.decided : null;
  return (
    <WidgetShell
      title={title}
      caption={`${windowInfo.label} against the ${windowInfo.phrase.replace('last ', '')} before`}
      exit={{ label: 'View effectiveness', page: 'effectiveness' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={footer}
    >
      {h ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              {current ? (
                <>
                  <div className="text-3xl font-semibold leading-none tabular-nums text-foreground">{current}</div>
                  <div className="mt-1.5 text-sm text-muted-foreground">closed by the AI agent on its first decision</div>
                </>
              ) : (
                <>
                  <div className="text-base font-semibold text-foreground">Not measured</div>
                  <div className="mt-1 text-sm text-muted-foreground">{gap ?? 'No case was decided in the window.'}</div>
                </>
              )}
            </div>
            <span
              className={cn('inline-flex items-center gap-1.5 text-sm font-medium', tone.text)}
              data-auto-close-tone={status.tone}
            >
              <StatusIcon className="size-4" aria-hidden />
              {status.label}
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">The window before</dt>
            <dd className="text-right tabular-nums text-foreground">{baseline ?? 'Not measured'}</dd>
            {trailGap ? (
              // The decision trail is the gap: "0 decided" would read as a measured count
              // beside the cases this board shows the agent closing.
              <>
                <dt className="text-muted-foreground">Decisions on record</dt>
                <dd className="text-right text-foreground">None</dd>
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">Decided in the window</dt>
                <dd className="text-right tabular-nums text-foreground">{decided == null ? 'Not measured' : fmtNumber(decided)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Policy</dt>
            <dd className="text-right text-foreground">{policyWords(h)}</dd>
          </dl>
        </>
      ) : null}
    </WidgetShell>
  );
}
