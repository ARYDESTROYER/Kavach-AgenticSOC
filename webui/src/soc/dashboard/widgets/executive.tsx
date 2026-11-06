/**
 * Executive widgets (Round 14, SPEC §4.4.3, §4.4.4):
 *
 * - `table.campaigns` "Active campaigns": groups of related cases that share entities,
 *   each named by a derived label (its shared entity and case count, D29), never by the
 *   internal hash.
 * - `kpi.agent_quality` "Agent quality": how often analysts agreed with the agent over
 *   the last 7 complete days against the 28 before. Insufficient evidence stays explicit
 *   ("Not enough evidence yet") and never becomes a rate or a score.
 *
 * Entity values are untrusted and shown as plain text (#9). Aggregates only (#7).
 */
import { fmtNumber } from '@/lib/format';
import type { AgentComparisonReading } from '@/lib/types';
import type { Campaign } from '@/soc/pages/Campaigns.api';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { WidgetShell, countOf, requestState, resolveTitle, shareText, staleOf, type WidgetProps } from './common';

/** "198.51.100.23 · 3 cases": the campaign's own name, else its first shared entity. */
export function campaignLabel(c: Campaign): string {
  const name = (c.name ?? '').trim();
  const entity = c.entities?.find((e) => (e?.value ?? '').trim())?.value?.trim();
  const base = name || entity || 'Related cases';
  return `${base} · ${countOf(c.case_count, 'case')}`;
}

function since(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
}

const CAMPAIGNS_REQ: DashboardRequest = { key: 'campaigns' };

export function CampaignsWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Active campaigns');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'campaigns' });
  const data = answer.data;
  const onRetry = () => retry(CAMPAIGNS_REQ);
  let state = requestState(answer, onRetry);
  if (!state && data && data.enabled === false) state = { kind: 'unavailable', title: 'Campaign correlation is turned off' };
  const active = (data?.campaigns ?? []).filter((c) => c.status !== 'resolved');
  if (!state && data && active.length === 0) state = { kind: 'empty', title: 'No active campaigns' };
  const cases = active.reduce((a, c) => a + (Number.isFinite(c.case_count) ? c.case_count : 0), 0);
  const shown = active.slice(0, 6);
  return (
    <WidgetShell
      title={title}
      caption="Active now · cases linked by shared entities"
      exit={{ label: 'View campaigns', page: 'campaigns' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={active.length > shown.length ? `${fmtNumber(shown.length)} of ${fmtNumber(active.length)} shown.` : undefined}
    >
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold leading-none tabular-nums text-foreground">{fmtNumber(active.length)}</span>
        <span className="text-sm text-muted-foreground">active, {countOf(cases, 'case')} in all</span>
      </div>
      <ul className="flex flex-col divide-y divide-border/60" aria-label={title}>
        {shown.map((c) => {
          const from = since(c.first_seen);
          return (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2 text-sm">
              <span className="min-w-0 break-words text-foreground">{campaignLabel(c)}</span>
              {from ? <span className="shrink-0 text-xs text-muted-foreground">since {from}</span> : null}
            </li>
          );
        })}
      </ul>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Agent quality
// --------------------------------------------------------------------------- //

function readingRate(r: AgentComparisonReading | undefined): string | null {
  if (!r || !r.available || typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
  return shareText(r.value);
}

const AGENT_REQ: DashboardRequest = { key: 'agentImprovement' };

export function AgentQualityWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Agent quality');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'agentImprovement' });
  const ev = answer.data;
  const onRetry = () => retry(AGENT_REQ);
  const state = requestState(answer, onRetry);
  const agreement = ev?.metrics?.analyst_reported_verdict_agreement;
  const correction = ev?.metrics?.material_analyst_correction_rate;
  const agreeNow = readingRate(agreement?.current);
  const correctNow = readingRate(correction?.current);
  const agreeBefore = readingRate(agreement?.baseline);
  const days = ev?.windows?.current?.days ?? 7;
  const baseDays = ev?.windows?.baseline?.days ?? 28;
  // Each measure is named above its figure or its gap, so two "Not enough evidence yet"
  // blocks side by side still say which measure each one is about.
  const stat = (name: string, value: string | null, reading: AgentComparisonReading | undefined) => (
    <div className="min-w-0" data-agent-measure="">
      <div className="text-sm font-medium text-muted-foreground">{name}</div>
      {value ? (
        <div className="mt-1.5 text-3xl font-semibold leading-none tabular-nums text-foreground">{value}</div>
      ) : (
        <div className="mt-1.5 text-base font-semibold text-foreground">Not enough evidence yet</div>
      )}
      <div className="mt-1.5 text-sm text-muted-foreground">
        {value
          ? countOf(reading?.sample_count ?? 0, 'analyst review')
          : `Needs ${countOf(reading?.minimum_sample ?? 30, 'analyst review')}; ${fmtNumber(reading?.sample_count ?? 0)} so far.`}
      </div>
    </div>
  );
  return (
    <WidgetShell
      title={title}
      caption={`Last ${days} days against the ${baseDays} before · agreement with analyst reviews`}
      exit={{ label: 'View effectiveness', page: 'effectiveness' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={
        ev
          ? agreeBefore
            ? `The ${baseDays} days before: ${agreeBefore} over ${countOf(agreement?.baseline?.sample_count ?? 0, 'review')}. There is no combined score.`
            : 'A rate is shown only with enough analyst reviews in both periods. There is no combined score.'
          : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {stat('Agreed with the analyst', agreeNow, agreement?.current)}
        {stat('Corrected by an analyst', correctNow, correction?.current)}
      </div>
    </WidgetShell>
  );
}
