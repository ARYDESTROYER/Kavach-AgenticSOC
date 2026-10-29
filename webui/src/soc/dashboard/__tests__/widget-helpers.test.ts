/**
 * The pure readers behind every board widget (Round 14, SPEC §4.4.3, §4.4.4): each one
 * turns a server answer into what a panel may honestly say. One test per rule, so a
 * figure that would read as exact, as zero or as health when the source does not say so
 * fails here before it can reach a board.
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { DASH } from '@/lib/format';
import type { MetricsTrends, NoiseReduction, RecordedAutoCloseHealth } from '@/lib/types';
import type { Campaign } from '@/soc/pages/Campaigns.api';
import type { MitreCoverageResponse, PostureResponse } from '@/soc/pages/Metrics.posture.api';
import { normalizeReport, type StandupReport } from '@/soc/pages/Standup.report.api';
import type { TuningRecommendationsResponse } from '@/soc/pages/Tuning.api';
import type { BudgetStatus } from '@/soc/pages/Models.api';

import type { DashboardReader } from '../DashboardDataProvider';
import { KPI_STRIP_BINDINGS, type KpiStripBinding } from '../kpi-bindings';
import {
  SCOPE_UNCONFIRMED_MESSAGE,
  SCOPED_SENTENCE,
  countOf,
  STALE_LEAD,
  isStale,
  moneyText,
  percentText,
  requestState,
  shareText,
  signedDuration,
  staleOf,
  staleSentence,
  type StaleInfo,
} from '../widgets/common';
import { alertReduction } from '@/soc/components/alert-reduction';
import { ScopeUnconfirmedError, isScopeRefusal } from '../widgets/requests';
import { SHIFT_OFF_REASON, SHIFT_UNREAD_REASON, autoCloseGapReason, evaluateBinding, type KpiReader } from '../widgets/kpi-eval';
import { cellDelta, stripCellGate, stripCellHelp, stripCellStale, stripFailureText, stripTileProps } from '../widgets/strip';
import { TIMINGS, timingCells, timingDelta } from '../widgets/lifecycle';
import {
  AUTO_CLOSE_STATUS_WORDS,
  MORE_CASES_THAN_ALERTS,
  PARTIAL_COVERAGE_NOTE,
  funnelRows,
  noisyRuleRows,
  policyWords,
  telemetryState,
} from '../widgets/detection';
import { alertSeriesFacts, outcomeSeries, severitySeries } from '../widgets/trend';
import {
  aiFalsePositiveShare,
  aiFpText,
  breakdownBarItems,
  breakdownExit,
  breakdownKeyLabel,
  sourceNames,
  topRuleRows,
} from '../widgets/breakdown';
import { AGE_BUCKETS, agingRows, attentionTotal, rankAttention, slaBreachTotal, slaClockText } from '../widgets/shift';
import { humanVsAiTick, humanVsAiTotals, verdictMixItems } from '../widgets/mix';
import { ATTACK_TACTIC_ORDER, heatmapColumns } from '../widgets/mitre';
import { campaignLabel } from '../widgets/executive';
import { ageFromMillis, connectorState, recentCaseRows } from '../widgets/tables';
import { budgetLine, exemptSpend } from '../widgets/kpi';
import {
  caseBreakdownRequests,
  caseBreakdownTitle,
  caseTrendTitle,
  outcomeBucket,
  severityBucket,
  severityTrendRequest,
} from '../widgets/widget-requests';
import { laptopSpans } from '../WidgetGrid';
import { panelFit } from '../widgets/panel-table';
import type { TelemetryRecommendationsResponse } from '@/soc/pages/Tuning.api';

import { SHIFT_REPORT, USAGE, breakdown, group, noise, posture } from './dashboard-fixtures';

function binding(groupName: string, cell: string): KpiStripBinding {
  const b = KPI_STRIP_BINDINGS.find((x) => x.group === groupName && x.cell === cell);
  if (!b) throw new Error(`no binding ${groupName}.${cell}`);
  return b;
}

const answered =
  (data: unknown): KpiReader =>
  () => ({ loading: false, data, error: null });

const CTX = { windowHours: 24, nowMs: Date.parse('2026-10-28T21:00:00Z') };

// --------------------------------------------------------------------------- //
// Request states
// --------------------------------------------------------------------------- //

describe('requestState', () => {
  const refusal = new ApiError(409, 'refused', { detail: { code: 'breakdown_scope_unsupported', message: 'No.' } });

  it('waits for a first answer, and keeps a held answer through a failed refresh', () => {
    expect(requestState({ loading: true, data: null, error: null })).toEqual({ kind: 'loading' });
    expect(requestState({ loading: false, data: { ok: true }, error: new Error('later') })).toBeNull();
    // A held answer stays ready while it is read again, whatever the last read did.
    expect(requestState({ loading: true, data: { ok: true }, error: new Error('later') })).toBeNull();
  });

  it('a failed first read stays a load error while it is read again, its Retry busy', () => {
    const retry = vi.fn();
    const error = new Error('503');
    expect(requestState({ loading: false, data: null, error }, retry)).toEqual({ kind: 'error', error, onRetry: retry, retrying: false });
    // Not a skeleton: the error and its Retry keep their place (and keyboard focus).
    expect(requestState({ loading: true, data: null, error }, retry)).toEqual({ kind: 'error', error, onRetry: retry, retrying: true });
  });

  it('a held answer whose refresh failed is stale, with the time it was read and Retry', () => {
    const retry = vi.fn();
    const at = Date.parse('2026-10-28T14:02:00Z');
    expect(isStale({ loading: false, data: { ok: true }, error: new Error('later'), loadedAt: at })).toBe(true);
    // Still stale while it is read again: only a read that succeeds clears the failure.
    expect(isStale({ loading: true, data: { ok: true }, error: new Error('later'), loadedAt: at })).toBe(true);
    // Not stale when fresh, or with nothing held.
    expect(isStale({ loading: false, data: { ok: true }, error: null, loadedAt: at })).toBe(false);
    expect(isStale({ loading: true, data: { ok: true }, error: null, loadedAt: at })).toBe(false);
    expect(isStale({ loading: false, data: null, error: new Error('later') })).toBe(false);
    // A row-level scope refusal hides the panel instead.
    expect(isStale({ loading: false, data: { ok: true }, error: refusal })).toBe(false);
    const stale = staleOf(
      [
        { loading: false, data: 1, error: new Error('x'), loadedAt: at + 60_000 },
        { loading: false, data: 2, error: new Error('y'), loadedAt: at },
        { loading: false, data: 3, error: null, loadedAt: at - 60_000 },
      ],
      retry,
    );
    // The panel is as old as its oldest held figure.
    expect(stale).toEqual({ loadedAt: at, reason: 'failed', busy: false, onRetry: retry });
    expect(staleOf({ loading: false, data: 1, error: null, loadedAt: at })).toBeNull();
    expect(staleSentence(at)).toMatch(/^Refresh failed\. Showing figures loaded at .+\.$/);
    expect(staleSentence(null)).toBe('Refresh failed. Showing figures loaded earlier.');
  });

  it('a held answer whose refresh has not answered within one interval is stale too', () => {
    const at = Date.parse('2026-10-28T14:02:00Z');
    const slow = { loading: true, data: 1, error: null, loadedAt: at, overdue: true };
    expect(isStale(slow)).toBe(true);
    // Nothing held: the panel is still loading, not stale.
    expect(isStale({ ...slow, data: null })).toBe(false);
    expect(staleOf(slow)).toEqual({ loadedAt: at, reason: 'slow', busy: false, onRetry: undefined });
    expect(staleSentence(at, STALE_LEAD.slow)).toMatch(/^Refresh is taking longer than usual\. Showing figures loaded at .+\.$/);
    // A failure wins over a slow read, and a failed read being read again is busy.
    const retrying = { loading: true, data: 2, error: new Error('503'), loadedAt: at - 60_000 };
    expect(staleOf([slow, retrying])).toEqual({ loadedAt: at - 60_000, reason: 'failed', busy: true, onRetry: undefined });
    // A slow read beside a failure that is not being read again: not busy.
    expect(staleOf([slow, { ...retrying, loading: false }])?.busy).toBe(false);
  });

  it('a row-level scope refusal is the scope sentence with no Retry, never a load error', () => {
    expect(isScopeRefusal(refusal)).toBe(true);
    expect(requestState({ loading: false, data: null, error: refusal }, vi.fn())).toEqual({ kind: 'scoped' });
  });

  it('only that exact refusal counts: another 409 or a 403 is a load error', () => {
    const other = new ApiError(409, 'conflict', { detail: { code: 'settings_conflict' } });
    const forbidden = new ApiError(403, 'forbidden', { detail: { code: 'breakdown_scope_unsupported' } });
    expect(isScopeRefusal(other)).toBe(false);
    expect(isScopeRefusal(forbidden)).toBe(false);
    expect(requestState({ loading: false, data: null, error: other })?.kind).toBe('error');
  });

  it('an unconfirmed scope offers Retry, which reads the scope again', () => {
    const onRetry = vi.fn();
    const state = requestState({ loading: false, data: null, error: new ScopeUnconfirmedError() }, onRetry);
    expect(state).toEqual({ kind: 'unconfirmed', onRetry });
    expect(new ScopeUnconfirmedError().message).toBe(SCOPE_UNCONFIRMED_MESSAGE);
  });
});

// --------------------------------------------------------------------------- //
// KPI cells
// --------------------------------------------------------------------------- //

describe('KPI cells read from the shift report and the decision trail', () => {
  it('a shift report that is turned off says so, never "no SLA policy"', () => {
    const r = evaluateBinding(binding('operations', 'sla_breached'), answered({ enabled: false }), CTX);
    expect(r.status).toBe('not_measured');
    expect(r.reason).toBe(SHIFT_OFF_REASON);
  });

  it('a report the server could not build is not measured, never 0 breached', () => {
    const r = evaluateBinding(
      binding('operations', 'sla_breached'),
      answered({ enabled: true, degraded: true, sla_aging: { breached: [] } }),
      CTX,
    );
    expect(r.status).toBe('not_measured');
    expect(r.reason).toBe(SHIFT_UNREAD_REASON);
  });

  it('closed by the AI agent names the missing decision records when nothing was decided', () => {
    expect(autoCloseGapReason({ decided: 0, no_decision_record: 3 })).toBe(
      'No decision is recorded in this window; 3 cases have no decision record.',
    );
    expect(autoCloseGapReason({ decided: 0, no_decision_record: 1 })).toBe(
      'No decision is recorded in this window; 1 case has no decision record.',
    );
    expect(autoCloseGapReason({ decided: 4, no_decision_record: 3 })).toBeNull();
    const r = evaluateBinding(
      binding('executive', 'closed_by_agent'),
      answered({ current: { decided: 0, no_decision_record: 2, auto_closed: 0, available: false, reason: 'no case was decided' } }),
      CTX,
    );
    expect(r).toMatchObject({ status: 'not_measured', reason: 'No decision is recorded in this window; 2 cases have no decision record.' });
  });
});

describe('KPI strip cells', () => {
  const metricsCell = binding('operations', 'awaiting_decision');
  const sourcesCell = binding('detection', 'sources_reporting');
  const allow = () => true;

  it('gate on the grant first, then on row-level scope for a case cell only', () => {
    expect(stripCellGate(metricsCell, () => false, false)).toBe('denied');
    expect(stripCellGate(metricsCell, allow, true)).toBe('scoped');
    expect(stripCellGate(metricsCell, allow, undefined)).toBe('waiting');
    expect(stripCellGate(metricsCell, allow, undefined, true)).toBe('unconfirmed');
    expect(stripCellGate(metricsCell, allow, false)).toBe('ok');
    // Source health is not case data: shown whatever the scope.
    expect(stripCellGate(sourcesCell, allow, true)).toBe('ok');
    expect(stripCellGate(sourcesCell, allow, undefined, true)).toBe('ok');
  });

  it('say why there is no figure, and never show the dash while loading', () => {
    expect(stripTileProps({ binding: metricsCell, gate: 'denied', result: null }, undefined)).toEqual({ value: DASH, sub: 'No access' });
    expect(stripTileProps({ binding: metricsCell, gate: 'scoped', result: null }, undefined).sub).toBe(SCOPED_SENTENCE);
    expect(stripTileProps({ binding: metricsCell, gate: 'unconfirmed', result: null }, undefined).sub).toBe(SCOPE_UNCONFIRMED_MESSAGE);
    const waiting = stripTileProps({ binding: metricsCell, gate: 'waiting', result: null }, undefined);
    expect(waiting.value).not.toBe(DASH);
    expect(waiting.sub).toBeUndefined();
    const notMeasured = stripTileProps(
      { binding: metricsCell, gate: 'ok', result: { status: 'not_measured', value: null, text: '', qualifier: null, reason: 'Too few.', share: null } },
      undefined,
    );
    // The visible line stays short, so every numeral sits on the strip's one baseline; the
    // reason is in the help popover.
    expect(notMeasured).toEqual({ value: DASH, sub: 'Not measured' });
    const floor = stripTileProps(
      { binding: metricsCell, gate: 'ok', result: { status: 'value', value: 12, text: '12', qualifier: 'at least', reason: 'Part was read.', share: null } },
      'open',
    );
    expect(floor).toMatchObject({ value: '12', bound: 'At least this many' });
    expect(floor.context).toBeUndefined();
    const about = stripTileProps(
      { binding: metricsCell, gate: 'ok', result: { status: 'value', value: 4.2, text: '4.2', qualifier: 'about', reason: 'Part was read.', share: null } },
      undefined,
    );
    expect(about).toMatchObject({ value: '4.2', sub: 'About 4.2' });
    const failed = stripTileProps(
      { binding: metricsCell, gate: 'ok', result: { status: 'error', value: null, text: '', qualifier: null, reason: 'This figure could not be loaded.', share: null } },
      undefined,
    );
    expect(failed).toEqual({ value: DASH, sub: 'Could not be loaded' });
    // Every visible line is at most a few words.
    for (const line of [notMeasured.sub, floor.bound, about.sub, failed.sub]) expect(line!.split(' ').length).toBeLessThanOrEqual(4);
  });

  it('put the source reason in the help popover, after the definition', () => {
    const def = metricsCell.definition;
    expect(stripCellHelp({ binding: metricsCell, gate: 'ok', result: null })).toBe(def);
    expect(
      stripCellHelp({
        binding: metricsCell,
        gate: 'ok',
        result: { status: 'not_measured', value: null, text: '', qualifier: null, reason: 'The counters started recently.', share: null },
      }),
    ).toBe(`${def} Not measured. The counters started recently.`);
    expect(
      stripCellHelp({
        binding: metricsCell,
        gate: 'ok',
        result: { status: 'value', value: 12, text: '12', qualifier: 'at least', reason: 'Part was read.', share: null },
      }),
    ).toBe(`${def} At least this many. Part was read.`);
    expect(
      stripCellHelp({
        binding: metricsCell,
        gate: 'ok',
        result: { status: 'value', value: 4.2, text: '4.2', qualifier: 'about', reason: 'Part was read.', share: null },
      }),
    ).toBe(`${def} About 4.2. Part was read.`);
    // A gated cell explains itself on its own line; its help is the definition.
    expect(stripCellHelp({ binding: metricsCell, gate: 'denied', result: null })).toBe(def);
  });

  it('say which figures are kept from an earlier read when a refresh failed', () => {
    const at = Date.parse('2026-10-28T14:02:00Z');
    const view = {
      binding: metricsCell,
      gate: 'ok' as const,
      result: { status: 'value' as const, value: 13, text: '13', qualifier: null, reason: null, share: null },
    };
    const staleRead: DashboardReader = () => ({ loading: false, data: breakdown({ by: 'verdict' }) as never, error: new Error('503'), loadedAt: at });
    const freshRead: DashboardReader = () => ({ loading: false, data: breakdown({ by: 'verdict' }) as never, error: null, loadedAt: at });
    expect(stripCellStale(view, staleRead)).toEqual({ loadedAt: at, reason: 'failed', busy: false, onRetry: undefined });
    expect(stripCellStale(view, freshRead)).toBeNull();
    // Read again after the failure: still held, and busy until a read succeeds.
    const retryingRead: DashboardReader = () => ({ loading: true, data: breakdown({ by: 'verdict' }) as never, error: new Error('503'), loadedAt: at });
    expect(stripCellStale(view, retryingRead)).toEqual({ loadedAt: at, reason: 'failed', busy: true, onRetry: undefined });
    // A refresh that has not answered within one interval: held, slow.
    const slowRead: DashboardReader = () => ({ loading: true, data: breakdown({ by: 'verdict' }) as never, error: null, loadedAt: at, overdue: true });
    expect(stripCellStale(view, slowRead)).toMatchObject({ reason: 'slow', busy: false });
    // A cell that failed outright says so in its own tile; it is not "stale".
    expect(stripCellStale({ ...view, result: { ...view.result, status: 'error' } }, staleRead)).toBeNull();
    const held = (loadedAt: number | null, reason: StaleInfo['reason'] = 'failed'): StaleInfo => ({ loadedAt, reason, busy: false });
    const one = stripFailureText(0, [{ label: 'Open now', stale: held(at) }], false)!;
    expect(one).toMatch(/^Open now could not be refreshed\. Showing figures loaded at .+\.$/);
    const two = stripFailureText(1, [{ label: 'New cases', stale: held(at) }, { label: 'Closed', stale: held(at) }], false)!;
    expect(two).toMatch(/^One figure could not be loaded\. New cases and Closed could not be refreshed\./);
    const many = stripFailureText(0, ['A', 'B', 'C'].map((label) => ({ label, stale: held(null) })), false);
    expect(many).toBe('3 figures could not be refreshed. Showing figures loaded earlier.');
    // A slow refresh is not called a failure.
    const slow = stripFailureText(0, [{ label: 'New cases', stale: held(null, 'slow') }], false);
    expect(slow).toBe('Refreshing New cases is taking longer than usual. Showing figures loaded earlier.');
    const both = stripFailureText(0, [{ label: 'Open now', stale: held(null) }, { label: 'Closed', stale: held(null, 'slow') }], false);
    expect(both).toBe(
      'Open now could not be refreshed. Showing figures loaded earlier. Refreshing Closed is taking longer than usual. Showing figures loaded earlier.',
    );
    expect(stripFailureText(0, [], true)).toBe(SCOPE_UNCONFIRMED_MESSAGE);
    expect(stripFailureText(0, [], false)).toBeNull();
  });

  it('compare with the window before only when the server published both and read everything', () => {
    const newCases = binding('operations', 'new_cases');
    const read: DashboardReader = () => ({ loading: false, data: posture() as never, error: null });
    expect(cellDelta(newCases, read)).toEqual({ value: 8, label: '+8' });
    const truncated: DashboardReader = () => ({ loading: false, data: posture({ truncated: true }) as never, error: null });
    expect(cellDelta(newCases, truncated)).toBeUndefined();
    // A cell the posture comparison does not cover shows no chip at all.
    expect(cellDelta(metricsCell, read)).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- //
// Response timing
// --------------------------------------------------------------------------- //

describe('Response timing', () => {
  it('a timing the server did not measure says so with its reason, never 0', () => {
    const cells = timingCells(posture().lifecycle as never);
    const mtta = cells.find((c) => c.key === 'mtta')!;
    expect(mtta.value).toBe(DASH);
    // Short on the tile, so the four numerals share one row; the reason is in the help.
    expect(mtta.sub).toBe('Not measured');
    expect(mtta.help).toMatch(/ Not measured\. No case has been acknowledged yet\.$/);
    const mttr = cells.find((c) => c.key === 'mttr')!;
    expect(mttr).toMatchObject({ value: '42m', context: 'p90 1h 30m · 33 cases' });
    expect(cells.map((c) => c.key)).toEqual(['mttd', 'mtta', 'mttr', 'dwell']);
  });

  it('each timing is defined as the server measures it (engine/metrics.py lifecycle_intervals)', () => {
    const help = Object.fromEntries(timingCells(posture().lifecycle as never).map((c) => [c.key, c.help]));
    // MTTD: the first event to case creation.
    expect(help.mttd).toMatch(/^Median time from the first event of a case to the case being created\./);
    // MTTA: creation (or detection) to the first acknowledgement by a person.
    expect(help.mtta).toMatch(/^Median time from case creation, or detection when known, to the first acknowledgement by a person\./);
    // MTTR: creation (or detection) to the first resolved or closed.
    expect(help.mttr).toMatch(/^Median time from case creation, or detection when known, to the case first being resolved or closed\./);
    // Dwell: creation (or detection) to the first RESPONSE, never first event to resolution.
    expect(help.dwell).toMatch(
      /^Median time from case creation, or detection when known, to the first response \(investigating, escalated, on hold, resolved or closed\)\. This is time to first response, not time to detect\./,
    );
    expect(help.dwell).not.toMatch(/first event to resolution/);
    for (const t of TIMINGS) expect(t.help, t.key).not.toMatch(/[\u2013\u2014]/);
  });

  it('a change is shown only for a published, untruncated comparison', () => {
    const compare = { mttr_p50: { value: 42, prev: 60 } };
    expect(timingDelta('mttr', { compare })).toEqual({ value: -18, label: '-18m' });
    expect(timingDelta('mttr', { compare, truncated: true })).toBeUndefined();
    expect(timingDelta('mttd', { compare })).toBeUndefined();
    // No change is "0m", never a bare "<1m" that reads as a figure.
    expect(timingDelta('mttr', { compare: { mttr_p50: { value: 0.4, prev: 0.4 } } })).toEqual({ value: 0, label: '0m' });
    expect(timingDelta('mttr', { compare: { mttr_p50: { value: 0.2, prev: 0.6 } } })?.label).toBe('-<1m');
  });
});

// --------------------------------------------------------------------------- //
// Noise reduction, noisy rules, auto-close
// --------------------------------------------------------------------------- //

describe('noise reduction stages', () => {
  it('state shares when every count covers the whole window', () => {
    const rows = funnelRows(noise(), { caseStages: true });
    expect(rows.map((r) => r.key)).toEqual(['ingested', 'clustered', 'cases', 'auto_cleared', 'escalated']);
    expect(rows.every((r) => !r.bound)).toBe(true);
    expect(rows.find((r) => r.key === 'clustered')!.note).toBe('77% folded into clusters');
    expect(rows.find((r) => r.key === 'cases')!.note).toBe('1 case per 30 alerts');
    expect(rows.find((r) => r.key === 'auto_cleared')!.note).toBe('68% of cases');
  });

  it('counters that cover part of the window make the alert counts floors with no ratio', () => {
    const data = noise({ counters: { available: true, incomplete: true, since: null, coverage_start: null } } as never);
    const rows = funnelRows(data, { caseStages: true });
    expect(rows.find((r) => r.key === 'ingested')!.bound).toBe(true);
    expect(rows.find((r) => r.key === 'clustered')!.note).toBe(`Share folded into clusters ${PARTIAL_COVERAGE_NOTE}`);
    expect(rows.find((r) => r.key === 'cases')!.note).toBe(`Alerts per case ${PARTIAL_COVERAGE_NOTE}`);
    expect(rows.map((r) => r.note).join(' ')).not.toMatch(/1 case per/);
  });

  it('never states "1 case per 0 alerts": more cases than alerts is said in words, as Alert reduction withholds it', () => {
    const counted = (ingested: number, cases: number) =>
      noise({
        stages: [
          { key: 'ingested', label: 'Ingested', total: ingested },
          { key: 'clustered', label: 'Clustered', total: Math.min(ingested, cases) },
          { key: 'cases', label: 'Cases', total: cases },
        ],
      } as never);
    const note = (ingested: number, cases: number) =>
      funnelRows(counted(ingested, cases), { caseStages: true }).find((r) => r.key === 'cases')!.note;
    expect(note(3, 10)).toBe(MORE_CASES_THAN_ALERTS);
    expect(alertReduction(counted(3, 10)).value).toBeNull();
    expect(note(3, 3)).toBe('1 case per 1 alert');
    expect(note(3, 2)).toBe('1 case per 2 alerts');
    expect(note(100, 1)).toBe('1 case per 100 alerts');
  });

  it('a capped case tally makes the case counts floors and withholds their shares', () => {
    const data = noise({ cases_meta: { truncated: true, store_total: 9000, fetched: 5000 } } as never);
    const rows = funnelRows(data, { caseStages: true });
    for (const key of ['cases', 'auto_cleared', 'escalated']) expect(rows.find((r) => r.key === key)!.bound, key).toBe(true);
    expect(rows.find((r) => r.key === 'auto_cleared')!.note).toBe('auto-cleared false positives');
  });

  it('leaves the case stages out while row-level scope is on, and the alert stages until the counters start', () => {
    expect(funnelRows(noise(), { caseStages: false }).map((r) => r.key)).toEqual(['ingested', 'clustered']);
    const warming = noise({ counters: { available: false, incomplete: false, since: null, coverage_start: null } } as never);
    expect(funnelRows(warming, { caseStages: true }).map((r) => r.key)).toEqual(['cases', 'auto_cleared', 'escalated']);
  });
});

describe('noisiest rules', () => {
  const base = {
    enabled: true,
    fp_rate_target: 0.1,
    min_samples: 30,
    rule_noise: [
      { rule_id: 'a_rule', total: 40, analyst_samples: 40, fp_rate: 0.5, over_target: true },
      { rule_id: 'b_rule', total: 12, analyst_samples: 12, fp_rate: 0.9, over_target: true },
      { rule_id: 'quiet', total: 10, analyst_samples: 40, fp_rate: 0.05, over_target: false },
      { rule_id: 'c_rule', total: 30, analyst_samples: 31, fp_rate: 0.5, over_target: true, correlation_n_inert: true },
    ],
    recommendations: [{ rule_id: 'a_rule', kind: 'correlation_n', before: 3, after: 4, shadow_blocked: true }],
    applied: [],
  } as unknown as TuningRecommendationsResponse;

  it('list only the rules over the target, noisiest first, each with its tuning state in words', () => {
    const rows = noisyRuleRows(base);
    expect(rows.map((r) => r.noise.rule_id)).toEqual(['b_rule', 'a_rule', 'c_rule']);
    expect(rows[0]).toMatchObject({ state: 'collecting', text: 'Needs more analyst-graded cases (12 of 30)' });
    expect(rows[1]).toMatchObject({ state: 'proposed', text: 'Held by the safety check: correlation count 3 to 4' });
    expect(rows[2]).toMatchObject({ state: 'watching', text: 'Fires on every event, so a threshold change would do nothing' });
  });
});

describe('auto-close health', () => {
  it('never shows a measurement gap as health', () => {
    for (const status of ['no_volume', 'disabled', 'insufficient_evidence', 'outage_excluded']) {
      expect(AUTO_CLOSE_STATUS_WORDS[status].tone, status).toBe('unmeasured');
    }
    expect(AUTO_CLOSE_STATUS_WORDS.ok.tone).toBe('healthy');
    for (const status of ['degraded', 'collapsed', 'never_fired']) expect(AUTO_CLOSE_STATUS_WORDS[status].tone, status).toBe('attention');
  });

  it('states the policy in plain words', () => {
    const h = (policy: Record<string, unknown>) => ({ policy }) as unknown as RecordedAutoCloseHealth;
    expect(policyWords(h({ available: false }))).toBe('Not readable');
    expect(policyWords(h({ available: true, any_enabled: false }))).toBe('Turned off');
    expect(policyWords(h({ available: true, any_enabled: true, false_positive_enabled: true, true_positive_enabled: false }))).toBe(
      'Closes false positives',
    );
  });
});

// --------------------------------------------------------------------------- //
// Over time
// --------------------------------------------------------------------------- //

describe('series over time', () => {
  it('a sum over alert buckets the counters never measured is a floor, with the count of gaps', () => {
    const trends = { buckets: [{ alerts: 10 }, { alerts: null }, { alerts: 5 }, {}] } as unknown as MetricsTrends;
    expect(alertSeriesFacts(trends)).toEqual({ total: 15, unmeasured: 2 });
    expect(alertSeriesFacts({ buckets: [{ alerts: null }] } as unknown as MetricsTrends)).toEqual({ total: null, unmeasured: 1 });
  });

  it('cases whose severity could not be read stack as Unknown, so the stacks add up', () => {
    const b = breakdown({
      by: 'severity',
      bucket: 'day',
      buckets: [{ label: '21 Oct 2026', in_progress: false, other_count: null }],
      groups: [
        { ...group('high', 3), bucket: '21 Oct 2026' },
        { ...group('low', 2), bucket: '21 Oct 2026' },
        { ...group(null, 1), bucket: '21 Oct 2026' },
      ],
    } as never);
    const series = severitySeries(b);
    expect(series.map((s) => s.label)).toEqual(['High', 'Low', 'Unknown']);
    expect(series.reduce((a, s) => a + (s.values[0] ?? 0), 0)).toBe(6);
  });

  it('outcomes keep to one family and account for what they leave out', () => {
    const b = breakdown({
      by: 'verdict',
      bucket: 'day',
      buckets: [{ label: '21 Oct 2026', in_progress: false, other_count: null }],
      groups: [
        { ...group('TRUE_POSITIVE', 2, { analyst_tp: 1, analyst_ungraded: 1 }), bucket: '21 Oct 2026' },
        { ...group('FALSE_POSITIVE', 5, { analyst_fp: 4, analyst_ungraded: 1 }), bucket: '21 Oct 2026' },
        { ...group(null, 1, { analyst_ungraded: 1 }), bucket: '21 Oct 2026' },
      ],
    } as never);
    const ai = outcomeSeries(b, 'ai');
    expect(ai.series.map((s) => s.label)).toEqual(['True positive', 'Needs human']);
    expect(ai.note).toBe('False positives (5) are left out so the threats stay visible. 1 case has no AI verdict yet.');
    const analyst = outcomeSeries(b, 'analyst');
    expect(analyst.series.map((s) => s.label)).toEqual(['Confirmed true positive', 'Not graded']);
    expect(analyst.shown).toBe(4);
  });

  it('severity over time reads hourly within a day unless the operator chose day or week', () => {
    expect(severityBucket({}, 24)).toBe('hour');
    expect(severityBucket({}, 168)).toBe('day');
    expect(severityBucket({}, 720)).toBe('day');
    expect(severityBucket({ bucket: 'week' }, 24)).toBe('week');
    expect(severityBucket({ bucket: 'day' }, 24)).toBe('day');
    expect(severityBucket({ bucket: 'hour' }, 720)).toBe('day');
    expect(severityTrendRequest({}, 24)).toEqual({ key: 'breakdown', query: { by: 'severity', bucket: 'hour' } });
  });

  it('Human vs AI ticks use the one day label format, in UTC', () => {
    const ms = Date.parse('2026-10-28T06:00:00Z');
    expect(humanVsAiTick(ms, 1440, 720)).toBe('Oct 28');
    expect(humanVsAiTick(ms, 60, 168)).toBe('Oct 28 06:00');
    expect(humanVsAiTick(ms, 360, 168)).toBe('Oct 28 06:00');
    expect(humanVsAiTick(ms, 60, 24)).toBe('06:00');
    expect(humanVsAiTick(Number.NaN, 60, 24)).toBe('');
  });

  it('a window reads outcomes hourly in a day, daily in a week, weekly beyond', () => {
    expect([24, 168, 720, 2160].map(outcomeBucket)).toEqual(['hour', 'day', 'week', 'week']);
    expect(caseTrendTitle({ series: 'outcomes' })).toBe('Outcomes over time');
    expect(caseTrendTitle({ series: 'bogus' })).toBe('Arrivals and closures');
  });
});

// --------------------------------------------------------------------------- //
// Breakdowns
// --------------------------------------------------------------------------- //

describe('breakdowns', () => {
  it('name each key in plain words, names verbatim', () => {
    expect(breakdownKeyLabel('verdict', null)).toBe('No verdict yet');
    expect(breakdownKeyLabel('assignee', '')).toBe('Unassigned');
    expect(breakdownKeyLabel('closed_by', 'agent')).toBe('AI agent');
    expect(breakdownKeyLabel('rule', 'Web scanner user agent detected')).toBe('Web scanner user agent detected');
  });

  it('a group that counts no case of the population is not a row, and the rest is one exact Other row', () => {
    const b = breakdown({
      by: 'rule',
      groups: [group('a', 4), group('only_open_now', 0, { open_now: 2 })],
      other: { count: 6, groups: 3, calls: null, cost_usd: null },
    } as never);
    expect(breakdownBarItems(b, 'rule').map((i) => [i.label, i.value])).toEqual([
      ['a', 4],
      ['Other (3 more)', 6],
    ]);
    expect(topRuleRows(b).map((g) => g.key)).toEqual(['a']);
  });

  it('the AI false-positive share is never shown for a rule with no AI verdict', () => {
    expect(aiFalsePositiveShare(group('r', 6, { verdicted: 0 }))).toBeNull();
    expect(aiFpText(null)).toBe('No AI verdict yet');
    expect(aiFpText(aiFalsePositiveShare(group('r', 30, { verdicted: 30, verdict_fp: 29 })))).toBe('97%');
  });

  it('a source row is named as Connector health names it, else by its id', () => {
    const b = breakdown({ by: 'source' as never, groups: [group('demo-qradar', 9), group('demo-unknown', 2)] });
    const names = sourceNames({
      sources: [
        { source_id: 'demo-qradar', source_name: 'IBM QRadar SIEM' },
        { source_id: 'demo-blank', source_name: '  ' },
      ],
    } as never);
    expect(breakdownBarItems(b, 'source' as never, names).map((i) => i.label)).toEqual(['IBM QRadar SIEM', 'demo-unknown']);
    // Without the sources list (no grant), the ids.
    expect(breakdownBarItems(b, 'source' as never).map((i) => i.label)).toEqual(['demo-qradar', 'demo-unknown']);
    // Names apply to source rows only.
    expect(breakdownBarItems(breakdown({ groups: [group('demo-qradar', 1)] }), 'rule' as never, names)[0].label).toBe('demo-qradar');
    // A source breakdown reads the sources list up front only for a viewer who may read sources.
    expect(caseBreakdownRequests({ by: 'source' }, { can: () => true }).map((r) => r.key)).toEqual(['breakdown', 'sourcesHealth']);
    expect(caseBreakdownRequests({ by: 'source' }, { can: (r) => r !== 'sources' }).map((r) => r.key)).toEqual(['breakdown']);
    expect(caseBreakdownRequests({ by: 'severity' }, { can: () => true }).map((r) => r.key)).toEqual(['breakdown']);
  });

  it('the exit lists the cases, open ones for the open stock', () => {
    expect(breakdownExit(false)).toEqual({ label: 'View cases', page: 'cases', opts: undefined });
    expect(breakdownExit(true)).toEqual({ label: 'View cases', page: 'cases', opts: { status: '__active__' } });
    expect(caseBreakdownTitle({ by: 'rule', population: 'open' })).toBe('Open cases by detection rule');
    expect(caseBreakdownTitle({})).toBe('Cases by status');
  });

  it('verdict shares are of the window, a tiny share never reads 0%', () => {
    const b = breakdown({ groups: [group('FALSE_POSITIVE', 995), group('TRUE_POSITIVE', 4), group(null, 1)] });
    const items = verdictMixItems(b);
    expect(items.map((i) => [i.label, i.sub])).toEqual([
      // 995 of 1,000 is short of all of them: ">99%", never "100%".
      ['False positive', ">99% of the window's cases"],
      ['True positive', "<1% of the window's cases"],
      ['No verdict yet', "<1% of the window's cases"],
    ]);
  });
});

// --------------------------------------------------------------------------- //
// Shift
// --------------------------------------------------------------------------- //

describe('shift widgets', () => {
  it('rank breached cases first (most overdue first), then those about to breach, then by urgency', () => {
    const report = normalizeReport({
      ...(SHIFT_REPORT as unknown as Partial<StandupReport>),
      attention_queue: [
        { case_id: 'u', title: 'urgent', urgency: 3, age_minutes: 10 },
        { case_id: 'b1', title: 'breached a little', urgency: 0.1, age_minutes: 200 },
        { case_id: 'r', title: 'at risk', urgency: 0.2, age_minutes: 100 },
        { case_id: 'b2', title: 'breached a lot', urgency: 0.1, age_minutes: 900 },
      ],
      sla_aging: {
        enabled: true,
        totals: { open: 4, breached: 2, about_to_breach: 1 },
        breached: [
          { case_id: 'b1', overdue_minutes: 20, target_minutes: 120, age_minutes: 140 },
          { case_id: 'b2', overdue_minutes: 780, target_minutes: 120, age_minutes: 900 },
        ],
        about_to_breach: [{ case_id: 'r', target_minutes: 120, age_minutes: 100 }],
      },
    } as unknown as Partial<StandupReport>);
    const ranked = rankAttention(report);
    expect(ranked.map((r) => r.row.case_id)).toEqual(['b2', 'b1', 'r', 'u']);
    expect(ranked[0].sla).toEqual({ state: 'breached', text: 'Response 13h over' });
    expect(ranked[2].sla).toEqual({ state: 'at_risk', text: 'Response due in 20m' });
    expect(ranked[3].sla).toBeNull();
  });

  it('a breached case outside the server\'s 25 most urgent still ranks first, and the total is every open case', () => {
    const queue = Array.from({ length: 25 }, (_, i) => ({
      case_id: `q${i}`,
      case_number: `CASE-${String(i).padStart(6, '0')}`,
      title: `queued ${i}`,
      status: 'new',
      risk_score: 80,
      urgency: 2 - i / 100,
      age_minutes: 30,
    }));
    const report = normalizeReport({
      ...(SHIFT_REPORT as unknown as Partial<StandupReport>),
      attention_queue: queue,
      sla_aging: {
        enabled: true,
        totals: { open: 140, breached: 1, about_to_breach: 0 },
        breached: [
          { case_id: 'late', display_id: 'CASE-000140', priority_level: 'P4', overdue_minutes: 30, target_minutes: 240, age_minutes: 270, assignee: 'ana' },
        ],
        about_to_breach: [],
      },
    } as unknown as Partial<StandupReport>);
    const ranked = rankAttention(report);
    expect(ranked).toHaveLength(26);
    expect(ranked[0].row.case_id).toBe('late');
    expect(ranked[0].slaOnly).toBe(true);
    expect(ranked[0].row).toMatchObject({ display_id: 'CASE-000140', assignee: 'ana', age_minutes: 270, status: '' });
    expect(Number.isFinite(ranked[0].row.risk_score)).toBe(false);
    expect(ranked[0].sla).toEqual({ state: 'breached', text: 'Response 30m over' });
    expect(ranked.slice(1).every((r) => !r.slaOnly)).toBe(true);
    // "8 of 140 shown", never "8 of 25": the total is every open case the report counted.
    expect(attentionTotal(report)).toBe(140);
    expect(attentionTotal({ ...report, sla_aging: { ...report.sla_aging, totals: { ...report.sla_aging.totals, open: 0 } } })).toBe(25);
  });

  it('the SLA list says how many rows there are when the server cut it to 25', () => {
    const rows = Array.from({ length: 25 }, () => ({}));
    expect(slaBreachTotal({ response_breached: 12, response_at_risk: 8, resolve_breached: 6, resolve_at_risk: 4, breaching: rows })).toBe(30);
    expect(slaBreachTotal({ response_breached: 2, breaching: rows.slice(0, 2) })).toBe(2);
    expect(slaBreachTotal({ breaching: rows.slice(0, 3) })).toBe(3);
  });

  it('say how far over or how much is left', () => {
    expect(slaClockText({ state: 'breached', elapsed_minutes: 138, target_minutes: 120 })).toBe('18m over');
    expect(slaClockText({ state: 'at_risk', elapsed_minutes: 114, target_minutes: 120 })).toBe('6m left');
  });

  it('label all six age buckets, a bucket the server left out reading 0', () => {
    const rows = agingRows({ aging: { age_buckets: [{ bucket: '>7d', count: 2 }] } } as unknown as PostureResponse);
    expect(rows.map((r) => r.bucket)).toEqual([...AGE_BUCKETS]);
    expect(rows.map((r) => r.count)).toEqual([0, 0, 0, 0, 0, 2]);
  });
});

// --------------------------------------------------------------------------- //
// Human vs AI, ATT&CK, campaigns, sources, spend
// --------------------------------------------------------------------------- //

describe('the other modules', () => {
  it('Human vs AI shows no partition when the store could not be read (zeros are no measurement)', () => {
    const outage = posture({ window_covered: false, open_now: { count: 0, complete: false } });
    expect(humanVsAiTotals(outage as unknown as PostureResponse)).toBeNull();
    expect(humanVsAiTotals(posture() as unknown as PostureResponse)).toEqual({ ai: 31, human: 2, system: 0, closed: 33 });
  });

  it('the heatmap keeps the matrix order of tactics whatever order the answer gives', () => {
    const tactic = (name: string) => ({ tactic: name, techniques: [{ id: 'T1', name: 'x', case_count: 1 }] });
    const data = {
      covered_techniques: 4,
      by_tactic: { z: tactic('Impact'), a: tactic('Some new tactic'), b: tactic('Initial Access'), c: tactic('Execution') },
    } as unknown as MitreCoverageResponse;
    expect(heatmapColumns(data).map((c) => c.tactic)).toEqual(['Initial Access', 'Execution', 'Impact', 'Some new tactic']);
    expect(heatmapColumns({ ...data, covered_techniques: 0 })).toEqual([]);
    expect(ATTACK_TACTIC_ORDER.indexOf('Initial Access')).toBeLessThan(ATTACK_TACTIC_ORDER.indexOf('Impact'));
  });

  it('telemetry gaps never read as healthy when gap capture does not exist yet', () => {
    const base = { status: 'not_available', recommendations: [], scanned_cases: 77, truncated: false, evidence_schema: 'v1', not_available_reason: 'None recorded.' };
    const off = telemetryState({ ...base, capture_status: 'not_available', capture_not_available_reason: 'Query tools do not emit it yet.' } as TelemetryRecommendationsResponse);
    expect(off).toEqual({ kind: 'unavailable', title: 'Telemetry gap capture is not available yet', description: 'Query tools do not emit it yet.' });
    const ran = telemetryState({ ...base, capture_status: 'available' } as TelemetryRecommendationsResponse);
    expect(ran).toEqual({ kind: 'empty', title: 'No telemetry gap found', description: 'None recorded.' });
    const rows = { ...base, status: 'available', capture_status: 'not_available', recommendations: [{ field: 'x' }] };
    expect(telemetryState(rows as unknown as TelemetryRecommendationsResponse)).toBeNull();
  });

  it('a panel table switches to its list below the width its columns need', () => {
    // Fixed widths plus 10 rem for each flexible column, up to the next step.
    expect(panelFit([{ label: 'Rule' }, { label: 'Cases', width: '5rem' }, { label: 'FP rate', width: '7.5rem' }])).toBe(28);
    expect(panelFit([{ label: 'Rule' }, { label: 'Cases', width: '9rem' }, { label: 'Open', width: '5.5rem' }, { label: 'FP', width: '7rem' }])).toBe(32);
    expect(
      panelFit([
        { label: 'Case' },
        { label: 'Risk', width: '5.5rem' },
        { label: 'SLA', width: '11rem' },
        { label: 'Age', width: '5rem' },
        { label: 'Assignee', width: '8rem' },
      ]),
    ).toBe(40);
    // A width not in rem counts as a flexible column; anything wider takes the top step.
    expect(panelFit([{ label: 'A', width: '120px' }])).toBe(28);
    expect(panelFit(Array.from({ length: 6 }, (_, i) => ({ label: `c${i}` })))).toBe(44);
  });

  it('the laptop grid pairs halves in reading order and never leaves a hole', () => {
    // SOC operations: strip, then 8+4, 8+4, 4+4+4, then the full-width timing row.
    expect(laptopSpans([true, false, false, false, false, false, false, false, true])).toEqual([2, 1, 1, 1, 1, 1, 1, 2, 2]);
    expect(laptopSpans([false, false, false])).toEqual([1, 1, 2]);
    expect(laptopSpans([false])).toEqual([2]);
    expect(laptopSpans([])).toEqual([]);
    // Every row adds up to two columns.
    const spans = laptopSpans([true, false, true, false, false, false, true, false]);
    let row = 0;
    for (const s of spans) {
      row += s;
      expect(row).toBeLessThanOrEqual(2);
      if (row === 2) row = 0;
    }
    expect(row).toBe(0);
  });

  it('a campaign is named by its shared entity and case count, never by its internal id', () => {
    const c = { id: 'campaign-1e57287ac9b1', name: '', case_count: 1, entities: [{ entity_type: 'ip', value: ' 198.51.100.23 ' }] } as unknown as Campaign;
    expect(campaignLabel(c)).toBe('198.51.100.23 · 1 case');
    expect(campaignLabel({ ...c, entities: [], case_count: 3 })).toBe('Related cases · 3 cases');
  });

  it('a source is turned off, silent or healthy; an unusable time is no age', () => {
    const row = { enabled: true, silent: false } as never;
    expect(connectorState(row)).toBe('healthy');
    expect(connectorState({ enabled: true, silent: true } as never)).toBe('silent');
    expect(connectorState({ enabled: false, silent: true } as never)).toBe('off');
    expect(ageFromMillis(0)).toBe(DASH);
    expect(ageFromMillis(Number.NaN)).toBe(DASH);
  });

  it('recent cases are the newest twelve', () => {
    const cases = Array.from({ length: 14 }, (_, i) => ({ case_id: `c${i}`, created_at: `2026-10-${String(i + 10).padStart(2, '0')}T00:00:00Z` }));
    const rows = recentCaseRows(cases as never);
    expect(rows).toHaveLength(12);
    expect(rows[0].case_id).toBe('c13');
  });

  it('AI spend separates chat, outside the budget, and states the budget period with a cap', () => {
    expect(exemptSpend(USAGE as never, ['chat'])).toBe(0.25);
    const budget = { enabled: true, daily: { spent: 1, cap: 10, fraction: 0.1 }, monthly: { spent: 12, cap: null, fraction: null } } as unknown as BudgetStatus;
    expect(budgetLine(budget, 'USD')).toBe('$1.00 of $10.00 today (10%)');
    expect(budgetLine({ ...budget, enabled: false }, 'USD')).toBe('No AI budget is set.');
    expect(budgetLine({ ...budget, daily: { spent: 1, cap: null, fraction: null } } as unknown as BudgetStatus, 'USD')).toBe(
      'No AI budget cap is set.',
    );
  });
});

describe('copy', () => {
  it('a change, a share and a spend never read as less than the source said', () => {
    expect(signedDuration(0)).toBe('0m');
    expect(signedDuration(18)).toBe('+18m');
    expect(signedDuration(-65)).toBe('-1h 5m');
    expect(signedDuration(0.3)).toBe('+<1m');
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.001)).toBe('<1%');
    expect(shareText(0.546)).toBe('55%');
    expect(moneyText(0.00002, 'USD')).toBe('<$0.0001');
    // An exact zero is plain money; a real but tiny amount is never "$0.0000".
    expect(moneyText(0, 'USD')).toBe('$0.00');
    expect(moneyText(0.00001, 'USD')).toBe('<$0.0001');
    // A share short of the whole never reads as all of it.
    expect(shareText(0.996)).toBe('>99%');
    expect(shareText(0.995)).toBe('>99%');
    expect(shareText(0.994)).toBe('99%');
    expect(shareText(1)).toBe('100%');
    expect(shareText(Number.NaN)).toBe(DASH);
    expect(percentText(99.9)).toBe('>99%');
    expect(percentText(0.2)).toBe('<1%');
    // The Alert reduction rule follows the same share rule.
    expect(
      alertReduction(
        noise({ stages: [{ key: 'ingested', label: 'Ingested', total: 1000 }, { key: 'cases', label: 'Cases', total: 1 }] } as never),
      ).text,
    ).toBe('>99%');
    expect(moneyText(12.5, 'USD')).toBe('$12.50');
    const tiny = { enabled: true, daily: { spent: 0.00001, cap: 10, fraction: 0.000001 }, monthly: { spent: 0, cap: null, fraction: null } } as unknown as BudgetStatus;
    expect(budgetLine(tiny, 'USD')).toBe('<$0.0001 of $10.00 today (<1%)');
    // $299 of $300 is not an exhausted budget.
    const nearly = { enabled: true, daily: { spent: 299, cap: 300, fraction: 299 / 300 }, monthly: { spent: 0, cap: null, fraction: null } } as unknown as BudgetStatus;
    expect(budgetLine(nearly, 'USD')).toBe('$299.00 of $300.00 today (>99%)');
  });

  it('a count of exactly one takes the singular noun', () => {
    expect(countOf(1, 'case')).toBe('1 case');
    expect(countOf(0, 'case')).toBe('0 cases');
    expect(countOf(1234, 'analyst review')).toBe('1,234 analyst reviews');
    expect(countOf(1, 'more rule')).toBe('1 more rule');
  });

  it('every reason these readers produce is a plain sentence with no em dash', () => {
    const texts = [
      SHIFT_OFF_REASON,
      SHIFT_UNREAD_REASON,
      PARTIAL_COVERAGE_NOTE,
      ...Object.values(AUTO_CLOSE_STATUS_WORDS).map((w) => w.label),
      ...funnelRows(noise() as NoiseReduction, { caseStages: true }).map((r) => r.note),
    ];
    for (const t of texts) {
      expect(t, t).not.toMatch(/[\u2013\u2014]/);
      expect(t.toLowerCase(), t).not.toContain('playbook');
    }
  });
});
