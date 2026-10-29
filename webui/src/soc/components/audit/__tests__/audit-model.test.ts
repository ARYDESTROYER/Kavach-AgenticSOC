/**
 * The Audit log's pure model (Round 14 SPEC §4.5): the URL view, the read query, the
 * search qualifiers, times and ranges, the export file name, investigation groups,
 * failure pairing and the plain words for outcomes, fields and user agents.
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_LOCAL_FILTERS,
  OUTCOME_LABEL,
  absoluteRange,
  activeFilterCount,
  buildListItems,
  caseLabelsOf,
  clearedView,
  exportFileName,
  fieldLabel,
  fileStamp,
  formatRowTime,
  groupOutcome,
  groupTitle,
  instantOf,
  investigationEnding,
  isIpAddress,
  isNotApplied,
  isoSecond,
  notAppliedPair,
  optsFromView,
  outcomeKey,
  pageQuery,
  parseSearch,
  parseUserAgent,
  rangeLabel,
  rangePhrase,
  readKey,
  recordCaseText,
  recordSentence,
  storedRecord,
  summaryText,
  targetText,
  viewFromOpts,
  type CaseLabelledRecord,
  type GroupItem,
} from '../audit-model';

import { rec } from './audit-fixtures';

const NOW = Date.UTC(2026, 9, 25, 15, 10, 30);

describe('the URL view', () => {
  it('defaults to People and settings over the last 7 days', () => {
    const view = viewFromOpts(undefined);
    expect(view.scope).toBe('people');
    expect(view.from).toBe('now-7d');
    expect(view.to).toBeNull();
    expect(activeFilterCount(view, EMPTY_LOCAL_FILTERS)).toBe(0);
  });

  it('round-trips every key and omits empty ones', () => {
    const opts = { scope: 'all', from: 'now-30d', q: 'login', event: 'auth.login', actor_contains: 'tra', outcome: 'denied', case: 'case-1', ip: '10.0.0.1', target: 'u1' };
    const view = viewFromOpts(opts as never);
    expect(view).toMatchObject({ scope: 'all', from: 'now-30d', q: 'login', event: 'auth.login', actorContains: 'tra', outcome: 'denied', caseId: 'case-1', ip: '10.0.0.1', target: 'u1', actor: null });
    expect(optsFromView(view)).toEqual(opts);
    expect(optsFromView(view, 'mem:3')).toEqual({ ...opts, record: 'mem:3' });
    const bare = optsFromView(viewFromOpts(undefined));
    expect(bare).toEqual({ scope: 'people', from: 'now-7d' });
    expect(Object.values(bare)).not.toContain('');
  });

  it('ignores a value the page does not know', () => {
    expect(viewFromOpts({ scope: 'everyone', outcome: 'odd' } as never)).toMatchObject({ scope: 'people', outcome: null });
  });

  it('clears what a person added and keeps scope and time', () => {
    const view = viewFromOpts({ scope: 'agent', from: 'now-1h', q: 'x', event: 'agent' } as never);
    expect(clearedView(view)).toMatchObject({ scope: 'agent', from: 'now-1h', q: null, event: null });
  });

  it('builds the 50-row read with the structured filters and the in-memory ones', () => {
    const view = viewFromOpts({ scope: 'people', from: 'now-7d', event: 'access', case: 'c-1', q: 'role' } as never);
    const query = pageQuery(view, { actorKind: 'human', surface: 'settings', sourceId: 'wazuh' }, 'desc', 'cur1');
    expect(query).toEqual({
      scope: 'people',
      from: 'now-7d',
      order: 'desc',
      limit: 50,
      q: 'role',
      event: 'access',
      case_id: 'c-1',
      actor_kind: 'human',
      surface: 'settings',
      source_id: 'wazuh',
      cursor: 'cur1',
    });
    expect(readKey(view, EMPTY_LOCAL_FILTERS, 'desc')).not.toBe(readKey(view, EMPTY_LOCAL_FILTERS, 'asc'));
  });
});

describe('the search box', () => {
  it('compiles qualifiers into structured filters and keeps the rest as text', () => {
    expect(parseSearch('actor:trao outcome:failed role change')).toEqual({
      q: 'role change',
      patch: { actorContains: 'trao', outcome: 'failure' },
    });
    expect(parseSearch('event:auth.login_failed ip:203.0.113.24 case:case-9 target:u1')).toEqual({
      q: null,
      patch: { event: 'auth.login_failed', ip: '203.0.113.24', caseId: 'case-9', target: 'u1' },
    });
    expect(parseSearch('actor:"jo smith" outcome:"not recorded"').patch).toEqual({ actorContains: 'jo smith', outcome: 'unknown' });
  });

  it('leaves an invalid qualifier in the text, as typed', () => {
    expect(parseSearch('event:Not-An-Event ip:nope')).toEqual({ q: 'event:Not-An-Event ip:nope', patch: {} });
  });

  it('applies ip: only to one IPv4 or IPv6 address, as the router and the read API do', () => {
    expect(parseSearch('ip:10.0.0')).toEqual({ q: 'ip:10.0.0', patch: {} });
    expect(parseSearch('ip:::: ip:10.0.0.256')).toEqual({ q: 'ip:::: ip:10.0.0.256', patch: {} });
    expect(parseSearch('ip:203.0.113.24').patch).toEqual({ ip: '203.0.113.24' });
    expect(parseSearch('ip:2001:db8::1').patch).toEqual({ ip: '2001:db8::1' });
    for (const ok of ['10.0.0.1', '255.255.255.255', '::1', '2001:db8::1', 'fe80::1:2']) expect(isIpAddress(ok)).toBe(true);
    for (const bad of ['10.0.0', '10.0.0.256', '1.2.3.4.', ':::', 'nope', '01.2.3.4x', '']) expect(isIpAddress(bad)).toBe(false);
  });

  it('caps the text at 200 characters and refuses control characters', () => {
    expect(parseSearch('a'.repeat(300)).q).toHaveLength(200);
    expect(parseSearch('bad\u0007text').q).toBeNull();
  });
});

describe('times, ranges and the export file name', () => {
  it('formats a row time in UTC or local time, with the year only when it differs', () => {
    expect(formatRowTime('2026-10-25T15:09:15Z', 'utc', NOW)).toBe('25 Oct 15:09:15');
    expect(formatRowTime('2025-01-05T03:04:05Z', 'utc', NOW)).toBe('5 Jan 2025 03:04:05');
    expect(formatRowTime('not a time', 'utc', NOW)).toBe('not a time');
  });

  it('resolves a relative range to absolute instants, to the second', () => {
    const range = absoluteRange({ from: 'now-7d', to: null }, NOW)!;
    // A range that ends now ends at the last whole second that has passed: the server
    // reads `to` as its whole second, so the result is exactly 7 days.
    expect(range.to).toBe('2026-10-25T15:10:29Z');
    expect(range.from).toBe('2026-10-18T15:10:30Z');
    expect(range.toMs + 1000 - range.fromMs).toBe(7 * 24 * 3600 * 1000);
    // Part way through a second, the second in progress is never covered.
    expect(absoluteRange({ from: 'now-1h', to: null }, Date.UTC(2026, 9, 25, 15, 10, 0, 400))!.to).toBe('2026-10-25T15:09:59Z');
    // A bound that is not now is kept as given, to the second.
    expect(absoluteRange({ from: 'now-7d', to: 'now-1h' }, NOW)!.to).toBe('2026-10-25T14:10:30Z');
    expect(absoluteRange({ from: '2026-10-18T15:10:00Z', to: '2026-10-25T15:10:00Z' }, NOW)!.to).toBe('2026-10-25T15:10:00Z');
    expect(absoluteRange({ from: 'now', to: 'now-1h' }, NOW)).toBeNull();
    expect(isoSecond(Date.UTC(2026, 9, 25, 15, 10, 0, 999))).toBe('2026-10-25T15:10:00Z');
  });

  it('names the file as the server does', () => {
    const range = { fromMs: Date.UTC(2026, 9, 18, 15, 10), toMs: Date.UTC(2026, 9, 25, 15, 10) };
    expect(fileStamp(range.fromMs)).toBe('2026-10-18T151000Z');
    expect(exportFileName('csv', range)).toBe('agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv');
    expect(exportFileName('jsonl', range)).toBe('agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.ndjson');
  });

  it('says the range in words', () => {
    expect(rangePhrase({ from: 'now-7d', to: null }, NOW)).toBe('last 7 days');
    expect(rangeLabel({ from: 'now-90d', to: null }, NOW)).toBe('Last 90 days');
    expect(rangePhrase({ from: '2026-10-18T15:10:00Z', to: '2026-10-25T15:10:00Z' }, NOW)).toBe('18 Oct 15:10 to 25 Oct 15:10 UTC');
  });
});

describe('record words', () => {
  it('reads a recorded unknown and a missing outcome as Not recorded', () => {
    expect(OUTCOME_LABEL[outcomeKey(rec({ outcome: 'unknown' }))]).toBe('Not recorded');
    expect(OUTCOME_LABEL[outcomeKey(rec())]).toBe('Not recorded');
    expect(OUTCOME_LABEL[outcomeKey(rec({ outcome: 'failure' }))]).toBe('Failed');
  });

  it('names a field in words with the key kept separately', () => {
    expect(fieldLabel('chat_agent.limits.max_parallel')).toBe('Max parallel');
    expect(fieldLabel('sources[wazuh].poll_interval')).toBe('Poll interval');
    expect(fieldLabel('role')).toBe('Role');
  });

  it('parses common user agents and keeps unknown ones raw', () => {
    expect(
      parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'),
    ).toBe('Chrome 141 on macOS');
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox 131 on Windows');
    expect(parseUserAgent('curl/8.5.0')).toBe('curl 8.5.0');
    expect(parseUserAgent('something-else')).toBeNull();
  });

  it('writes the role change sentence and otherwise shows the stored summary verbatim', () => {
    const role = rec({
      action: 'user.role_changed',
      actor: 'trao',
      target: { type: 'user', id: 'vpatel', label: 'vpatel' },
      changes: [{ field: 'role', before: 'analyst_tier1', after: 'analyst_tier2', secret: false }],
    });
    expect(recordSentence(role)).toBe('trao changed the role of vpatel from analyst_tier1 to analyst_tier2.');
    expect(recordSentence(rec({ result_summary: "updated user 'x'" }))).toBe("updated user 'x'");
    expect(recordSentence(rec({ target: { type: 'case', id: 'c-1', label: 'CASE-000001' } }))).toBe('User changed: CASE-000001.');
  });

  it('shows the target name, else the case, else the source', () => {
    expect(targetText(rec({ target: { type: 'user', id: 'u', label: 'User u' } }))).toBe('User u');
    expect(targetText(rec({ case_id: 'case-1' }))).toBe('case-1');
    expect(targetText(rec({ source_id: 'wazuh' }))).toBe('Source wazuh');
    expect(targetText(rec())).toBeNull();
    expect(summaryText(rec({ result_summary: '  a\n b ' }))).toBe('a b');
  });
});

describe('case numbers (SPEC §4.5.1, §4.9.5)', () => {
  /** A row as the read API sends it once it resolves the case number (`case_label`). */
  const labelled = (over: Partial<CaseLabelledRecord>): CaseLabelledRecord => ({ ...rec(), ...over });
  const internal = 'case-61a0e4f407bf4bf5aa300c98f03c5bf4';

  it('names a case by its number, else by a case target naming it, else by its internal id', () => {
    expect(recordCaseText(labelled({ case_id: internal, case_label: 'CASE-000214' }))).toBe('CASE-000214');
    expect(recordCaseText(labelled({ case_id: internal, target: { type: 'case', id: internal, label: 'CASE-000214' } }))).toBe(
      'CASE-000214',
    );
    // A target that is another case (or not a case) never names this one.
    expect(recordCaseText(labelled({ case_id: internal, target: { type: 'case', id: 'case-other', label: 'CASE-000001' } }))).toBe(
      internal,
    );
    // A case that no longer exists (null) or a read that sends no number: the internal id.
    expect(recordCaseText(labelled({ case_id: internal, case_label: null }))).toBe(internal);
    expect(recordCaseText(labelled({ case_id: internal, case_label: '  ' }))).toBe(internal);
    expect(recordCaseText(rec({ case_id: internal }))).toBe(internal);
    expect(recordCaseText(rec())).toBeNull();
  });

  it('shows the case number in the Target column', () => {
    expect(targetText(labelled({ case_id: internal, case_label: 'CASE-000214' }))).toBe('CASE-000214');
    // A recorded target still comes first.
    expect(targetText(labelled({ case_id: internal, case_label: 'CASE-000214', target: { type: 'user', id: 'u', label: 'User u' } }))).toBe(
      'User u',
    );
  });

  it('titles an investigation by its case number when any step carries it', () => {
    const steps = [
      labelled({ record_id: 'mem:3', run_id: 'inv-9', case_id: internal, action_type: 'decision' }),
      labelled({ record_id: 'mem:2', run_id: 'inv-9', case_id: internal, case_label: 'CASE-000214', action_type: 'tool_call' }),
    ];
    const group = buildListItems(steps, 'agent', {}, new Set())[0] as GroupItem;
    expect(group.caseId).toBe(internal);
    expect(group.caseLabel).toBe('CASE-000214');
    expect(groupTitle(group).title).toBe('Investigation of CASE-000214');
  });

  it('collects the case numbers the loaded rows resolve, for the Case chip', () => {
    const labels = caseLabelsOf([
      labelled({ case_id: internal, case_label: 'CASE-000214' }),
      labelled({ case_id: internal }),
      labelled({ case_id: 'case-unresolved' }),
      rec(),
    ]);
    expect([...labels.entries()]).toEqual([[internal, 'CASE-000214']]);
  });
});

