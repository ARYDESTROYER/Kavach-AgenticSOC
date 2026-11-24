/**
 * Round 15 Team activity (SPEC D3.8, D3.11): the range control's window tokens, the
 * custom range bound, the review wording ("N of M agreed", a rate only when the server
 * sends one) and the CSV, whose text cells are formula-defused (`lib/csv.ts`).
 */
import { describe, expect, it } from 'vitest';

import type { PersonActivity, TeamActivity } from '@/lib/types-team';

import {
  CSV_PARTIAL_NOTE,
  TEAM_MAX_DAYS,
  customRangeDays,
  customRangeError,
  eventClock,
  eventTimeLabel,
  OTHER_KINDS,
  fmtSeconds,
  otherCount,
  peopleCsv,
  peopleCsvRows,
  personName,
  rangeLabel,
  rangeWindow,
  reviewsText,
  windowHasWork,
} from '../team-format';

const zeros = {
  acknowledged: 0, closed: 0, reopened: 0, escalated: 0, commented: 0, assigned: 0,
  screenshot_added: 0, reviewed: 0, runbook_step_done: 0, signed_in: 0,
};

function person(over: Partial<PersonActivity> = {}): PersonActivity {
  return {
    key: 'asha',
    username: 'asha',
    display_name: '',
    role: 'analyst_tier1',
    active: true,
    kind: 'account',
    counts: { ...zeros },
    closed_by: { true_positive: 0, false_positive: 0, benign: 0, duplicate: 0, other: 0 },
    bulk: { acknowledged: 0, closed: 0, reopened: 0, escalated: 0, assigned: 0 },
    daily: [],
    last_active: null,
    median_ack_seconds: null,
    ack_samples: 0,
    reviews: {
      completed: 0, agreed: 0, disagreed: 0, unsure: 0, answered: 0,
      agreement_rate: null, time_spent_median_ms: null, time_to_review_median_seconds: null,
    },
    ...over,
  };
}

function activity(people: PersonActivity[]): TeamActivity {
  return {
    window: { token: 'today', label: 'today', start: '2026-11-20T00:00:00+00:00', end: '2026-11-20T15:00:00+00:00' },
    timezone: 'UTC',
    days: ['2026-11-20'],
    people,
    team: {
      people_active: 0,
      counts: { ...zeros },
      closed_by: { true_positive: 0, false_positive: 0, benign: 0, duplicate: 0, other: 0 },
      bulk: { acknowledged: 0, closed: 0, reopened: 0, escalated: 0, assigned: 0 },
      daily: [],
      median_ack_seconds: null,
      ack_samples: 0,
      ack_status: 'measured',
      reviews: person().reviews,
    },
    exact: true,
    partial_reason: null,
    scanned_rows: 0,
    auth_enabled: true,
    rbac_enabled: true,
    demo: false,
    generated_at: '2026-11-20T15:00:00+00:00',
  };
}

describe('the range control maps to the server window tokens', () => {
  it('maps every preset and a custom range', () => {
    expect(rangeWindow({ kind: 'preset', preset: 'today' })).toBe('today');
    expect(rangeWindow({ kind: 'preset', preset: 'yesterday' })).toBe('yesterday');
    expect(rangeWindow({ kind: 'preset', preset: '7d' })).toBe('now-7d');
    expect(rangeWindow({ kind: 'preset', preset: '30d' })).toBe('now-30d');
    expect(rangeWindow({ kind: 'custom', from: '2026-11-01', to: '2026-11-10' })).toBe('2026-11-01..2026-11-10');
  });

  it('bounds a custom range at 92 whole days, both ends included', () => {
    expect(customRangeDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(customRangeDays('2026-08-01', '2026-10-31')).toBe(TEAM_MAX_DAYS);
    expect(customRangeError('2026-08-01', '2026-10-31')).toBeNull();
    expect(customRangeError('2026-08-01', '2026-11-01')).toBe('Choose at most 92 days.');
    expect(customRangeError('2026-11-10', '2026-11-01')).toBe('The end must be on or after the start.');
    expect(customRangeError('2026-02-30', '2026-03-01')).toBe('Enter a start and an end date.');
    expect(customRangeError('', '2026-03-01')).toBeNull();
  });

  it('labels presets and custom ranges', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(rangeLabel({ kind: 'preset', preset: '7d' }, now)).toBe('Last 7 days');
    expect(rangeLabel({ kind: 'custom', from: '2026-11-01', to: '2026-11-10' }, now)).toBe('1 Nov to 10 Nov');
    expect(rangeLabel({ kind: 'custom', from: '2025-12-30', to: '2025-12-30' }, now)).toBe('30 Dec 2025');
  });
});

