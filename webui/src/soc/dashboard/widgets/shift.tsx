/**
 * Shift widgets (Round 14, SPEC §4.4.3, §4.4.4), what a SOC manager reads to see whether
 * the team is keeping up:
 *
 * - `table.attention_queue` "Needs attention now": open cases that need a person, ranked
 *   breached first, then about to breach, then by urgency. The server's queue holds its
 *   25 most urgent cases only, so every breached or at-risk case from the report's
 *   uncapped SLA lists joins it (a breached low-risk case can sit outside the 25), and
 *   the footer's total is every open case that needs a person, not the 25.
 * - `table.workload` "Analyst workload": open cases per analyst, with the unassigned
 *   queue.
 * - `table.sla_breaches` "SLA breaches and at risk": cases of the window past or near a
 *   response or resolve target; the server lists the 25 furthest past target, and the
 *   footer says how many there are in all when it cut the list.
 * - `chart.backlog_aging` "Backlog aging": open cases by how long they have been open,
 *   all six buckets labelled.
 *
 * The queue and workload read the deterministic shift report (`GET /api/standup/report`,
 * never the billing `GET /api/standup`, #6/#7). Every case title, entity and analyst name
 * is untrusted and shown as plain text (#9). A case is named by its case number and opens
 * in Case Manager.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, caseLabel, fmtDuration, fmtNumber, fmtOverage, humanizeToken } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { RiskBadge, StatusBadge } from '@/soc/components/badges';
import type { PostureResponse } from '@/soc/pages/Metrics.posture.api';
import {
  normalizeReport,
  type AttentionRow,
  type SlaAgingRow,
  type StandupReport,
} from '@/soc/pages/Standup.report.api';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { BarRow, CaseNumberLink, PanelList, PanelListItem, PanelRow, PanelTable, panelFit, type PanelColumn } from './panel-table';
import { WidgetShell, countOf, optionInt, requestState, resolveTitle, staleOf, type WidgetProps, type WidgetState } from './common';

// --------------------------------------------------------------------------- //
// Shared bits
// --------------------------------------------------------------------------- //

export { CaseNumberLink } from './panel-table';

export type SlaState = 'breached' | 'at_risk' | 'ok';

/** The SLA state as a glyph and words (never colour alone). */
export function SlaWord({ state, children }: { state: SlaState; children: React.ReactNode }) {
  const Icon = state === 'breached' ? AlertTriangle : state === 'at_risk' ? Clock3 : CheckCircle2;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        state === 'breached' ? 'text-critical-text' : state === 'at_risk' ? 'text-warning-text' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

const SHIFT_REQ: DashboardRequest = { key: 'shift' };

/** Why a degraded shift report shows no rows (its sections are empty, not zero). */
export const SHIFT_DEGRADED_MESSAGE = 'The shift report could not be read.';

/**
 * The shift report and the state a shift widget shows instead of its rows. A report the
 * server could not build (`degraded: true`) arrives with EMPTY sections; that is a
 * failure to read, never "nothing needs a person", so it is an error with Retry and the
 * empty states apply only to a report that was actually read.
 */
function useShift(): { report: StandupReport | null; state: WidgetState | null; stale: ReturnType<typeof staleOf> } {
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'shift' });
  const onRetry = () => retry(SHIFT_REQ);
  let state = requestState(answer, onRetry);
  const report = answer.data ? normalizeReport(answer.data as Partial<StandupReport>) : null;
  if (!state && report && !report.enabled) {
    state = { kind: 'unavailable', title: 'The shift report is turned off', description: 'Turn it on in Settings to see the queue here.' };
  }
  if (!state && report?.degraded) {
    state = { kind: 'error', error: new Error(SHIFT_DEGRADED_MESSAGE), onRetry };
  }
  return { report, state, stale: staleOf(answer, onRetry) };
}

// --------------------------------------------------------------------------- //
// Needs attention now
// --------------------------------------------------------------------------- //

