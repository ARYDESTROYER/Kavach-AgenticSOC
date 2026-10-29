/**
 * Logs route deep links (SPEC §10.7): `#/logs?logQuery=…&from=…&to=…&sourceId=…` opens
 * the ONE shared browser on the LINKED QUERY with exactly those bounds (absolute instants
 * read as a UTC range) and a summary above its controls — one table, never a second
 * copy; a malformed link is ignored whole (never half-applied); "Browse all logs" drops
 * it; without a link the page is the shared unified browser. Row values stay plain text
 * (#9).
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchUnifiedLogs = vi.hoisted(() => vi.fn());
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/UnifiedLogs.api')>();
  return { ...actual, fetchUnifiedLogs };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/soc/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/router')>();
  return { ...actual, useNavigateOptional: () => navigate };
});

import { answerOrigin, clearAnswerOrigin, rememberAnswerOrigin } from '../../answer-origin';
import { pageHash, RouterProvider, useNavigate } from '../../router';
import UnifiedLogsPage, { boundMs, logsLinkOpts, matchedPhrase, parseLogsDeepLink, sourcesPhrase, windowLabel } from '../UnifiedLogs';

const NOW = Date.UTC(2026, 9, 8, 14, 0);
const RESPONSE = {
  count: 1,
  partial: false,
  limit: 150,
  truncated: false,
  sources: [{ source_id: 'wazuh-prod', source_name: 'Wazuh prod', ok: true, count: 1, mode: 'search' }],
  logs: [
    {
      id: 'e1',
      ts: '2026-10-08T13:55:00Z',
      source_id: 'wazuh-prod',
      source_name: 'Wazuh prod',
      source_ip: '203.0.113.14',
      user: 'root',
      host: 'vpn-gw-2',
      rule: 'sshd: authentication failure',
      severity: 60,
      message: '<img src=x onerror=alert(1)> Failed password for root',
      _raw: {},
    },
  ],
};

function show(hash?: string) {
  if (hash) window.location.hash = hash;
  return render(
    <RouterProvider>
      <UnifiedLogsPage />
    </RouterProvider>,
  );
}

beforeEach(() => {
  fetchUnifiedLogs.mockReset();
  fetchUnifiedLogs.mockResolvedValue(RESPONSE);
  navigate.mockClear();
});
afterEach(() => {
  window.location.hash = '';
  // A test that let `navigate` change the hash for real leaves no implementation behind.
  navigate.mockReset();
});

describe('parseLogsDeepLink', () => {
  it('accepts the router grammar', () => {
    expect(parseLogsDeepLink({ logQuery: 'source.ip:203.0.113.14', from: 'now-24h', to: 'now', sourceId: 'wazuh-prod' }, NOW)).toEqual({
      query: 'source.ip:203.0.113.14',
      from: 'now-24h',
      to: 'now',
      sourceId: 'wazuh-prod',
    });
    expect(parseLogsDeepLink({ from: '2026-10-07T00:00:00Z', to: '2026-10-08T00:00:00Z' }, NOW)).not.toBeNull();
    expect(parseLogsDeepLink({ caseId: 'x' }, NOW)).toBeNull();
    expect(parseLogsDeepLink(undefined, NOW)).toBeNull();
  });

  it('ignores the whole link when any part is malformed or the window is wrong', () => {
    expect(parseLogsDeepLink({ logQuery: 'a\u202eb' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: 'x', from: 'yesterday' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: 'x', sourceId: '../etc' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ from: 'now-1h', to: 'now-2h' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: '   ' }, NOW)).toBeNull();
  });

  it('reads bounds and labels windows', () => {
    expect(boundMs('now-2h', NOW)).toBe(NOW - 7_200_000);
    expect(boundMs('garbage', NOW)).toBeNull();
    expect(windowLabel('now-24h', null)).toBe('last 24 hours');
    expect(windowLabel('now-3d', 'now')).toBe('last 3 days');
    expect(windowLabel('now-1h', null)).toBe('last 1 hour');
    expect(windowLabel(null, null)).toBe('the default window');
  });

  it('reads absolute open_in bounds as one readable UTC range', () => {
    expect(windowLabel('2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z')).toBe('2026-10-07 00:00 → 2026-10-08 00:00 UTC');
    // The date is written once on the same day; an offset is converted to UTC.
    expect(windowLabel('2026-10-08T09:00:00Z', '2026-10-08T12:30:00+02:00')).toBe('2026-10-08 09:00 → 10:30 UTC');
    // Sub-minute bounds keep their seconds (never the raw millisecond ISO text).
    expect(windowLabel('2026-10-01T12:00:00.250Z', '2026-10-08T12:00:00.250Z')).toBe('2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC');
    expect(windowLabel('2026-10-01T12:00:00Z', null)).toBe('2026-10-01 12:00 UTC → now');
    expect(windowLabel('now-6h', '2026-10-08T12:00:00Z')).toBe('now-6h → 2026-10-08 12:00 UTC');
    expect(windowLabel(null, '2026-10-08T12:00:00Z')).toBe('until 2026-10-08 12:00 UTC');
  });
});

describe('Logs page', () => {
  it('runs the linked query with exactly its bounds and source', async () => {
    show('#/logs?logQuery=source.ip%3A203.0.113.14&from=now-24h&sourceId=wazuh-prod');
    expect(await screen.findByText('Opened from a linked query')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith({
        limit: 150,
        query: 'source.ip:203.0.113.14',
        from: 'now-24h',
        to: 'now',
        source_id: 'wazuh-prod',
      }),
    );
    expect(screen.getByText('source.ip:203.0.113.14')).toBeInTheDocument();
    expect(screen.getByText('last 24 hours')).toBeInTheDocument();
    // The shared browser starts on the linked query: its search box carries it.
    expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveValue('source.ip:203.0.113.14');
    // Untrusted message text is plain text, never markup.
    expect(await screen.findByText('<img src=x onerror=alert(1)> Failed password for root')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    // ONE table: the linked view is the shared browser, not a second copy of it.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('opens an absolute chat window with its exact bounds and a readable UTC range', async () => {
    show('#/logs?logQuery=failed&from=2026-10-01T12%3A00%3A00Z&to=2026-10-08T12%3A00%3A00.250Z');
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith({
        limit: 150,
        query: 'failed',
        from: '2026-10-01T12:00:00Z',
        to: '2026-10-08T12:00:00.250Z',
      }),
    );
    // The summary and the time-range control both read the UTC range, not raw ISO text.
    expect(await screen.findAllByText('2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC')).not.toHaveLength(0);
    expect(screen.queryByText(/T12:00:00/)).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('names the linked source in sans once the read resolves it', async () => {
    show('#/logs?logQuery=failed&from=now-24h&sourceId=wazuh-prod');
    const header = await screen.findByTestId('linked-logs');
    await waitFor(() => expect(header).toHaveTextContent('Wazuh prod'));
    const name = Array.from(header.querySelectorAll('dd')).find((dd) => dd.textContent === 'Wazuh prod')!;
    expect(name).toHaveAttribute('title', 'wazuh-prod');
    expect(name.querySelector('.font-mono')).toBeNull();
  });

  // Round 14 (SPEC §4.9.3): Live is the time-range pill's Off or Live cadence in the page
  // header, not a separate switch; a window fixed in the past offers no cadence at all.
  const liveControl = () => screen.queryByRole('combobox', { name: /^Auto-refresh interval/ });

  it('offers no Live for a fixed past window, says why, and keeps the aged-out hint', async () => {
    fetchUnifiedLogs.mockResolvedValue({ ...RESPONSE, count: 0, logs: [] });
    show('#/logs?logQuery=failed&from=2026-10-01T12%3A00%3A00Z&to=2026-10-02T12%3A00%3A00Z');
    expect(await screen.findByTestId('unified-live-tail-reason')).toHaveTextContent(/fixed in the past/);
    expect(liveControl()).toBeNull();
    expect(await screen.findByText(/Older events may have aged out of the source since this link was made/)).toBeInTheDocument();
  });

  it('keeps Live available for a relative linked window', async () => {
    show('#/logs?logQuery=failed&from=now-24h');
    await screen.findByRole('button', { name: 'Time range: Last 24 hours' });
    expect(liveControl()).toHaveAccessibleName('Auto-refresh interval: Off');
    expect(screen.queryByTestId('unified-live-tail-reason')).toBeNull();
  });

  it('keeps Live available for a relative window that is not a preset', async () => {
    // `now-6h` is no time-range preset, so it opens as a one-off linked window; it is
    // relative and open-ended, so it still sees new events.
    show('#/logs?logQuery=failed&from=now-6h');
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-6h', to: 'now' })),
    );
    await waitFor(() => expect(liveControl()).toBeInTheDocument());
    expect(screen.queryByTestId('unified-live-tail-reason')).toBeNull();
  });

  it('keeps Live available for an absolute start with an open end', async () => {
    show('#/logs?logQuery=failed&from=2026-10-01T12%3A00%3A00Z');
    await waitFor(() => expect(liveControl()).toBeInTheDocument());
  });

  it('drops the link on "Browse all logs"', async () => {
    const user = userEvent.setup();
    show('#/logs?logQuery=failed');
    await user.click(await screen.findByRole('button', { name: /Browse all logs/ }));
    expect(navigate).toHaveBeenCalledWith('logs');
    await waitFor(() => expect(screen.queryByText('Opened from a linked query')).toBeNull());
    // The shared browser takes over (its default window, no linked filter).
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'now-1h', query: undefined })));
  });

  it('is the unified browser without a link', async () => {
    show('#/logs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Logs' })).toBeInTheDocument();
    expect(screen.queryByText('Opened from a linked query')).toBeNull();
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-1h' })));
  });

  it('reports a failed linked query without crashing', async () => {
    fetchUnifiedLogs.mockRejectedValue(new Error('Source not browsable'));
    show('#/logs?logQuery=x&sourceId=push-1');
    expect(await screen.findByText('Could not load logs')).toBeInTheDocument();
    // The summary of what was asked stays, so the analyst can see what failed.
    expect(screen.getByText('Opened from a linked query')).toBeInTheDocument();
  });
});

/*
 * Round 14 (SPEC §4.6.6): exact rule and severity filters on the Logs page. "Rule is"
 * keeps the value byte for byte (spaces, other scripts), the Rule column is left out
 * while it fixes the rule, the count comes from the server's `matched` figure (never the
 * rows shown), and a removed chip keeps the rest of the link.
 */