describe('the words the page uses', () => {
  it('says N of M agreed, and a rate only when the server sends one', () => {
    // None in the window says so in words (the person sheet); the table shows the count, 0.
    expect(reviewsText(person().reviews)).toBe('None completed in this window');
    const few = { ...person().reviews, completed: 4, agreed: 2, disagreed: 1, unsure: 1, answered: 3 };
    expect(reviewsText(few)).toBe('2 of 3 agreed, 1 unsure');
    const many = { ...few, completed: 30, agreed: 24, disagreed: 6, unsure: 0, answered: 30, agreement_rate: 0.8 };
    expect(reviewsText(many)).toBe('24 of 30 agreed, 80%');
  });

  it('counts "Other" as the chart does: assigned, screenshots added and runbook steps done', () => {
    expect(OTHER_KINDS).toEqual(['assigned', 'screenshot_added', 'runbook_step_done']);
    const busy = person({ counts: { ...zeros, assigned: 1, screenshot_added: 2, runbook_step_done: 3, closed: 9, signed_in: 4 } });
    expect(otherCount(busy)).toBe(6);
    expect(otherCount(person())).toBe(0);
  });

  it('formats durations without inventing a value', () => {
    expect(fmtSeconds(null)).toBeNull();
    expect(fmtSeconds(42)).toBe('42s');
    expect(fmtSeconds(200)).toBe('3m 20s');
    expect(fmtSeconds(7200)).toBe('2h');
  });

  it('names Not attributed and falls back from display name to username', () => {
    expect(personName(person({ display_name: 'Asha Iyer' }))).toBe('Asha Iyer');
    expect(personName(person())).toBe('asha');
    expect(personName(person({ kind: 'unattributed', username: '' }))).toBe('Not attributed');
  });

  it('knows when a window holds case work (sign-ins are not case work)', () => {
    const data = activity([]);
    expect(windowHasWork(data)).toBe(false);
    data.team.counts.signed_in = 3;
    expect(windowHasWork(data)).toBe(false);
    data.team.counts.commented = 1;
    expect(windowHasWork(data)).toBe(true);
  });
});

describe('the people CSV', () => {
  it('defuses a display name that starts like a formula', () => {
    const rows = peopleCsvRows(activity([
      person({ display_name: '=HYPERLINK("http://example.test","x")', counts: { ...zeros, closed: 3 } }),
    ]));
    expect(rows[0][0]).toBe('Person');
    expect(rows[1][0]).toBe('=HYPERLINK("http://example.test","x")');
    const csv = peopleCsv(activity([person({ display_name: '=HYPERLINK("http://example.test","x")' })]));
    const line = csv.split('\r\n')[1];
    expect(line.startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  it('keeps counts numeric and an unmeasured median empty', () => {
    const rows = peopleCsvRows(activity([person({ counts: { ...zeros, acknowledged: 5 }, median_ack_seconds: 90 })]));
    const header = rows[0] as string[];
    expect(rows[1][header.indexOf('Acknowledged')]).toBe(5);
    expect(rows[1][header.indexOf('Median time to acknowledge (minutes)')]).toBe(1.5);
    const none = peopleCsvRows(activity([person()]));
    expect(none[1][header.indexOf('Median time to acknowledge (minutes)')]).toBeNull();
  });

  it('ends a partial read with a note so a saved copy never reads as exact', () => {
    const exact = peopleCsvRows(activity([person({ counts: { ...zeros, closed: 2 } })]));
    expect(exact).toHaveLength(2);
    expect(exact.flat()).not.toContain(CSV_PARTIAL_NOTE);
    const partial = activity([person({ counts: { ...zeros, closed: 2 } })]);
    partial.exact = false;
    partial.partial_reason = 'row_limit';
    const rows = peopleCsvRows(partial);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe('Person');
    expect(rows[2]).toEqual([CSV_PARTIAL_NOTE]);
    expect(CSV_PARTIAL_NOTE).toContain('at least');
    const lines = peopleCsv(partial).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`"${CSV_PARTIAL_NOTE}"`);
  });
});

describe('event times in the operator zone (SPEC D3.7)', () => {
  const at = '2026-11-23T20:00:00+00:00';
  it('formats in the named zone, not the viewer zone', () => {
    expect(eventTimeLabel(at, 'UTC')).toBe('23 Nov, 20:00');
    expect(eventTimeLabel(at, 'Asia/Kolkata')).toBe('24 Nov, 01:30');
    expect(eventClock('Asia/Kolkata').zone).toBe('Asia/Kolkata');
  });

  it('applies a fixed offset by hand and falls back to UTC for an unknown zone', () => {
    expect(eventTimeLabel(at, '+05:30')).toBe('24 Nov, 01:30');
    expect(eventTimeLabel(at, '-0400')).toBe('23 Nov, 16:00');
    expect(eventClock('Not/AZone').zone).toBe('UTC');
    expect(eventTimeLabel(at, 'Not/AZone')).toBe('23 Nov, 20:00');
    expect(eventTimeLabel('not a time', 'UTC')).toBe('not a time');
  });
});