describe('investigation groups (Agent activity)', () => {
  const steps = [
    rec({ record_id: 'mem:5', run_id: 'inv-1', case_id: 'case-214', action_type: 'decision', result_summary: 'verdict=FALSE_POSITIVE status=closed', outcome: 'success' }),
    rec({ record_id: 'mem:4', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', outcome: 'success' }),
    rec({ record_id: 'mem:3', action_type: 'poll' }),
    rec({ record_id: 'mem:2', run_id: 'inv-1', case_id: 'case-214', action_type: 'prompt', outcome: 'success' }),
  ];

  it('folds one run into one row where its newest row is, and never groups rows without a run', () => {
    const items = buildListItems(steps, 'agent', { 'inv-1': 10 }, new Set());
    expect(items.map((i) => i.kind)).toEqual(['group', 'row']);
    const group = items[0] as GroupItem;
    expect(group.records.map((r) => r.record_id)).toEqual(['mem:5', 'mem:4', 'mem:2']);
    expect(group.total).toBe(10);
    expect(groupTitle(group)).toEqual({ title: 'Investigation of case-214', detail: '3 of 10 steps shown · closed as false positive' });
  });

  it('lists the steps under an open group, and every row in the other scopes', () => {
    const open = buildListItems(steps, 'agent', {}, new Set(['inv-1']));
    expect(open.map((i) => (i.kind === 'row' ? `${i.record.record_id}${i.child ? '*' : ''}` : 'group'))).toEqual([
      'group',
      'mem:5*',
      'mem:4*',
      'mem:2*',
      'mem:3',
    ]);
    expect(buildListItems(steps, 'all', {}, new Set()).every((i) => i.kind === 'row')).toBe(true);
    expect(groupTitle(open[0] as GroupItem).detail).toBe('3 steps · closed as false positive');
  });

  it('says how an investigation ended, and one outcome for the group', () => {
    expect(investigationEnding([rec({ action_type: 'decision', result_summary: 'verdict=NEEDS_HUMAN status=open' })])).toBe('sent to a person');
    expect(investigationEnding([rec({ action_type: 'prompt' })])).toBeNull();
    expect(groupOutcome([rec({ outcome: 'success' }), rec({ outcome: 'failure' })])).toBe('failure');
    expect(groupOutcome([rec({ outcome: 'success' })])).toBe('success');
    expect(groupOutcome([rec()])).toBeUndefined();
  });
});

describe('failure pairing (SPEC §3.6)', () => {
  const action = rec({
    record_id: 'mem:1',
    ts: '2026-10-25T15:00:00Z',
    action: 'settings.updated',
    outcome: 'success',
    request_id: 'req-12345678',
    target: { type: 'setting', id: 'chat', label: 'Chat' },
  });
  const failure = rec({
    record_id: 'mem:2',
    ts: '2026-10-25T15:00:01Z',
    action: 'settings.update_failed',
    outcome: 'failure',
    request_id: 'req-12345678',
    target: { type: 'setting', id: 'chat', label: 'Chat' },
  });
  const retry = rec({ ...action, record_id: 'mem:3', ts: '2026-10-25T15:00:02Z', tool_input: { attempt: 2, of: 3 } });

  it('marks an action row whose next row of the same request is its failure row', () => {
    expect(isNotApplied(action, [action, failure, retry])).toBe(true);
  });

  it('never marks the applied retry, a lone row, another actor or another target', () => {
    expect(isNotApplied(retry, [action, failure, retry])).toBe(false);
    expect(isNotApplied(action, [action])).toBe(false);
    expect(isNotApplied(action, [action, { ...failure, actor: 'mallory' }])).toBe(false);
    expect(isNotApplied(action, [action, { ...failure, target: { type: 'setting', id: 'other', label: 'Other' } }])).toBe(false);
  });

  it('names the failure row, so the inspector can open it', () => {
    expect(notAppliedPair(action, [retry, failure, action])?.record_id).toBe('mem:2');
    expect(notAppliedPair(retry, [retry, failure, action])).toBeNull();
  });

  it('orders rows of one millisecond by their microseconds', () => {
    // action, failure, applied retry, all inside 15:00:00.000 (stored with microseconds).
    const a = { ...action, ts: '2026-10-25T15:00:00.000100+00:00' };
    const f = { ...failure, ts: '2026-10-25T15:00:00.000400+00:00' };
    const r = { ...retry, ts: '2026-10-25T15:00:00.000700+00:00' };
    expect(instantOf(a.ts)).toBe(Date.parse('2026-10-25T15:00:00Z') * 1000 + 100);
    expect(notAppliedPair(a, [r, f, a])?.record_id).toBe('mem:2');
    // The applied retry came after the failure: it never pairs with it.
    expect(notAppliedPair(r, [r, f, a])).toBeNull();
  });

  it('breaks an exact tie by the order the list placed the rows in', () => {
    const at = '2026-10-25T15:00:00.000100Z';
    const a = { ...action, ts: at };
    const f = { ...failure, ts: at };
    // Newest first: the failure was written later, so the list shows it above.
    expect(notAppliedPair(a, [f, a], 'desc')?.record_id).toBe('mem:2');
    expect(notAppliedPair(a, [a, f], 'desc')).toBeNull();
    // Oldest first: below.
    expect(notAppliedPair(a, [a, f], 'asc')?.record_id).toBe('mem:2');
  });

  it('requires the same session when both rows name one', () => {
    const a = { ...action, session_ref: 'aaaaaaaaaaaaaaaa' };
    expect(notAppliedPair(a, [a, { ...failure, session_ref: 'bbbbbbbbbbbbbbbb' }])).toBeNull();
    expect(notAppliedPair(a, [a, { ...failure, session_ref: 'aaaaaaaaaaaaaaaa' }])?.record_id).toBe('mem:2');
    expect(notAppliedPair(a, [a, failure])?.record_id).toBe('mem:2');
  });
});

describe('the stored row (Raw record, AU-7)', () => {
  it('leaves out the read-time projections and a derived outcome or actor kind', () => {
    const legacy = rec({ outcome: 'denied', outcome_derived: true, actor_type: 'human', actor_type_derived: true, demo: true, truncated_fields: ['result_summary'] });
    const stored = storedRecord(legacy);
    for (const key of ['record_id', 'category', 'event_label', 'demo', 'truncated_fields', 'outcome_derived', 'actor_type_derived', 'outcome', 'actor_type']) {
      expect(stored).not.toHaveProperty(key);
    }
    expect(stored).toMatchObject({ actor: 'trao', action_type: 'user_mgmt', surface: 'settings', build_sha: 'abcdef1234567890' });
  });

  it('leaves out the case number the read API resolves, which the store never held', () => {
    const row: CaseLabelledRecord = { ...rec({ case_id: 'case-1' }), case_label: 'CASE-000001' };
    const stored = storedRecord(row);
    expect(stored).not.toHaveProperty('case_label');
    expect(stored).toMatchObject({ case_id: 'case-1' });
  });

  it('keeps a recorded outcome and actor kind as stored', () => {
    expect(storedRecord(rec({ outcome: 'success', actor_type: 'agent' }))).toMatchObject({ outcome: 'success', actor_type: 'agent' });
  });
});