const RULE = 'Fehlgeschlagene Anmeldung über SSH';
const FILTERED = {
  ...RESPONSE,
  logs: [{ ...RESPONSE.logs[0], rule: RULE }],
  filters: { rule: RULE, severity: null, severity_gte: null },
  matched: { count: 381, relation: 'eq' as const },
  sources: [
    { source_id: 'wazuh-prod', source_name: 'Wazuh prod', ok: true, count: 1, mode: 'search', exact: true, total: 300, total_relation: 'eq' as const },
    { source_id: 'elastic', source_name: 'Elastic', ok: true, count: 0, mode: 'search', exact: true, total: 81, total_relation: 'eq' as const },
  ],
};

describe('parseLogsDeepLink: exact filters', () => {
  it('reads rule, severity and severity_gte, keeping the rule value exactly', () => {
    expect(parseLogsDeepLink({ rule: RULE, from: 'now-3d' }, NOW)).toEqual({
      query: null,
      from: 'now-3d',
      to: null,
      sourceId: null,
      rule: RULE,
    });
    // A rule value is never trimmed: it is matched exactly.
    expect(parseLogsDeepLink({ rule: ' sshd ' }, NOW)?.rule).toBe(' sshd ');
    expect(parseLogsDeepLink({ severity: 'high' }, NOW)).toMatchObject({ severity: 'high' });
    expect(parseLogsDeepLink({ severity_gte: 'medium' }, NOW)).toMatchObject({ severityGte: 'medium' });
    // Without a filter the link keeps its old shape, key for key.
    expect(Object.keys(parseLogsDeepLink({ logQuery: 'x' }, NOW)!)).toEqual(['query', 'from', 'to', 'sourceId']);
  });

  it('ignores the whole link for a bad rule or level', () => {
    expect(parseLogsDeepLink({ rule: 'a\u202eb', from: 'now-1h' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ rule: 'x'.repeat(257) }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ rule: '   ' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ rule: 'a\nb' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ severity: 'severe' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ severity_gte: 'HIGH', rule: 'x' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ rule: 'x'.repeat(256) }, NOW)).not.toBeNull();
  });

  it('narrows a window longer than 90 days to its last 90 days, keeping every filter', () => {
    // Ending now: the last 90 days, relative.
    expect(parseLogsDeepLink({ from: 'now-91d' }, NOW)).toEqual({
      query: null,
      from: 'now-90d',
      to: null,
      sourceId: null,
      requestedFrom: 'now-91d',
    });
    // A rule sheet over the last 6 months: the rule stays, the window is its last 90 days.
    const asked = new Date(NOW - 180 * 86_400_000).toISOString();
    const end = new Date(NOW).toISOString();
    const link = parseLogsDeepLink({ rule: RULE, from: asked, to: end, severity: 'high' }, NOW)!;
    expect(link).toMatchObject({ rule: RULE, severity: 'high', from: new Date(NOW - 90 * 86_400_000).toISOString(), to: end, requestedFrom: asked });
    // The hash keeps the start the link asked for, so a removed chip narrows it the same way.
    expect(logsLinkOpts(link)).toEqual({ from: asked, to: end, rule: RULE, severity: 'high' });
    // Exactly 90 days is not narrowed.
    expect(parseLogsDeepLink({ from: 'now-90d' }, NOW)).not.toHaveProperty('requestedFrom');
  });
});