export interface RankedAttentionRow {
  row: AttentionRow;
  sla: { state: SlaState; text: string } | null;
  /**
   * The row came from the report's SLA lists only (it is outside the server's capped
   * queue), so its status, risk and title are not known here.
   */
  slaOnly: boolean;
}

/** A queue row for a breached or at-risk case the capped queue left out. */
function slaOnlyRow(r: SlaAgingRow): AttentionRow {
  const extra = r as SlaAgingRow & { case_number?: unknown; assignee?: unknown };
  return {
    case_id: r.case_id,
    case_number: typeof extra.case_number === 'string' ? extra.case_number : '',
    display_id: r.display_id ?? '',
    title: '',
    status: '',
    verdict: '',
    risk_score: Number.NaN,
    severity_band: '',
    priority_level: r.priority_level ?? '',
    assignee: typeof extra.assignee === 'string' ? extra.assignee : '',
    entity: '',
    age_minutes: r.age_minutes,
    urgency: 0,
  };
}

/**
 * The queue in working order: cases past their response target first (most overdue
 * first), then those about to breach (least time left first), then by the server's
 * urgency. Stable for equal keys.
 *
 * The server's `attention_queue` holds only its 25 most urgent cases, while its SLA lists
 * hold every breached and at-risk case, so a breached case of low risk can be missing
 * from the queue. Every SLA case the queue left out joins it here as a minimal row (case
 * number, age, assignee), so "breached first" holds for every breached case.
 */
export function rankAttention(report: StandupReport): RankedAttentionRow[] {
  const breached = new Map<string, SlaAgingRow>();
  for (const r of report.sla_aging.breached) if (r?.case_id) breached.set(r.case_id, r);
  const atRisk = new Map<string, SlaAgingRow>();
  for (const r of report.sla_aging.about_to_breach) if (r?.case_id && !breached.has(r.case_id)) atRisk.set(r.case_id, r);
  const queued = new Set(report.attention_queue.map((row) => row.case_id));
  const missing = [...breached.values(), ...atRisk.values()].filter((r) => !queued.has(r.case_id));
  const rank = (row: AttentionRow) => (breached.has(row.case_id) ? 0 : atRisk.has(row.case_id) ? 1 : 2);
  const indexed = [
    ...report.attention_queue.map((row) => ({ row, slaOnly: false })),
    ...missing.map((r) => ({ row: slaOnlyRow(r), slaOnly: true })),
  ].map((entry, i) => ({ ...entry, i }));
  indexed.sort((a, b) => {
    const ra = rank(a.row);
    const rb = rank(b.row);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const oa = breached.get(a.row.case_id)!.overdue_minutes;
      const ob = breached.get(b.row.case_id)!.overdue_minutes;
      if (oa !== ob) return ob - oa;
    } else if (ra === 1) {
      const la = atRisk.get(a.row.case_id)!;
      const lb = atRisk.get(b.row.case_id)!;
      const leftA = la.target_minutes - la.age_minutes;
      const leftB = lb.target_minutes - lb.age_minutes;
      if (leftA !== leftB) return leftA - leftB;
    }
    const ua = Number.isFinite(a.row.urgency) ? a.row.urgency : 0;
    const ub = Number.isFinite(b.row.urgency) ? b.row.urgency : 0;
    if (ua !== ub) return ub - ua;
    return a.i - b.i;
  });
  return indexed.map(({ row, slaOnly }) => {
    const b = breached.get(row.case_id);
    const r = atRisk.get(row.case_id);
    const sla = b
      ? { state: 'breached' as const, text: `Response ${fmtOverage(b.overdue_minutes)}` }
      : r
        ? { state: 'at_risk' as const, text: `Response due in ${fmtDuration(Math.max(0, r.target_minutes - r.age_minutes))}` }
        : null;
    return { row, sla, slaOnly };
  });
}

/**
 * How many open cases need a person: every one the report counted (`sla_aging.totals.open`,
 * uncapped), never the length of the capped queue.
 */
export function attentionTotal(report: StandupReport): number {
  const open = Number(report.sla_aging.totals.open);
  return Math.max(Number.isFinite(open) ? open : 0, report.attention_queue.length);
}

