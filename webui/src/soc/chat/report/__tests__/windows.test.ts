/**
 * Report window lines state each window once (Round 12 SPEC §7.2 decision 29), the
 * mirror of `routes_reports._merge_windows`: the screenshot tour's saved lifetime report
 * read "all time (since 28 Sep 2026); all time; all time (since 12 Oct 2026)".
 */
import { describe, expect, it } from 'vitest';

import { normaliseReport } from '../../chat-api';
import { buildReportDoc } from '../model';
import { mergeScopeWindow, mergeWindows } from '../windows';
import { NOW } from './fixtures';

describe('mergeWindows', () => {
  it('states one all-time window from the earliest data', () => {
    expect(mergeWindows(['all time (since 28 Sep 2026)', 'all time', 'all time (since 12 Oct 2026)'])).toEqual([
      'all time (since 28 Sep 2026)',
    ]);
    expect(mergeWindows(['all time', 'all time (since 3 Nov 2025) (Asia/Kolkata)'])).toEqual([
      'all time (since 3 Nov 2025) (Asia/Kolkata)',
    ]);
  });

  it('states a relative window once, with the start its breakdowns state', () => {
    expect(mergeWindows(['last 90 days', 'last 90 days (since 15 Jul 2026)', 'all time'])).toEqual([
      'last 90 days (since 15 Jul 2026)',
      'all time',
    ]);
    // Two different starts of one window: the shared phrase only, never a guess.
    expect(mergeWindows(['last 90 days (since 15 Jul 2026)', 'last 90 days (since 14 Jul 2026)'])).toEqual([
      'last 90 days',
    ]);
    // An all-time start that is not a date is never compared.
    expect(mergeWindows(['all time (since 28 Sep 2026)', 'all time (since soon)'])).toEqual(['all time']);
  });

  it('keeps comparisons, ranges and other periods as they are', () => {
    const windows = [
      'last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 06:51',
      '3 Sep 2026 09:15 – 11 Oct 2026 17:15 (America/Argentina/Buenos_Aires)',
      'Q3 2026 (Asia/Kolkata)',
    ];
    expect(mergeWindows(windows)).toEqual(windows);
  });

  it('reads a comparison of a stated window inside it, each period once', () => {
    // The saved 90-day report's header and its Overview and Volume scopes.
    expect(
      mergeWindows([
        'last 90 days (since 15 Jul 2026)',
        'last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 08:02',
        'all time',
      ]),
    ).toEqual(['last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 08:02', 'all time']);
    expect(
      mergeScopeWindow('last 90 days (since 15 Jul 2026); last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 08:02'),
    ).toBe('last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 08:02');
    // Saved before every lookup counted whole days: both previous periods, once.
    expect(
      mergeWindows([
        'last 90 days',
        'last 90 days vs previous 90 days',
        'last 90 days (since 15 Jul 2026)',
        'last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 08:02',
      ]),
    ).toEqual(['last 90 days (since 15 Jul 2026), compared with previous 90 days and 16 Apr – 14 Jul 2026 08:02']);
    expect(
      mergeWindows(['Oct 2026 to date', 'Oct 2026 to date vs Sep 2026 to date vs Aug 2026 to date (Asia/Kolkata)']),
    ).toEqual(['Oct 2026 to date, compared with Sep 2026 to date and Aug 2026 to date (Asia/Kolkata)']);
    // Two different starts are two windows: never folded into each other.
    const apart = ['last 90 days (since 14 Jul 2026)', 'last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026'];
    expect(mergeWindows(apart)).toEqual(apart);
    // The report header joins items' scopes: one already folded, one plain, one window.
    expect(
      mergeWindows([
        'last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02',
        'all time',
        'last 90 days (since 15 Jul 2026)',
      ]),
    ).toEqual(['last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02', 'all time']);
    // A zone inside the start or after a period is never split.
    expect(
      mergeWindows([
        'last 90 days (since 15 Jul 2026, Asia/Kolkata)',
        'last 90 days (since 15 Jul 2026, Asia/Kolkata), compared with 16 Apr – 14 Jul 2026 08:02 (Asia/Kolkata)',
      ]),
    ).toEqual(['last 90 days (since 15 Jul 2026, Asia/Kolkata), compared with 16 Apr – 14 Jul 2026 08:02 (Asia/Kolkata)']);
  });

  it('states a saved report\'s header window once across its items', () => {
    const report = normaliseReport({
      id: 'r-90',
      owner: 'admin',
      title: 'SOC performance report, last 90 days',
      template: 'executive',
      version: 1,
      items: [
        {
          id: 'it-1',
          kind: 'section',
          block: { type: 'markdown', id: 'b1', provenance: 'ai', text: 'Overview' },
          source: { conversation_id: 'conv-1', message_id: 'm-1' },
          scope: { window: 'last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02; all time' },
        },
        {
          id: 'it-2',
          kind: 'section',
          block: { type: 'markdown', id: 'b2', provenance: 'ai', text: 'Volume' },
          source: { conversation_id: 'conv-1', message_id: 'm-1' },
          scope: { window: 'last 90 days (since 15 Jul 2026)' },
        },
      ],
    });
    const doc = buildReportDoc(report!, { generatedAt: NOW.toISOString() });
    expect(doc.windows).toEqual(['last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02', 'all time']);
  });

  it('keeps a scope\'s "and N more" count at the end', () => {
    expect(mergeScopeWindow('all time (since 28 Sep 2026); all time; and 2 more')).toBe(
      'all time (since 28 Sep 2026); and 2 more',
    );
    expect(mergeScopeWindow(null)).toBeNull();
  });
});

describe('saved reports', () => {
  it('read a stored scope with each window once, on the item and in the header', () => {
    const report = normaliseReport({
      id: 'r-1',
      owner: 'admin',
      title: 'Lifetime performance report',
      template: 'executive',
      version: 1,
      items: [
        {
          id: 'it-1',
          kind: 'section',
          block: { type: 'markdown', id: 'b1', provenance: 'ai', text: 'Lifetime performance' },
          source: { conversation_id: 'conv-1', message_id: 'm-1' },
          scope: { window: 'all time (since 28 Sep 2026); all time; all time (since 12 Oct 2026)' },
        },
        {
          id: 'it-2',
          kind: 'section',
          block: { type: 'markdown', id: 'b2', provenance: 'ai', text: 'Summary' },
          source: { conversation_id: 'conv-1', message_id: 'm-1' },
          scope: { window: 'all time' },
        },
      ],
    });
    expect(report?.items.map((i) => i.scope.window)).toEqual(['all time (since 28 Sep 2026)', 'all time']);
    const doc = buildReportDoc(report!, { generatedAt: NOW.toISOString() });
    expect(doc.windows).toEqual(['all time (since 28 Sep 2026)']);
  });
});