describe('matchedPhrase and sourcesPhrase', () => {
  it('states the matched figure, exact or a floor', () => {
    expect(matchedPhrase({ count: 381, relation: 'eq' }, 'last 3 days')).toBe('381 events · last 3 days');
    expect(matchedPhrase({ count: 1000, relation: 'gte' }, 'last 3 days')).toBe('At least 1,000 events · last 3 days');
    expect(matchedPhrase({ count: 1, relation: 'eq' }, 'Last 24 hours')).toBe('1 event · last 24 hours');
    expect(matchedPhrase({ count: 0, relation: 'gte' }, null)).toBe('No events counted');
    expect(matchedPhrase({ count: 0, relation: 'eq' }, null)).toBe('0 events');
  });

  it('names which sources applied the filter exactly', () => {
    const ok = (id: string, exact: boolean) => ({ source_id: id, source_name: id.toUpperCase(), ok: true, count: 0, exact });
    expect(sourcesPhrase([ok('a', true), ok('b', true), ok('c', true)])).toBe('Sources: all 3 that support browsing');
    expect(sourcesPhrase([ok('a', true), ok('b', false), { ...ok('c', false), ok: false }])).toBe(
      'Sources: 1 of 3 applied the filter exactly; filtered after a bounded read: B; could not be read: C',
    );
    expect(sourcesPhrase([ok('a', true)])).toBe('Source: A');
    // Pinned to one source that applied it exactly: the Source line already names it.
    expect(sourcesPhrase([ok('a', true)], true)).toBeNull();
    expect(sourcesPhrase([ok('a', false)], true)).toBe('Source: A, filtered after a bounded read');
    // An older backend that does not say: nothing claimed.
    expect(sourcesPhrase([{ source_id: 'a', source_name: 'A', ok: true, count: 1 }])).toBeNull();
  });
});