/** Whether a row knows its risk (an SLA-only row does not). */
function knownRisk(row: AttentionRow): boolean {
  return typeof row.risk_score === 'number' && Number.isFinite(row.risk_score);
}

const ATTENTION_COLUMNS: readonly PanelColumn[] = [
  { label: 'Case' },
  { label: 'Risk', width: '5.5rem' },
  { label: 'SLA', width: '11rem' },
  { label: 'Age', width: '5rem', align: 'right' },
  { label: 'Assignee', width: '8rem' },
];

export function AttentionQueueWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Needs attention now');
  const limit = optionInt(props.options, 'limit', 1, 25, 8);
  const { report, state: base, stale } = useShift();
  let state = base;
  const ranked = report ? rankAttention(report).slice(0, limit) : [];
  if (!state && report && ranked.length === 0) state = { kind: 'empty', title: 'Nothing needs a person right now' };
  const total = report ? attentionTotal(report) : 0;
  const footer = total > ranked.length ? `${fmtNumber(ranked.length)} of ${fmtNumber(total)} shown.` : '';
  const who = (row: AttentionRow) => row.assignee || 'Unassigned';
  return (
    <WidgetShell
      title={title}
      caption="Open now · SLA breached first, then most urgent"
      exit={{ label: 'View queue', page: 'case_manager' }}
      state={state}
      stale={stale}
      footer={footer || undefined}
    >
      <PanelList label={title} fit={panelFit(ATTENTION_COLUMNS)}>
        {ranked.map(({ row, sla, slaOnly }) => (
          <PanelListItem
            key={row.case_id}
            // A case known only from the SLA lists has no title here: its case number,
            // the row's link, leads instead.
            primary={slaOnly ? <CaseNumberLink caseId={row.case_id} label={caseLabel(row)} /> : row.title || caseLabel(row)}
            trailing={knownRisk(row) ? <RiskBadge score={row.risk_score} label="" className="px-1.5 py-0 text-2xs" /> : undefined}
            secondary={
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {slaOnly ? null : <CaseNumberLink caseId={row.case_id} label={caseLabel(row)} />}
                {row.status ? <StatusBadge status={row.status} icon={false} className="px-1.5 py-0 text-2xs" /> : null}
                {sla ? <SlaWord state={sla.state}>{sla.text}</SlaWord> : null}
                <span aria-hidden>·</span>
                <span>{fmtDuration(row.age_minutes)}</span>
                <span aria-hidden>·</span>
                <span>{who(row)}</span>
              </span>
            }
          />
        ))}
      </PanelList>
      <PanelTable
        label={title}
        columns={ATTENTION_COLUMNS}
      >
        {ranked.map(({ row, sla, slaOnly }) => (
          <PanelRow
            key={row.case_id}
            cells={[
              {
                content: slaOnly ? (
                  <CaseNumberLink caseId={row.case_id} label={caseLabel(row)} />
                ) : (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-foreground" title={row.title || undefined}>
                      {row.title || caseLabel(row)}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CaseNumberLink caseId={row.case_id} label={caseLabel(row)} />
                      {row.status ? (
                        <>
                          <span aria-hidden>·</span>
                          <StatusBadge status={row.status} icon={false} className="px-1.5 py-0 text-2xs" />
                        </>
                      ) : null}
                    </span>
                  </span>
                ),
              },
              {
                content: knownRisk(row) ? (
                  <RiskBadge score={row.risk_score} label="" className="px-1.5 py-0 text-2xs" />
                ) : (
                  // Not in the report for a case outside the server's queue.
                  <span className="text-xs text-muted-foreground">
                    <span aria-hidden>{DASH}</span>
                    <span className="sr-only">Not known</span>
                  </span>
                ),
              },
              {
                content: sla ? (
                  <SlaWord state={sla.state}>{sla.text}</SlaWord>
                ) : (
                  <span className="text-xs text-muted-foreground">Within target</span>
                ),
              },
              { content: <span className="text-xs text-muted-foreground">{fmtDuration(row.age_minutes)}</span>, align: 'right', numeric: true },
              {
                content: row.assignee ? (
                  <span className="block truncate text-sm" title={row.assignee}>
                    {row.assignee}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">Unassigned</span>
                ),
              },
            ]}
          />
        ))}
      </PanelTable>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Analyst workload
// --------------------------------------------------------------------------- //

const UNASSIGNED_KEYS = new Set(['', '(unassigned)', 'unassigned', 'none']);

export function WorkloadWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Analyst workload');
  const { report, state: base, stale } = useShift();
  let state = base;
  const rows = report ? [...report.workload] : [];
  rows.sort((a, b) => {
    const ua = UNASSIGNED_KEYS.has((a.analyst ?? '').toLowerCase());
    const ub = UNASSIGNED_KEYS.has((b.analyst ?? '').toLowerCase());
    if (ua !== ub) return ua ? -1 : 1;
    return b.open - a.open;
  });
  if (!state && report && rows.length === 0) state = { kind: 'empty', title: 'No open cases right now' };
  const open = rows.reduce((a, r) => a + (Number.isFinite(r.open) ? r.open : 0), 0);
  const unassigned = rows
    .filter((r) => UNASSIGNED_KEYS.has((r.analyst ?? '').toLowerCase()))
    .reduce((a, r) => a + r.open, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.open), 0);
  // The counts are stated only from a report that was read: while loading, after a
  // failure or for a degraded report the caption names the population and nothing more.
  const caption = state ? 'Open now' : `Open now · ${countOf(open, 'case')}, ${fmtNumber(unassigned)} unassigned`;
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={{ label: 'View assignments', page: 'case_manager' }}
      state={state}
      stale={stale}
    >
      <ul className="flex flex-col gap-3.5" aria-label={title}>
        {rows.map((r) => {
          const isUnassigned = UNASSIGNED_KEYS.has((r.analyst ?? '').toLowerCase());
          const sub = [
            `${fmtNumber(r.escalated)} escalated`,
            // The strip and the Awaiting a decision panel name this verdict the same way.
            r.needs_human > 0 ? `${fmtNumber(r.needs_human)} awaiting a decision` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <BarRow
              key={r.analyst || 'unassigned'}
              label={isUnassigned ? <span className="text-muted-foreground">Unassigned</span> : r.analyst}
              value={r.open}
              max={max}
              barClass={isUnassigned ? 'bg-warning' : 'bg-accent-bar'}
              right={<span className="font-semibold text-foreground">{fmtNumber(r.open)}</span>}
              sub={sub}
            />
          );
        })}
      </ul>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// SLA breaches and at risk
