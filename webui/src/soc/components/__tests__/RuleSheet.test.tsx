/**
 * The rule sheet (Round 14, SPEC §4.6.4, operator choice C4 option A): one detection
 * rule's picture from `GET /api/rules/summary`, with the latest alerts from
 * `GET /api/logs?rule=` and "Open all N in Logs" as its main action.
 *
 * Pinned here: the key figures and their honesty (the number in the main action only
 * when the count is exact), the actions' targets, every section's loading, empty, error
 * and permission line, Demo Mode re-reads, the window picker, the phone structure, plain
 * text for untrusted values and the copy rules. jsdom has no layout: geometry is checked
 * by the live harness.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { summaryMock, logsMock, navigate, authState, demoState } = vi.hoisted(() => ({
  summaryMock: vi.fn(),
  logsMock: vi.fn(),
  navigate: vi.fn(),
  authState: { denied: new Set<string>() },
  demoState: {
    value: {
      status: { mode: 'off', active: false, run_id: null } as { mode: string; active: boolean; run_id: string | null },
      active: false,
      loading: false,
      confirmed: true as boolean | undefined,
      refresh: async () => ({ mode: 'off', active: false, run_id: null }),
    },
  },
}));

vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({
    username: 'analyst',
    hasPermission: (resource: string, action: string) => !authState.denied.has(`${resource}:${action}`),
  });
  return { useAuth: auth, useOptionalAuth: auth };
});
vi.mock('@/soc/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/router')>()),
  useNavigateOptional: () => navigate,
}));
vi.mock('@/soc/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/demo')>()),
  useDemo: () => demoState.value,
}));

import { TooltipProvider } from '@/ui/tooltip';
import type { RuleSummary } from '@/lib/types-rules';
import { hashRoute } from '@/soc/route-link';
import {
  RuleSheet,
  alertsChartBlock,
  bucketWords,
  exactAlertCount,
  initialRuleWindow,
  openInLogsLabel,
  ruleLogsHref,
  seenLine,
  tuningChangeText,
  windowAnnouncement,
  windowLabel,
  windowParam,
  windowPhrase,
} from '../RuleSheet';
import type { RuleSheetRequest } from '../rule-sheet-store';
import { RULE, latestFixture, summaryFixture } from './rule-sheet.fixtures';

const REQUEST: RuleSheetRequest = { rule: RULE, origin: 'your answer', hostId: 'host-1', seq: 1 };

function renderSheet(request: Partial<RuleSheetRequest> = {}, onOpenChange = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <RuleSheet id="rule-sheet-test" request={{ ...REQUEST, ...request }} open onOpenChange={onOpenChange} />
    </TooltipProvider>,
  );
  return { ...utils, onOpenChange };
}

async function openSheet(summary: RuleSummary = summaryFixture(), request: Partial<RuleSheetRequest> = {}) {
  summaryMock.mockResolvedValue(summary);
  const utils = renderSheet(request);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('group', { name: 'Rule key figures' });
  return { ...utils, dialog };
}

beforeEach(() => {
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  summaryMock.mockReset();
  logsMock.mockReset();
  navigate.mockReset();
  authState.denied = new Set();
  demoState.value = {
    ...demoState.value,
    status: { mode: 'off', active: false, run_id: null },
    active: false,
    confirmed: true,
  };
});

describe('rule sheet helpers', () => {
  it('sends a relative window as itself and anything else as a range', () => {
    expect(windowParam({ from: 'now-3d', to: 'now' })).toBe('now-3d');
    expect(windowParam({ from: 'now-24h', to: 'now' })).toBe('now-24h');
    expect(windowParam({ from: '2026-10-22T00:00:00Z', to: '2026-10-25T00:00:00Z' })).toBe(
      '2026-10-22T00:00:00Z..2026-10-25T00:00:00Z',
    );
    expect(windowParam({ from: '2026-10-22T00:00:00Z', to: 'now' })).toBe('2026-10-22T00:00:00Z..now');
  });

  it('starts on the opener window or the last 3 days, with a readable label', () => {
    expect(initialRuleWindow(undefined)).toEqual({ from: 'now-3d', to: 'now', label: 'Last 3 days' });
    expect(initialRuleWindow({ from: 'now-7d', to: 'now' }).label).toBe('Last 7 days');
    expect(initialRuleWindow({ from: 'now-2h', to: 'now' }).label).toBe('Last 2 hours');
    expect(windowLabel({ from: '2026-10-22T00:00:00Z', to: '2026-10-25T00:00:00Z' })).toMatch(/^Oct 22(, 2026)? to Oct 25(, 2026)?$/);
    expect(windowLabel({ from: 'x', to: 'y', label: 'From the answer' })).toBe('From the answer');
  });

  it('words a window inside a sentence and a bucket width', () => {
    expect(windowPhrase('Last 3 days')).toBe('in the last 3 days');
    // A count of one reads as the unit alone, never "in the last 1 hour".
    expect(windowPhrase('Last 1 hour')).toBe('in the last hour');
    expect(windowPhrase('Last 1 day')).toBe('in the last day');
    expect(windowPhrase('Last 12 hours')).toBe('in the last 12 hours');
    expect(windowPhrase('All time')).toBe('at any time');
    expect(windowPhrase('This week')).toBe('this week');
    expect(bucketWords('12h')).toBe('12 h');
    expect(bucketWords('30m')).toBe('30 min');
    expect(bucketWords('1d')).toBe('1-day');
  });

  it('says when the rule was last and first seen, in UTC', () => {
    const now = new Date('2026-10-25T14:30:00Z');
    expect(seenLine('2026-10-25T14:02:00Z', '2026-10-22T06:41:00Z', now)).toBe(
      'Last seen 14:02 UTC · first seen Oct 22',
    );
    expect(seenLine('2026-10-24T09:05:00Z', null, now)).toBe('Last seen Oct 24 09:05 UTC');
    expect(seenLine(null, '2025-12-30T00:00:00Z', now)).toBe('First seen Dec 30, 2025');
    expect(seenLine(null, null, now)).toBeNull();
  });

  it('names a count in the main action only when it is exact on every source', () => {
    const exact = summaryFixture();
    expect(exactAlertCount(exact)).toBe(381);
    expect(openInLogsLabel(381)).toBe('Open all 381 in Logs');
    expect(openInLogsLabel(1234)).toBe('Open all 1,234 in Logs');
    const floor = summaryFixture({ alerts: { ...exact.alerts, count_relation: 'gte' } });
    expect(exactAlertCount(floor)).toBeNull();
    const sampledSource = summaryFixture({
      alerts: { ...exact.alerts, sources: [{ id: 'src-1', name: 'Wazuh', exact: false }] },
    });
    expect(exactAlertCount(sampledSource)).toBeNull();
    // `unsupported` describes the chart; an exact count is still exact (A6a refinement).
    const sampledChart = summaryFixture({ alerts: { ...exact.alerts, status: 'unsupported' } });
    expect(exactAlertCount(sampledChart)).toBe(381);
    expect(openInLogsLabel(null)).toBe('Open in Logs');
    expect(openInLogsLabel(0)).toBe('Open in Logs');
  });

  it('builds the Logs link with an exact Rule is filter that round-trips spaces and other letters', () => {
    const rule = 'Fehlgeschlagene Anmeldung über SSH';
    const href = ruleLogsHref(rule, '2026-10-22T06:00:00+00:00', '2026-10-25T06:12:00+00:00', 'src-1');
    const route = hashRoute(href);
    expect(route?.page).toBe('logs');
    expect(route?.opts).toMatchObject({
      rule,
      from: '2026-10-22T06:00:00+00:00',
      to: '2026-10-25T06:12:00+00:00',
      sourceId: 'src-1',
    });
    expect(hashRoute(ruleLogsHref(rule, 'now-3d', 'now'))?.opts).not.toHaveProperty('sourceId');
  });

  it('stacks the series by named level, Critical first, leaving out levels without an alert', () => {
    const block = alertsChartBlock(summaryFixture().alerts.series, { now: new Date('2026-10-25T08:00:00Z') });
    expect(block?.kind).toBe('stacked_bar');
    expect(block?.series.map((s) => s.label)).toEqual(['High', 'Medium']);
    expect(block?.series.map((s) => s.semantic)).toEqual(['high', 'medium']);
    // Dated ticks: a midnight bucket names the day, a noon bucket adds the time.
    expect(block?.x.labels?.slice(0, 3)).toEqual(['Oct 22', '12:00', 'Oct 23']);
    expect(alertsChartBlock({ bucket: '12h', levels: [], points: [{ t: '2026-10-22T00:00:00Z', critical: 0, high: 0, medium: 0, low: 0, info: 0 }] })).toBeNull();
    // A sub-day series names its first day once, then the time of day.
    const minutes = alertsChartBlock(
      {
        bucket: '15m',
        levels: [],
        points: ['18:30', '18:45', '19:00'].map((hm) => ({ t: `2026-10-28T${hm}:00Z`, critical: 1, high: 0, medium: 0, low: 0, info: 0 })),
      },
      { now: new Date('2026-10-28T20:00:00Z') },
    );
    expect(minutes?.x.labels).toEqual(['Oct 28 18:30', '18:45', '19:00']);
    expect(minutes?.series.map((s) => s.label)).toEqual(['Critical']);
    expect(alertsChartBlock(null)).toBeNull();
  });

  it('words a tuning proposal in one plain sentence', () => {
    expect(tuningChangeText({ kind: 'correlation_n', before: 3, after: 4, requires_approval: true })).toBe(
      'Raise the correlation threshold from 3 to 4, waiting for approval.',
    );
    expect(tuningChangeText({ kind: 'severity_floor', before: 20, after: 30, shadow_blocked: true })).toBe(
      'Raise the severity floor from 20 to 30, held because it would hide a confirmed threat.',
    );
    expect(tuningChangeText(null)).toBeNull();
  });

  it('words a finding that changes no threshold as what it is, never "from 3 to 3"', () => {
    // The tuner's evidence request: enough cases, too few analyst grades (before == after).
    const evidence = tuningChangeText({
      kind: 'evidence_collection',
      before: 3,
      after: 3,
      auto_apply: false,
      requires_approval: true,
      shadow_blocked: false,
    });
    expect(evidence).toBe('Needs more analyst-graded cases before a change can be proposed.');
    expect(evidence).not.toMatch(/from 3 to 3|waiting for approval/);
    expect(tuningChangeText({ kind: 'correlation_n_inert', before: 1, after: 1 })).toMatch(/^Raising the correlation threshold would change nothing here/);
    // Any other kind names a span only when something changes.
    expect(tuningChangeText({ kind: 'suppression', before: 1, after: 1, requires_approval: true })).toBe(
      'Suppress the rule, waiting for approval.',
    );
  });
});

describe('the window announcement', () => {
  it('says what a newly chosen window shows, as a floor when the count is one, and nothing it did not count', () => {
    expect(windowAnnouncement(summaryFixture(), false, 'Last 7 days')).toBe('Last 7 days: 381 alerts from this rule.');
    const one = summaryFixture();
    expect(windowAnnouncement({ ...one, alerts: { ...one.alerts, count: 1 } }, false, 'Last 24 hours')).toBe(
      'Last 24 hours: 1 alert from this rule.',
    );
    expect(
      windowAnnouncement({ ...one, alerts: { ...one.alerts, count: 1000, count_relation: 'gte' } }, false, 'Last 30 days'),
    ).toBe('Last 30 days: at least 1,000 alerts from this rule.');
    expect(windowAnnouncement({ ...one, alerts: { ...one.alerts, count: 0 } }, false, 'Last 3 days')).toBe(
      'Last 3 days: no alerts from this rule.',
    );
    expect(
      windowAnnouncement({ ...one, alerts: { ...one.alerts, count: 0, count_relation: 'gte' } }, false, 'Last 3 days'),
    ).toBe('Last 3 days: no alerts from this rule were found.');
    expect(
      windowAnnouncement({ ...one, alerts: { ...one.alerts, status: 'forbidden', count: null } }, false, 'Last 3 days'),
    ).toBe('Last 3 days: the alert figures are not available.');
    // No source could be read: no series, no figure stated.
    expect(
      windowAnnouncement({ ...one, alerts: { ...one.alerts, status: 'unsupported', series: null, count: 0 } }, false, 'Last 3 days'),
    ).toBe('Last 3 days: the alert figures are not available.');
    expect(windowAnnouncement(null, true, 'Last 7 days')).toBe('Last 7 days: this rule could not be loaded.');
    expect(windowAnnouncement(null, false, 'Last 7 days')).toBe('');
  });
});

describe('the rule sheet', () => {
  it('opens on the rule as its title, names where it came from and moves focus to the title', async () => {
    const { dialog } = await openSheet();
    const title = within(dialog).getByRole('heading', { name: RULE });
    expect(title.tagName).toBe('H2');
    expect(title).toHaveClass('font-mono');
    expect(title.querySelector('a, button')).toBeNull();
    expect(dialog).toHaveAccessibleDescription('From your answer');
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(summaryMock).toHaveBeenCalledWith({ rule: RULE, window: 'now-3d' }, expect.any(AbortSignal));
    expect(logsMock).toHaveBeenCalledWith({ rule: RULE, from: 'now-3d', to: 'now', limit: 5 });
  });

  it('shows the key figures on one strip with the analyst family only, and when it was seen', async () => {
    const { dialog } = await openSheet();
    const strip = within(dialog).getByRole('group', { name: 'Rule key figures' });
    expect(within(strip).getByTestId('kpi-rule-alerts')).toHaveTextContent('Alerts381in the last 3 days');
    expect(within(strip).getByTestId('kpi-rule-cases')).toHaveTextContent('Cases3all time');
    // "Still open" says of how many, never "open now" again.
    expect(within(strip).getByTestId('kpi-rule-open')).toHaveTextContent('Still open2of 3 cases');
    expect(within(strip).getByTestId('kpi-rule-outcome')).toHaveTextContent(
      'Analyst outcome1 confirmed1 benign · 1 not graded',
    );
    expect(within(dialog).getByTestId('rule-seen')).toHaveTextContent(/^Last seen .+ UTC · first seen Oct 22(, 2026)?$/);
  });

  it('shows Still open from the first case, in the singular, and says when no case is graded yet', async () => {
    const base = summaryFixture();
    const { dialog } = await openSheet(
      summaryFixture({
        cases: {
          status: 'ok',
          reason: null,
          count: 1,
          open_now: 0,
          outcomes: { analyst_tp: 0, analyst_fp: 0, analyst_ungraded: 1 },
          latest: base.cases.latest.slice(2),
        },
        tuning: { ...base.tuning, wilson_lower_bound: null, samples: 0 },
      }),
    );
    const strip = within(dialog).getByRole('group', { name: 'Rule key figures' });
    expect(within(strip).getByTestId('kpi-rule-open')).toHaveTextContent('Still open0of 1 case');
    expect(within(dialog).getByRole('region', { name: 'About this rule' })).toHaveTextContent('No analyst-graded cases yet');
  });

  it('marks a sampled count as a floor and never names it in the main action', async () => {
    const base = summaryFixture();
    const { dialog } = await openSheet(
      summaryFixture({ alerts: { ...base.alerts, count: 1000, count_relation: 'gte', sources: [{ id: 'src-1', name: 'Wazuh', exact: false }] } }),
    );
    const tile = within(dialog).getByTestId('kpi-rule-alerts');
    expect(tile).toHaveTextContent('1,000');
    // Short enough for the tile's two-line reserve (the strip's numerals stay on one row);
    // why it is a floor is said under the chart, so the tile never claims a sample.
    expect(tile.querySelector('[data-kpi-line="bound"]')).toHaveTextContent(/^At least this many$/);
    expect(tile).not.toHaveTextContent('sampled');
    expect(within(dialog).getByTestId('rule-open-logs')).toHaveTextContent(/^Open in Logs$/);
  });

  it('opens all N in Logs on the exact filtered view, over the resolved window, with the source when filtered', async () => {
    const { dialog } = await openSheet(summaryFixture(), { sourceId: 'src-1' });
    const logs = within(dialog).getByRole('link', { name: 'Open all 381 in Logs' });
    const route = hashRoute(logs.getAttribute('href') ?? '');
    expect(route).toEqual({
      page: 'logs',
      opts: { rule: RULE, from: '2026-10-22T06:00:00+00:00', to: '2026-10-25T06:12:00+00:00', sourceId: 'src-1' },
    });
    // Filtered to one source: its name shows in the header.
    expect(within(dialog).getByText('Splunk Enterprise Security (HEC)', { selector: 'div' })).toBeInTheDocument();
  });

  it('closes, then goes through the router, for a plain click on an action', async () => {
    const { dialog, onOpenChange } = await openSheet();
    fireEvent.click(within(dialog).getByRole('link', { name: 'Show the 3 cases' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('cases', { rule: RULE });
    navigate.mockClear();
    fireEvent.click(within(dialog).getByRole('link', { name: 'Open all 381 in Logs' }));
    expect(navigate).toHaveBeenCalledWith('logs', expect.objectContaining({ rule: RULE }));
  });

  it('keeps the browser behaviour (and the sheet) for a modified click', async () => {
    const { dialog, onOpenChange } = await openSheet();
    fireEvent.click(within(dialog).getByRole('link', { name: 'Open all 381 in Logs' }), { ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('asks AI about the rule with the fenced rule question in a new chat', async () => {
    const summary = summaryFixture({ rule: 'ssh_bruteforce' });
    const { dialog, onOpenChange } = await openSheet(summary, { rule: 'ssh_bruteforce' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask AI about this rule' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('chat', { newChat: true, entity: { kind: 'rule', value: 'ssh_bruteforce' } });
  });

  it('offers no Ask AI for a value the rule question cannot take, nor to a viewer without chat', async () => {
    // Spaces: the server's entity grammar takes one token only.
    const { dialog, unmount } = await openSheet();
    expect(within(dialog).queryByRole('button', { name: 'Ask AI about this rule' })).toBeNull();
    unmount();
    authState.denied = new Set(['cases:read']);
    const summary = summaryFixture({ rule: 'ssh_bruteforce' });
    const second = await openSheet(summary, { rule: 'ssh_bruteforce' });
    expect(within(second.dialog).queryByRole('button', { name: 'Ask AI about this rule' })).toBeNull();
  });

  it('draws alerts over time by severity, with its honest caption', async () => {
    const { dialog } = await openSheet();
    const section = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(section).toHaveTextContent('12 h buckets · times in UTC · exact');
    expect(within(section).getByRole('group', { name: /^Alerts over time by severity\. Stacked column chart/ })).toBeInTheDocument();
  });

  it('says when the chart is drawn from a sample, with the server reason', async () => {
    const base = summaryFixture();
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { ...base.alerts, status: 'unsupported', reason: 'The count is exact. The chart is drawn from the newest 200 events.' },
      }),
    );
    const section = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(section).toHaveTextContent('12 h buckets · times in UTC · sampled');
    expect(section).toHaveTextContent('The count is exact. The chart is drawn from the newest 200 events.');
    // The count is exact, so the main action names it.
    expect(within(dialog).getByTestId('rule-open-logs')).toHaveTextContent('Open all 381 in Logs');
  });

  it('calls a figure that is not exact "not exact", never "sampled", when nothing was sampled', async () => {
    const base = summaryFixture();
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { ...base.alerts, count_relation: 'gte', reason: '1 of 3 sources did not answer.' },
        top_source_ips: { ...base.top_source_ips, exact: false, reason: '1 of 3 sources did not answer.' },
        top_targets: {
          ...base.top_targets,
          exact: false,
          reason: 'The log store approximates top values across its shards, so a count may be low or a busier value missing.',
        },
      }),
    );
    const chart = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(chart).toHaveTextContent('12 h buckets · times in UTC · not exact');
    expect(chart).not.toHaveTextContent('sampled');
    expect(chart).toHaveTextContent('1 of 3 sources did not answer.');
    const ips = within(dialog).getByRole('region', { name: 'Top source IPs' });
    expect(ips).toHaveTextContent(/^Top source IPsnot exact/);
    expect(ips).toHaveTextContent('1 of 3 sources did not answer.');
    expect(within(dialog).getByRole('region', { name: 'Top targets' })).toHaveTextContent(/^Top targetsnot exact/);
  });

  it('calls a top list drawn from the newest events "sampled"', async () => {
    const base = summaryFixture();
    const reason = 'Counted from the newest 200 events of the source.';
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { ...base.alerts, status: 'unsupported', count_relation: 'gte', reason },
        top_source_ips: { ...base.top_source_ips, status: 'unsupported', exact: false, reason },
      }),
    );
    expect(within(dialog).getByRole('region', { name: 'Top source IPs' })).toHaveTextContent(/^Top source IPssampled/);
    // An exact list keeps no caption.
    expect(within(dialog).getByRole('region', { name: 'Top targets' })).toHaveTextContent(/^Top targetsweb-portal/);
  });

  it('says once that no source can be read, states no zero and offers no Logs view', async () => {
    const reason = 'No log source can be browsed.';
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { status: 'unsupported', reason, count: null, count_relation: 'gte', first_seen: null, last_seen: null, series: null, sources: [] },
        top_source_ips: { status: 'unsupported', reason, rows: [], exact: false },
        top_targets: { status: 'unsupported', reason, rows: [], exact: false },
      }),
    );
    const chart = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(chart).toHaveTextContent(reason);
    expect(dialog).not.toHaveTextContent(/No alerts from this rule/);
    expect(dialog).not.toHaveTextContent(/No source IP/);
    // The sections drawn from alerts it could not read are left out, not repeated.
    for (const name of ['Top source IPs', 'Top targets', 'Latest alerts']) {
      expect(within(dialog).queryByRole('region', { name })).toBeNull();
    }
    expect(within(dialog).queryByTestId('rule-open-logs')).toBeNull();
    expect(within(dialog).queryByTestId('kpi-rule-alerts')).toBeNull();
    // The case figures still show.
    expect(within(dialog).getByTestId('kpi-rule-cases')).toHaveTextContent('Cases3');
  });

  it('names the filtered source when it cannot be read', async () => {
    const reason = 'That source is not available for browsing.';
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { status: 'unsupported', reason, count: null, count_relation: 'gte', first_seen: null, last_seen: null, series: null, sources: [] },
        top_source_ips: { status: 'unsupported', reason, rows: [], exact: false },
        top_targets: { status: 'unsupported', reason, rows: [], exact: false },
      }),
      { sourceId: 'src-gone' },
    );
    expect(within(dialog).getByRole('region', { name: 'Alerts over time' })).toHaveTextContent(reason);
    expect(within(dialog).queryByTestId('rule-open-logs')).toBeNull();
  });

  it('lists the top source IPs and targets with their counts', async () => {
    const { dialog } = await openSheet();
    const ips = within(dialog).getByRole('region', { name: 'Top source IPs' });
    expect(within(ips).getByRole('list', { name: 'Top source IPs' })).toHaveTextContent('198.51.100.77214');
    const targets = within(dialog).getByRole('region', { name: 'Top targets' });
    expect(targets).toHaveTextContent('web-portalhost352');
    expect(targets).toHaveTextContent('svc-scanuser29');
  });

  it('shows the newest alerts to the person only, newest first, never sent to a model', async () => {
    const { dialog } = await openSheet();
    const section = within(dialog).getByRole('region', { name: 'Latest alerts' });
    const table = await within(section).findByRole('table', { name: 'Latest alerts' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2
    expect(rows[1]).toHaveTextContent('Oct 25 06:12');
    expect(rows[1]).toHaveTextContent('Medium (30)');
    expect(rows[1]).toHaveTextContent('Nuclei user agent, 412 requests a minute');
    expect(section).toHaveTextContent('2 newest of 381 · shown to you only, never sent to the assistant');
  });

  it('keeps the source IP on a phone by moving it under the message', async () => {
    const { dialog } = await openSheet();
    const table = await within(dialog).findByRole('table', { name: 'Latest alerts' });
    const header = within(table).getByRole('columnheader', { name: 'Source IP' });
    expect(header).toHaveClass('max-sm:hidden');
    const inline = within(table).getAllByText('198.51.100.77').find((el) => el.classList.contains('sm:hidden'));
    expect(inline).toBeDefined();
    // Actions stack under the figures on a phone.
    expect(within(dialog).getByTestId('rule-open-logs').parentElement).toHaveClass('flex-col', 'sm:flex-row');
  });

  it('lists the cases from the rule by case number, linked to the Case Manager', async () => {
    const { dialog } = await openSheet();
    const section = within(dialog).getByRole('region', { name: 'Cases from this rule' });
    expect(section).toHaveTextContent('3 cases · all time');
    const link = within(section).getByRole('link', { name: /CASE-000214/ });
    expect(hashRoute(link.getAttribute('href') ?? '')).toEqual({ page: 'case_manager', opts: { caseId: 'case-214' } });
    expect(link).toHaveTextContent('Web scanner against web-portal');
    expect(section).not.toHaveTextContent('case-214');
  });

  it('attributes each case verdict to the AI, so it never reads as an analyst outcome', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        cases: {
          ...summaryFixture().cases,
          outcomes: { analyst_tp: 0, analyst_fp: 0, analyst_ungraded: 3 },
        },
      }),
    );
    expect(within(dialog).getByTestId('kpi-rule-outcome')).toHaveTextContent('0 confirmed0 benign · 3 not graded');
    const section = within(dialog).getByRole('region', { name: 'Cases from this rule' });
    const link = within(section).getByRole('link', { name: /CASE-000208/ });
    expect(link).toHaveAccessibleName(/Escalated\s*AI verdict\s*True positive$/);
    expect(within(link).getByTestId('case-ai-verdict')).toHaveTextContent('AI verdictTrue positive');
    // The visible prefix gives way on a phone; the screen-reader text keeps the attribution.
    expect(within(link).getByText('AI verdict', { selector: '[aria-hidden="true"]' })).toHaveClass('max-sm:hidden');
    expect(within(section).queryAllByTestId('case-ai-verdict')).toHaveLength(3);
  });

  it('says where the rule is defined, its tuning and its analyst policy', async () => {
    const { dialog } = await openSheet();
    const about = within(dialog).getByRole('region', { name: 'About this rule' });
    expect(about).toHaveTextContent('Defined inThe source SIEM, not a suite rule');
    // "Graded", the word the strip's "not graded" uses: the samples count benign cases too,
    // so "confirmed" (the strip's confirmed true positives) would contradict the strip.
    expect(about).toHaveTextContent('False-positive rate at least 12%, from 2 analyst-graded cases');
    expect(about).not.toHaveTextContent(/analyst-confirmed/);
    expect(about).toHaveTextContent('No analyst policy applies.');
    expect(within(about).queryByRole('link', { name: 'Rule settings' })).toBeNull();
    expect(about).toHaveTextContent('settings live in the source SIEM');
    expect(within(about).getByRole('link', { name: 'Open Auto-tuning' })).toHaveAttribute('href', '#/tuning');
  });

  it('links a suite rule to its settings, with its state, ATT&CK and a declared benign policy', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        definition: {
          status: 'ok',
          reason: null,
          kind: 'suite',
          suite_rule: { name: RULE, enabled: true, description: 'Scanner user agents on the web tier.', mitre: ['T1595'], priority: 2 },
        },
        analyst_policy: {
          status: 'ok',
          reason: null,
          policy: { reason: 'Approved weekly scan', created_by: 'aryan', expires_at: '2026-12-01T00:00:00+00:00' },
        },
      }),
    );
    const about = within(dialog).getByRole('region', { name: 'About this rule' });
    // The Console's own words for a rule's state (the rule editor's Enabled / Disabled).
    expect(about).toHaveTextContent(`A suite rule, ${RULE}, enabled`);
    expect(about).toHaveTextContent('ATT&CKT1595');
    expect(about).toHaveTextContent('Declared benign: Approved weekly scan');
    expect(about).toHaveTextContent(/by aryan, until Dec 1/);
    const settings = within(about).getByRole('link', { name: 'Rule settings' });
    expect(settings).toHaveAttribute('href', '#/settings?s=detection_rules');
    // An in-app destination: a settings glyph, never the new-tab / external-site glyph.
    expect(settings.querySelector('svg.lucide-settings2')).not.toBeNull();
    expect(settings.querySelector('svg.lucide-external-link')).toBeNull();
  });

  it('says when a suite rule is disabled', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        definition: {
          status: 'ok',
          reason: null,
          kind: 'suite',
          suite_rule: { name: RULE, enabled: false, description: '', mitre: [], priority: 2 },
        },
      }),
    );
    const about = within(dialog).getByRole('region', { name: 'About this rule' });
    expect(about).toHaveTextContent(`A suite rule, ${RULE}, disabled`);
    expect(about).not.toHaveTextContent(/, off\b/);
  });

  it('titles every section in the one module title style, as an h3 under the sheet title', async () => {
    const { dialog } = await openSheet();
    for (const name of ['Alerts over time', 'Top source IPs', 'Top targets', 'Latest alerts', 'Cases from this rule', 'About this rule']) {
      const region = within(dialog).getByRole('region', { name });
      const heading = within(region).getByRole('heading', { name, level: 3 });
      expect(heading.closest('[data-section-title]')).not.toBeNull();
    }
    // The aside sits in the title row, in the shared caption size.
    const chart = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(within(chart).getByText('12 h buckets · times in UTC · exact')).toHaveClass('text-sm');
  });

  it('degrades per section: a missing grant shows its own line and hides its action', async () => {
    const forbidden = summaryFixture({
      alerts: { status: 'forbidden', reason: null, count: null, count_relation: 'gte', first_seen: null, last_seen: null, series: null, sources: [] },
      top_source_ips: { status: 'forbidden', reason: null, rows: [], exact: false },
      top_targets: { status: 'forbidden', reason: null, rows: [], exact: false },
      tuning: { status: 'forbidden', reason: null, wilson_lower_bound: null, samples: null, proposed_change: null, last_tuned: null },
    });
    authState.denied = new Set(['sources:read']);
    summaryMock.mockResolvedValue(forbidden);
    renderSheet();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('group', { name: 'Rule key figures' });
    for (const name of ['Alerts over time', 'Top source IPs', 'Top targets', 'Latest alerts']) {
      expect(within(dialog).getByRole('region', { name })).toHaveTextContent('You do not have access to log sources.');
    }
    expect(within(dialog).queryByTestId('rule-open-logs')).toBeNull();
    expect(within(dialog).queryByTestId('kpi-rule-alerts')).toBeNull();
    expect(within(dialog).getByRole('region', { name: 'About this rule' })).toHaveTextContent('You do not have access to tuning.');
    // The latest alerts are never read without the grant.
    expect(logsMock).not.toHaveBeenCalled();
  });

  it('shows the cases permission line and drops the case figures and action', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        cases: { status: 'forbidden', reason: null, count: null, open_now: null, outcomes: null, latest: [] },
        definition: { status: 'forbidden', reason: null, kind: null, suite_rule: null },
        analyst_policy: { status: 'forbidden', reason: null, policy: null },
      }),
    );
    expect(within(dialog).getByRole('region', { name: 'Cases from this rule' })).toHaveTextContent(
      'You do not have access to cases.',
    );
    expect(within(dialog).queryByTestId('kpi-rule-cases')).toBeNull();
    expect(within(dialog).queryByTestId('rule-show-cases')).toBeNull();
    const about = within(dialog).getByRole('region', { name: 'About this rule' });
    expect(within(about).getAllByText('You do not have access to detection rules.')).toHaveLength(2);
  });

  it('says why cases are hidden under row-level scope', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        cases: { status: 'unsupported', reason: 'Hidden while row-level scope is on.', count: null, open_now: null, outcomes: null, latest: [] },
      }),
    );
    expect(within(dialog).getByRole('region', { name: 'Cases from this rule' })).toHaveTextContent(
      'Hidden while row-level scope is on.',
    );
  });

  it('says once that the rule has no alerts in the window, where it looked, and leaves out the empty sections', async () => {
    logsMock.mockResolvedValue(latestFixture(0));
    const base = summaryFixture();
    const zeroSeries = { ...base.alerts.series!, points: base.alerts.series!.points.map((p) => ({ ...p, high: 0, medium: 0 })) };
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { ...base.alerts, count: 0, first_seen: null, last_seen: null, series: zeroSeries },
        top_source_ips: { status: 'ok', reason: null, rows: [], exact: true },
        top_targets: { status: 'ok', reason: null, rows: [], exact: true },
        cases: { status: 'ok', reason: null, count: 0, open_now: 0, outcomes: { analyst_tp: 0, analyst_fp: 0, analyst_ungraded: 0 }, latest: [] },
      }),
    );
    expect(within(dialog).getByRole('region', { name: 'Alerts over time' })).toHaveTextContent(
      'No alerts from this rule in the last 3 days in the log sources the Console can search.',
    );
    for (const name of ['Top source IPs', 'Top targets', 'Latest alerts']) {
      expect(within(dialog).queryByRole('region', { name })).toBeNull();
    }
    expect(dialog.textContent?.match(/No alerts/g)).toHaveLength(1);
    expect(within(dialog).getByRole('region', { name: 'Cases from this rule' })).toHaveTextContent('No cases from this rule yet.');
    // The empty population is said by Cases and Analyst outcome; never "Still open 0 of 0 cases".
    const strip = within(dialog).getByRole('group', { name: 'Rule key figures' });
    expect(within(strip).getByTestId('kpi-rule-cases')).toHaveTextContent('Cases0all time');
    expect(within(strip).queryByTestId('kpi-rule-open')).toBeNull();
    expect(strip).not.toHaveTextContent(/of 0 cases/);
    expect(within(dialog).getByTestId('kpi-rule-outcome')).toHaveTextContent('Analyst outcomeNone yetno cases from this rule');
    expect(within(dialog).getByTestId('rule-open-logs')).toHaveTextContent(/^Open in Logs$/);
    expect(within(dialog).queryByTestId('rule-show-cases')).toBeNull();
    expect(within(dialog).queryByTestId('rule-seen')).toBeNull();
  });

  it('names the one source it looked in when the sheet is filtered', async () => {
    const base = summaryFixture();
    const zeroSeries = { ...base.alerts.series!, points: base.alerts.series!.points.map((p) => ({ ...p, high: 0, medium: 0 })) };
    const { dialog } = await openSheet(
      summaryFixture({ alerts: { ...base.alerts, count: 0, series: zeroSeries } }),
      { sourceId: 'src-1' },
    );
    expect(within(dialog).getByTestId('rule-no-alerts')).toHaveTextContent(
      'No alerts from this rule in the last 3 days in Splunk Enterprise Security (HEC).',
    );
  });

  it('never states a zero as fact when a source did not answer', async () => {
    const base = summaryFixture();
    const zeroSeries = { ...base.alerts.series!, points: base.alerts.series!.points.map((p) => ({ ...p, high: 0, medium: 0 })) };
    const { dialog } = await openSheet(
      summaryFixture({
        alerts: { ...base.alerts, count: 0, count_relation: 'gte', reason: '1 of 2 sources did not answer.', series: zeroSeries },
      }),
    );
    const chart = within(dialog).getByRole('region', { name: 'Alerts over time' });
    expect(chart).toHaveTextContent('No alerts from this rule were found in the last 3 days.');
    expect(chart).toHaveTextContent('1 of 2 sources did not answer.');
    expect(chart).not.toHaveTextContent('Console can search');
  });

  it('has an empty line for a section without data while the rule has alerts', async () => {
    logsMock.mockResolvedValue(latestFixture(0));
    const { dialog } = await openSheet(
      summaryFixture({
        top_source_ips: { status: 'ok', reason: null, rows: [], exact: true },
        top_targets: { status: 'ok', reason: null, rows: [], exact: true },
      }),
    );
    expect(within(dialog).getByRole('region', { name: 'Top source IPs' })).toHaveTextContent(
      'The alerts in this window carry no source IP.',
    );
    expect(within(dialog).getByRole('region', { name: 'Top targets' })).toHaveTextContent(
      'The alerts in this window name no host or user.',
    );
    await waitFor(() =>
      expect(within(dialog).getByRole('region', { name: 'Latest alerts' })).toHaveTextContent(
        'No alerts to show in the last 3 days.',
      ),
    );
  });

  it('shows a named loading state, then an error with Retry that reads again', async () => {
    let fail: (error: unknown) => void = () => undefined;
    summaryMock.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    renderSheet();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status', { name: 'Loading this rule' })).toBeInTheDocument();
    await act(async () => fail(new Error('Service unavailable')));
    expect(await within(dialog).findByText('Could not load this rule')).toBeInTheDocument();
    summaryMock.mockResolvedValue(summaryFixture());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await within(dialog).findByRole('group', { name: 'Rule key figures' });
    expect(summaryMock).toHaveBeenCalledTimes(2);
  });

  it('says when the latest alerts could not be read, keeping the rest', async () => {
    logsMock.mockRejectedValue(new Error('timeout'));
    const { dialog } = await openSheet();
    await waitFor(() =>
      expect(within(dialog).getByRole('region', { name: 'Latest alerts' })).toHaveTextContent(
        'The latest alerts could not be read right now.',
      ),
    );
    expect(within(dialog).getByTestId('kpi-rule-alerts')).toBeInTheDocument();
  });

  it('reads again over another window from the picker', async () => {
    const user = userEvent.setup();
    const { dialog } = await openSheet();
    await user.click(within(dialog).getByRole('button', { name: 'Time range: Last 3 days' }));
    await user.click(await screen.findByRole('button', { name: /Last 7 days/ }));
    await waitFor(() =>
      expect(summaryMock).toHaveBeenLastCalledWith({ rule: RULE, window: 'now-7d' }, expect.any(AbortSignal)),
    );
    expect(logsMock).toHaveBeenLastCalledWith({ rule: RULE, from: 'now-7d', to: 'now', limit: 5 });
  });

  it('announces what a newly chosen window shows once its figures land, never the old ones', async () => {
    const user = userEvent.setup();
    const { dialog } = await openSheet();
    const region = within(dialog).getByTestId('rule-window-announcement');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // The first load is read with the dialog: nothing is announced.
    expect(region).toHaveTextContent('');
    let land: (summary: RuleSummary) => void = () => {};
    summaryMock.mockImplementationOnce(() => new Promise<RuleSummary>((resolve) => (land = resolve)));
    await user.click(within(dialog).getByRole('button', { name: 'Time range: Last 3 days' }));
    await user.click(await screen.findByRole('button', { name: /Last 7 days/ }));
    await waitFor(() => expect(summaryMock).toHaveBeenCalledTimes(2));
    // The 3-day figures are still on screen while the 7-day read is out: not announced.
    expect(region).toHaveTextContent('');
    const week = summaryFixture({ window: { label: 'Last 7 days', from: '2026-10-18T06:00:00+00:00', to: '2026-10-25T06:12:00+00:00' } });
    await act(async () => land({ ...week, alerts: { ...week.alerts, count: 1204 } }));
    await waitFor(() => expect(region).toHaveTextContent('Last 7 days: 1,204 alerts from this rule.'));
  });

  it('starts on the opener window', async () => {
    await openSheet(summaryFixture(), { window: { from: '2026-10-22T00:00:00Z', to: '2026-10-25T00:00:00Z' } });
    expect(summaryMock).toHaveBeenCalledWith(
      { rule: RULE, window: '2026-10-22T00:00:00Z..2026-10-25T00:00:00Z' },
      expect.any(AbortSignal),
    );
  });

  it('reads Demo figures again when Demo Mode is entered, and ignores a failed status read', async () => {
    const { rerender } = await openSheet();
    expect(summaryMock).toHaveBeenCalledTimes(1);
    // A failed status read (the OFF stand-in) is no answer: nothing is read again.
    demoState.value = { ...demoState.value, confirmed: false };
    rerender(
      <TooltipProvider>
        <RuleSheet id="rule-sheet-test" request={REQUEST} open onOpenChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(summaryMock).toHaveBeenCalledTimes(1);
    // The Demo read is still out: the real figures must not stay under the Demo badge,
    // not even as a "refresh".
    let land: (summary: RuleSummary) => void = () => {};
    summaryMock.mockImplementationOnce(() => new Promise<RuleSummary>((resolve) => (land = resolve)));
    demoState.value = {
      ...demoState.value,
      status: { mode: 'demo', active: true, run_id: 'run-2' },
      active: true,
      confirmed: true,
    };
    rerender(
      <TooltipProvider>
        <RuleSheet id="rule-sheet-test" request={REQUEST} open onOpenChange={vi.fn()} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(summaryMock).toHaveBeenCalledTimes(2));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('group', { name: 'Rule key figures' })).toBeNull();
    expect(within(dialog).queryByText('381')).toBeNull();
    expect(within(dialog).queryByRole('link', { name: /CASE-000214/ })).toBeNull();
    expect(within(dialog).getByRole('status', { name: 'Loading this rule' })).toBeInTheDocument();
    // The Demo answer lands and is shown.
    const demo = summaryFixture();
    await act(async () => land({ ...demo, alerts: { ...demo.alerts, count: 42 } }));
    const strip = await within(dialog).findByRole('group', { name: 'Rule key figures' });
    expect(within(strip).getByTestId('kpi-rule-alerts')).toHaveTextContent('42');
  });

  it('reads nothing while closed', () => {
    summaryMock.mockResolvedValue(summaryFixture());
    render(<RuleSheet id="rule-sheet-test" request={REQUEST} open={false} onOpenChange={vi.fn()} />);
    expect(summaryMock).not.toHaveBeenCalled();
    expect(logsMock).not.toHaveBeenCalled();
  });

  it('closes on Esc', async () => {
    const { onOpenChange } = await openSheet();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the keys typed in it from the shortcuts of the surface behind it', async () => {
    const documentKeys = vi.fn();
    const ancestorKeys = vi.fn();
    document.addEventListener('keydown', documentKeys);
    try {
      summaryMock.mockResolvedValue(summaryFixture());
      const onOpenChange = vi.fn();
      render(
        <TooltipProvider>
          {/* A React ancestor with its own key handler (a row, a case surface). */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for a host surface's key handler */}
          <div onKeyDown={ancestorKeys}>
            <RuleSheet id="rule-sheet-test" request={REQUEST} open onOpenChange={onOpenChange} />
          </div>
        </TooltipProvider>,
      );
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByRole('group', { name: 'Rule key figures' });
      const title = within(dialog).getByRole('heading', { name: RULE });
      await waitFor(() => expect(document.activeElement).toBe(title));
      for (const key of ['r', 'a', 'c', 'Enter', ' ']) fireEvent.keyDown(title, { key });
      fireEvent.keyDown(title, { key: '1', code: 'Digit1', altKey: true });
      fireEvent.keyDown(title, { key: 'R', shiftKey: true });
      expect(documentKeys).not.toHaveBeenCalled();
      expect(ancestorKeys).not.toHaveBeenCalled();
      // A Ctrl or Cmd chord (the command palette) still reaches the shell.
      fireEvent.keyDown(title, { key: 'k', ctrlKey: true });
      expect(documentKeys).toHaveBeenCalledTimes(1);
      // Esc still closes the sheet.
      fireEvent.keyDown(title, { key: 'Escape' });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      document.removeEventListener('keydown', documentKeys);
    }
  });

  describe('focus after it closes', () => {
    function Harness({ onNavigate }: { onNavigate: () => void }) {
      const [open, setOpen] = React.useState(true);
      const opener = React.useRef<HTMLButtonElement>(null);
      return (
        <TooltipProvider>
          <main id="socMain" tabIndex={-1}>
            <button ref={opener} type="button">
              Opener
            </button>
          </main>
          <RuleSheet
            id="rule-sheet-test"
            request={REQUEST}
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) onNavigate();
            }}
            returnFocusTo={() => opener.current}
          />
        </TooltipProvider>
      );
    }

    async function openHarness(onNavigate = vi.fn()) {
      summaryMock.mockResolvedValue(summaryFixture());
      render(<Harness onNavigate={onNavigate} />);
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByRole('group', { name: 'Rule key figures' });
      return dialog;
    }

    afterEach(() => {
      window.location.hash = '';
    });

    it('lands on the main region when an action navigates, never on the page body', async () => {
      navigate.mockImplementation((page: string) => {
        window.location.hash = `#/${page}`;
      });
      const dialog = await openHarness();
      fireEvent.click(within(dialog).getByRole('link', { name: 'Show the 3 cases' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById('socMain')));
    });

    it('lands on the main region after Ask AI', async () => {
      navigate.mockImplementation((page: string) => {
        window.location.hash = `#/${page}`;
      });
      summaryMock.mockResolvedValue(summaryFixture({ rule: 'ssh_bruteforce' }));
      const onOpenChange = vi.fn();
      function AskHarness() {
        const [open, setOpen] = React.useState(true);
        return (
          <TooltipProvider>
            <main id="socMain" tabIndex={-1} />
            <RuleSheet
              id="rule-sheet-test"
              request={{ ...REQUEST, rule: 'ssh_bruteforce' }}
              open={open}
              onOpenChange={(next) => {
                onOpenChange(next);
                setOpen(next);
              }}
            />
          </TooltipProvider>
        );
      }
      render(<AskHarness />);
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Ask AI about this rule' }));
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById('socMain')));
      expect(navigate).toHaveBeenCalledWith('chat', expect.objectContaining({ newChat: true }));
    });

    it('goes back to the opener when the move did not happen (a route-leave question was declined)', async () => {
      // The router kept the page: the hash did not change.
      const dialog = await openHarness();
      fireEvent.click(within(dialog).getByRole('link', { name: 'Open all 381 in Logs' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toHaveTextContent('Opener'));
    });

    it('goes back to the opener when it simply closes', async () => {
      const dialog = await openHarness();
      fireEvent.keyDown(within(dialog).getByRole('heading', { name: RULE }), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toHaveTextContent('Opener'));
    });
  });

  it('offers no link to Auto-tuning while the person is on it', async () => {
    window.location.hash = '#/tuning';
    try {
      const { dialog } = await openSheet();
      const about = within(dialog).getByRole('region', { name: 'About this rule' });
      expect(about).toHaveTextContent('False-positive rate at least 12%');
      expect(within(about).queryByRole('link', { name: 'Open Auto-tuning' })).toBeNull();
    } finally {
      window.location.hash = '';
    }
  });

  it('keeps the tab order: header, actions, the chart, then the sections, and on to Close', async () => {
    const user = userEvent.setup();
    const { dialog } = await openSheet();
    await within(dialog).findByRole('table', { name: 'Latest alerts' });
    const title = within(dialog).getByRole('heading', { name: RULE });
    await waitFor(() => expect(document.activeElement).toBe(title));
    const visited: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement;
      expect(dialog.contains(active)).toBe(true);
      const name = active.getAttribute('aria-label') || active.textContent?.trim() || active.tagName;
      if (visited.includes(name)) break;
      visited.push(name);
    }
    const at = (pattern: RegExp) => visited.findIndex((name) => pattern.test(name));
    const order = [
      at(/^Time range: Last 3 days$/),
      at(/^Open all 381 in Logs$/),
      at(/^Show the 3 cases$/),
      at(/^Alerts over time by severity/),
      at(/CASE-000214/),
      at(/^Open Auto-tuning$/),
      at(/^Close$/),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it('carries Tab on from the chart itself, so the dialog trap never pulls focus back to the sheet', async () => {
    // A browser applies the chart's focus-ring removal between the plot's blur and the next
    // element's focus, and the trap then pulls focus back to the sheet. The sheet moves
    // focus inside the key handler instead, before that change is applied.
    const { dialog } = await openSheet();
    const plot = within(dialog).getByRole('group', { name: /^Alerts over time by severity/ });
    act(() => plot.focus());
    const forward = fireEvent.keyDown(plot, { key: 'Tab' });
    expect(forward).toBe(false); // handled: the browser's own move is replaced
    const afterPlot = document.activeElement as HTMLElement;
    expect(afterPlot).not.toBe(plot);
    expect(dialog.contains(afterPlot)).toBe(true);
    expect(plot.compareDocumentPosition(afterPlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => plot.focus());
    expect(fireEvent.keyDown(plot, { key: 'Tab', shiftKey: true })).toBe(false);
    const beforePlot = document.activeElement as HTMLElement;
    expect(dialog.contains(beforePlot)).toBe(true);
    expect(plot.compareDocumentPosition(beforePlot) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // Arrow keys stay with the chart's own reading.
    act(() => plot.focus());
    expect(fireEvent.keyDown(plot, { key: 'ArrowRight' })).toBe(false);
    expect(document.activeElement).toBe(plot);
  });

  it('renders untrusted values as plain text, never markup', async () => {
    const hostile = '<img src=x onerror=alert(1)> rule';
    const base = summaryFixture({ rule: hostile });
    logsMock.mockResolvedValue({
      ...latestFixture(1),
      logs: [{ ...latestFixture(1).logs[0], message: '<script>alert(2)</script>' }],
    });
    const { dialog } = await openSheet(
      { ...base, top_source_ips: { ...base.top_source_ips, rows: [{ value: '<b>ip</b>', kind: null, count: 1 }] } },
      { rule: hostile },
    );
    expect(within(dialog).getByRole('heading', { name: hostile })).toBeInTheDocument();
    expect(await within(dialog).findByText('<script>alert(2)</script>')).toBeInTheDocument();
    expect(within(dialog).getByText('<b>ip</b>')).toBeInTheDocument();
    expect(dialog.querySelector('img, script, b')).toBeNull();
  });

  it('writes no em dash, no en dash as punctuation and never the word playbook', async () => {
    const { dialog } = await openSheet(
      summaryFixture({
        tuning: { status: 'ok', reason: null, wilson_lower_bound: 0.4, samples: 30, proposed_change: { kind: 'correlation_n', before: 3, after: 4, requires_approval: true }, last_tuned: '2026-10-20T00:00:00Z' },
      }),
    );
    await within(dialog).findByRole('table', { name: 'Latest alerts' });
    const text = dialog.textContent ?? '';
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/ \u2013 /);
    expect(text.toLowerCase()).not.toContain('playbook');
  });
});