describe('Logs page: exact filters', () => {
  it('round-trips a rule with spaces and other letters through the hash and filters exactly', async () => {
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: 'now-3d' }));
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith({ limit: 150, from: 'now-3d', to: 'now', rule: RULE, query: undefined }),
    );
    const chip = await screen.findByRole('button', { name: `Remove filter: Rule is ${RULE}` });
    expect(chip.querySelector('.font-mono')).toHaveTextContent(RULE);
    // The count is the server's matched figure, never the one row shown, over the window
    // its read used ("381 events · last 3 days", SPEC §4.6.6).
    expect(await screen.findByTestId('logs-matched')).toHaveTextContent(
      /^381 events · last 3 days · Sources: all 2 that support browsing$/,
    );
    // "Rule is" fixes the rule, so the column would only repeat it.
    expect(screen.queryByRole('columnheader', { name: /rule/i })).toBeNull();
    expect(screen.getByRole('table')).not.toHaveTextContent(RULE);
  });

  it('says "at least" when a source could only give a floor', async () => {
    fetchUnifiedLogs.mockResolvedValue({
      ...FILTERED,
      matched: { count: 1000, relation: 'gte' },
      sources: [FILTERED.sources[0], { ...FILTERED.sources[1], mode: 'buffer', exact: false, total: null, total_relation: 'gte' }],
    });
    show(pageHash('logs', { rule: RULE, from: 'now-3d' }));
    expect(await screen.findByTestId('logs-matched')).toHaveTextContent(
      'At least 1,000 events · last 3 days · Sources: 1 of 2 applied the filter exactly; filtered after a bounded read: Elastic',
    );
  });

  it('names the window its read used, and the new one once another range is picked', async () => {
    const user = userEvent.setup();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: '2026-10-05T00:00:00Z', to: '2026-10-08T00:00:00Z' }));
    expect(await screen.findByTestId('logs-matched')).toHaveTextContent(
      /^381 events · 2026-10-05 00:00 → 2026-10-08 00:00 UTC · Sources/,
    );
    await user.click(screen.getByRole('button', { name: /^Time range: / }));
    await user.click(await screen.findByRole('button', { name: /^Last 7 days/ }));
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'now-7d', rule: RULE })));
    await waitFor(() => expect(screen.getByTestId('logs-matched')).toHaveTextContent(/^381 events · last 7 days · Sources/));
  });

  it('shows the severity chips and passes the levels as filters', async () => {
    fetchUnifiedLogs.mockResolvedValue({ ...FILTERED, filters: { rule: null, severity: 'high', severity_gte: null } });
    show('#/logs?severity=high&from=now-3d');
    expect(await screen.findByRole('button', { name: 'Remove filter: Severity is High' })).toBeInTheDocument();
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenCalledWith(expect.objectContaining({ severity: 'high' })));
    // No rule filter: the Rule column stays.
    expect(await screen.findByRole('columnheader', { name: /rule/i })).toBeInTheDocument();
    window.location.hash = '';
  });

  it('reads "Severity High or above" for severity_gte', async () => {
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show('#/logs?severity_gte=high&from=now-3d');
    expect(await screen.findByRole('button', { name: 'Remove filter: Severity High or above' })).toBeInTheDocument();
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenCalledWith(expect.objectContaining({ severity_gte: 'high' })));
  });

  it('removes one chip, keeps the rest of the link and re-reads without it', async () => {
    const user = userEvent.setup();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, severity: 'high', from: 'now-3d', sourceId: 'wazuh-prod' }));
    const ruleChip = await screen.findByRole('button', { name: `Remove filter: Rule is ${RULE}` });
    await user.click(ruleChip);
    expect(navigate).toHaveBeenLastCalledWith('logs', { from: 'now-3d', sourceId: 'wazuh-prod', severity: 'high' });
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenLastCalledWith({
        limit: 150,
        query: undefined,
        from: 'now-3d',
        to: 'now',
        source_id: 'wazuh-prod',
        severity: 'high',
      }),
    );
    expect(screen.queryByRole('button', { name: /Rule is/ })).toBeNull();
    // Focus moves to the next chip, never the page body.
    const severityChip = screen.getByRole('button', { name: 'Remove filter: Severity is High' });
    await waitFor(() => expect(severityChip).toHaveFocus());
    // The Rule column is back once no rule is fixed.
    expect(await screen.findByRole('columnheader', { name: /rule/i })).toBeInTheDocument();
  });

  it('drops a link that carries only filters when its last chip goes, and focus goes to the browser, never the body', async () => {
    const user = userEvent.setup();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { severity: 'critical' }));
    await user.click(await screen.findByRole('button', { name: 'Remove filter: Severity is Critical' }));
    expect(navigate).toHaveBeenLastCalledWith('logs');
    await waitFor(() => expect(screen.queryByTestId('linked-logs')).toBeNull());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the window and source when the last chip of a windowed link goes, focus on "Browse all logs"', async () => {
    const user = userEvent.setup();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: 'now-3d', sourceId: 'wazuh-prod' }));
    await user.click(await screen.findByRole('button', { name: `Remove filter: Rule is ${RULE}` }));
    // The rest of the link stays: the same window and source, read again without the rule.
    expect(navigate).toHaveBeenLastCalledWith('logs', { from: 'now-3d', sourceId: 'wazuh-prod' });
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenLastCalledWith({ limit: 150, query: undefined, from: 'now-3d', to: 'now', source_id: 'wazuh-prod' }),
    );
    const header = screen.getByTestId('linked-logs');
    expect(header).toHaveTextContent('last 3 days');
    expect(screen.queryByTestId('logs-filter-chips')).toBeNull();
    // No chip is left to take focus: it goes to "Browse all logs", never the page body.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browse all logs' })).toHaveFocus());
    // The page's help names what is left (a window, no query behind an answer).
    await user.click(screen.getByRole('button', { name: 'About Logs' }));
    expect(await screen.findByText('Events over the linked window, read again with the same bounds.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    // "Browse all logs" then drops the link and focus goes to the search box.
    await user.click(screen.getByRole('button', { name: 'Browse all logs' }));
    expect(navigate).toHaveBeenLastCalledWith('logs');
    await waitFor(() => expect(screen.queryByTestId('linked-logs')).toBeNull());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveFocus());
  });

  it('"Browse all logs" sends focus to the plain browser\'s search box', async () => {
    const user = userEvent.setup();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: 'now-3d' }));
    await user.click(await screen.findByRole('button', { name: 'Browse all logs' }));
    await waitFor(() => expect(screen.queryByTestId('linked-logs')).toBeNull());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveFocus());
  });

  it('keeps ONE polite live region for the count, in place before the read and after a chip goes', async () => {
    const user = userEvent.setup();
    let resolveRead: (value: typeof FILTERED) => void = () => undefined;
    fetchUnifiedLogs.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)));
    fetchUnifiedLogs.mockResolvedValue({ ...FILTERED, matched: { count: 57, relation: 'eq' as const } });
    show(pageHash('logs', { rule: RULE, severity: 'high', from: 'now-3d' }));
    // Present (and empty) before the first read lands, so its first count is announced.
    const region = await screen.findByTestId('logs-matched');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toBeEmptyDOMElement();
    resolveRead(FILTERED);
    await waitFor(() => expect(region).toHaveTextContent(/^381 events · last 3 days/));
    // A removed chip re-reads: the same node changes its text, never a new region.
    await user.click(screen.getByRole('button', { name: `Remove filter: Rule is ${RULE}` }));
    await waitFor(() => expect(region).toHaveTextContent(/^57 events · last 3 days/));
    expect(screen.getByTestId('logs-matched')).toBe(region);
    expect(document.querySelectorAll('[data-testid="linked-logs"] [aria-live]')).toHaveLength(1);
  });

  it('never writes an em dash or the retired procedure word in the filtered header', async () => {
    window.location.hash = '#/chat?conversationId=conv-1';
    rememberAnswerOrigin();
    fetchUnifiedLogs.mockResolvedValue({
      ...FILTERED,
      matched: { count: 1000, relation: 'gte' as const },
      sources: [FILTERED.sources[0], { ...FILTERED.sources[1], exact: false }, { ...FILTERED.sources[1], source_id: 'q', source_name: 'QRadar', ok: false }],
    });
    show(pageHash('logs', { rule: RULE, severity: 'high', severity_gte: 'medium', from: 'now-3d' }));
    const header = await screen.findByTestId('linked-logs');
    await waitFor(() => expect(screen.getByTestId('logs-matched')).toHaveTextContent(/At least 1,000 events/));
    expect(screen.getByRole('link', { name: 'Back to answer' })).toBeInTheDocument();
    const text = [
      header.textContent ?? '',
      ...Array.from(header.querySelectorAll('button, a')).flatMap((el) => [el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '']),
    ].join('\n');
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/\s\u2013\s/);
    expect(text).not.toMatch(/playbook/i);
  });

  it('offers the way back to the answer it was opened from, once', async () => {
    window.location.hash = '#/chat?conversationId=conv-1';
    rememberAnswerOrigin();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: 'now-3d' }));
    const back = await screen.findByRole('link', { name: 'Back to answer' });
    expect(back).toHaveAttribute('href', '#/chat?conversationId=conv-1');
    await userEvent.setup().click(back);
    expect(answerOrigin()).toBeNull();
  });

  it('keeps a rule filter on a link longer than 90 days and says it reads the last 90 days', async () => {
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    const end = new Date().toISOString();
    const asked = new Date(Date.parse(end) - 180 * 86_400_000).toISOString();
    show(pageHash('logs', { rule: RULE, from: asked, to: end }));
    expect(await screen.findByRole('button', { name: `Remove filter: Rule is ${RULE}` })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith(
        expect.objectContaining({ rule: RULE, from: new Date(Date.parse(end) - 90 * 86_400_000).toISOString(), to: end }),
      ),
    );
    // Never the unfiltered browser behind a link that asked for one rule.
    expect(fetchUnifiedLogs.mock.calls.every(([params]) => params.rule === RULE)).toBe(true);
    expect(screen.getByTestId('logs-window-narrowed')).toHaveTextContent(
      'Logs reads at most 90 days, so this shows the last 90 days of the linked window',
    );
  });

  it('offers the way back only for the view the answer opened, through its own chip edits', async () => {
    // The router's navigation, for real: a removed chip and a later link change the hash.
    navigate.mockImplementation((page: string, opts?: Record<string, unknown>) => {
      window.location.hash = pageHash(page as 'logs', opts as never);
    });
    window.location.hash = '#/chat?conversationId=conv-1';
    await waitFor(() => expect(window.location.hash).toBe('#/chat?conversationId=conv-1'));
    rememberAnswerOrigin();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    const user = userEvent.setup();
    show(pageHash('logs', { rule: RULE, severity: 'high', from: 'now-3d' }));
    expect(await screen.findByRole('link', { name: 'Back to answer' })).toBeInTheDocument();
    // Removing a chip edits the same view: the way back stays.
    await user.click(screen.getByRole('button', { name: `Remove filter: Rule is ${RULE}` }));
    await waitFor(() => expect(window.location.hash).not.toContain('rule='));
    expect(screen.getByRole('link', { name: 'Back to answer' })).toBeInTheDocument();
    // Another link opened on this page (a rule sheet's "Open all in Logs") is not the
    // answer's drill: it offers no way back.
    window.location.hash = pageHash('logs', { rule: 'web_scan', from: 'now-3d' });
    expect(await screen.findByRole('button', { name: 'Remove filter: Rule is web_scan' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull());
  });

  it('offers no way back on a later link opened from Logs by the router in a click', async () => {
    // The real router: a click commits the route at once and writes the hash, and the
    // page renders the new link before that hash's event arrives.
    const Drill = () => {
      const go = useNavigate();
      return (
        <button
          type="button"
          onClick={() => {
            rememberAnswerOrigin();
            go('logs', { rule: RULE, from: 'now-3d' });
          }}
        >
          Drill
        </button>
      );
    };
    const Later = () => {
      const go = useNavigate();
      return (
        <button type="button" onClick={() => go('logs', { rule: 'web_scan', from: 'now-3d' })}>
          Later link
        </button>
      );
    };
    window.location.hash = '#/chat?conversationId=conv-1';
    await waitFor(() => expect(window.location.hash).toBe('#/chat?conversationId=conv-1'));
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    const user = userEvent.setup();
    render(
      <RouterProvider>
        <Drill />
        <Later />
        <UnifiedLogsPage />
      </RouterProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Drill' }));
    expect(await screen.findByRole('link', { name: 'Back to answer' })).toHaveAttribute('href', '#/chat?conversationId=conv-1');
    // The drill's own hashchange lands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('link', { name: 'Back to answer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Later link' }));
    expect(await screen.findByRole('button', { name: 'Remove filter: Rule is web_scan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
    expect(answerOrigin()).toBeNull();
  });

  it('offers no way back without an answer behind it', async () => {
    clearAnswerOrigin();
    fetchUnifiedLogs.mockResolvedValue(FILTERED);
    show(pageHash('logs', { rule: RULE, from: 'now-3d' }));
    await screen.findByTestId('linked-logs');
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
  });
});