// --------------------------------------------------------------------------- //

const POSTURE_REQ: DashboardRequest = { key: 'posture' };

/**
 * How many SLA rows the window has in all: the server appends exactly one row per
 * counter increment, then keeps only the 25 furthest past target.
 */
export function slaBreachTotal(sla: {
  response_breached?: number;
  response_at_risk?: number;
  resolve_breached?: number;
  resolve_at_risk?: number;
  breaching?: unknown[];
}): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const counted = n(sla.response_breached) + n(sla.response_at_risk) + n(sla.resolve_breached) + n(sla.resolve_at_risk);
  return Math.max(counted, sla.breaching?.length ?? 0);
}

/** "18m over" for a breach, "6m left" for a case at risk. */
export function slaClockText(row: { state: string; elapsed_minutes: number; target_minutes: number }): string {
  if (row.state === 'breached') return fmtOverage(row.elapsed_minutes - row.target_minutes);
  return `${fmtDuration(Math.max(0, row.target_minutes - row.elapsed_minutes))} left`;
}

export function SlaBreachesWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'SLA breaches and at risk');
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'posture' });
  const posture = answer.data;
  const onRetry = () => retry(POSTURE_REQ);
  let state = requestState(answer, onRetry);
  const sla = posture?.sla;
  if (!state && sla && !sla.enabled) {
    state = { kind: 'unavailable', title: 'No SLA policy is turned on', description: sla.reason || undefined };
  }
  const rows = sla?.breaching ?? [];
  if (!state && sla?.enabled && rows.length === 0) {
    state = { kind: 'empty', title: `No case breached or came close to a target in the ${windowInfo.phrase}` };
  }
  const total = sla ? slaBreachTotal(sla) : 0;
  const notes = [
    total > rows.length ? `${fmtNumber(rows.length)} of ${fmtNumber(total)} shown, furthest past target first.` : null,
    posture && !posture.window_covered ? posture.window_coverage_reason || 'Part of the window could not be read.' : null,
  ].filter(Boolean);
  // Attainment is stated only from an SLA block that was read (with a policy on); while
  // loading or after a failure the caption names the window and nothing more.
  const attainment =
    sla?.enabled
      ? typeof sla.attainment_pct === 'number'
        ? `${Math.round(sla.attainment_pct * 10) / 10}% met`
        : 'attainment not measured'
      : null;
  return (
    <WidgetShell
      title={title}
      caption={attainment ? `${windowInfo.label} · ${attainment}` : windowInfo.label}
      exit={{ label: 'View in Standup', page: 'standup' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={notes.length ? notes.join(' ') : undefined}
    >
      <ul className="flex flex-col divide-y divide-border/60" aria-label={title}>
        {rows.map((r) => (
          <li key={`${r.case_id}-${r.clock}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {r.priority ? (
                <Badge variant="outline" className="px-1.5 py-0 text-2xs">
                  {r.priority}
                </Badge>
              ) : null}
              <CaseNumberLink caseId={r.case_id} label={caseLabel(r)} />
              <span className="truncate text-muted-foreground">{humanizeToken(r.clock)}</span>
            </span>
            <SlaWord state={r.state === 'breached' ? 'breached' : 'at_risk'}>{slaClockText(r)}</SlaWord>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Backlog aging
// --------------------------------------------------------------------------- //

/** The six buckets, always all labelled (a missing bucket is a zero the server omitted). */
export const AGE_BUCKETS = ['<1h', '1-4h', '4-24h', '1-3d', '3-7d', '>7d'] as const;

/** Open cases per age bucket from an all-time posture read, in bucket order. */
export function agingRows(posture: PostureResponse): Array<{ bucket: string; count: number }> {
  const byBucket = new Map((posture.aging?.age_buckets ?? []).map((b) => [b.bucket, b.count]));
  return AGE_BUCKETS.map((bucket) => ({ bucket, count: Number(byBucket.get(bucket) ?? 0) || 0 }));
}

const POSTURE_ALL: DashboardRequest = { key: 'posture', window: 'all' };

export function BacklogAgingWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Backlog aging');
  const { retry } = useDashboardData();
  // All time: aging over every case is the age of every case open right now.
  const answer = useDashboardRequest({ key: 'posture', window: 'all' });
  const posture = answer.data;
  const onRetry = () => retry(POSTURE_ALL);
  let state = requestState(answer, onRetry);
  const rows = posture ? agingRows(posture) : [];
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (!state && posture && total === 0) state = { kind: 'empty', title: 'No open cases right now' };
  const oldestHours = (posture?.aging?.oldest ?? []).reduce((m, o) => Math.max(m, Number(o.age_hours) || 0), 0);
  const caption = oldestHours > 0 ? `Open now · oldest ${fmtDuration(oldestHours * 60)}` : 'Open now';
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const partial = posture?.truncated === true || posture?.open_now?.complete === false;
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={{ label: 'View open cases', page: 'cases', opts: { status: '__active__' } }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={partial ? 'Counted from part of the open cases, so these are lower bounds.' : undefined}
    >
      <ul className="flex flex-col gap-2.5" aria-label="Open cases by age">
        {rows.map((r, i) => (
          <BarRow
            key={r.bucket}
            label={r.bucket}
            value={r.count}
            max={max}
            barClass={i >= 4 ? 'bg-warning' : 'bg-accent-bar'}
            right={<span className="font-semibold text-foreground">{fmtNumber(r.count)}</span>}
          />
        ))}
      </ul>
    </WidgetShell>
  );
}
